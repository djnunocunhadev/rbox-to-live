/* Standalone bridge to the local Rekordbox database with built-in HTTP server for M4L UI.
   node.script runs CommonJS in Max for Live, so avoid ESM imports here. */
const maxApi = require('max-api');
const { spawn, spawnSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { timingSafeEqual, randomBytes } = require('crypto');
const { parse: parseUrl } = require('url');

// RBOX_READER, RBOX_PORT, RBOX_PYTHON and RBOX_SUPPORT_DIR exist for the tests; a normal install uses none of them.
const dbReader = process.env.RBOX_READER || path.join(__dirname, 'rbox-to-live-db.py');
const requirementsFile = path.join(__dirname, 'requirements.txt');

const PAGE_SIZE = 100;
const HTTP_PORT = Number(process.env.RBOX_PORT) || 37373;

// Settings, the private Python environment and the bridge's own details live outside the device folder, so a new
// version of the device can replace the folder without losing them. RBOX_SUPPORT_DIR is for tests.
const SUPPORT_DIR = process.env.RBOX_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'RBox to Live');
const SETTINGS_PATH = path.join(SUPPORT_DIR, 'settings.json');
const INSTANCE_PATH = path.join(SUPPORT_DIR, 'instance.json');
const VENV_DIR = path.join(SUPPORT_DIR, 'venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python3');

// Only requests naming this machine's loopback address are served. That blocks DNS rebinding,
// where a web page points its own name at 127.0.0.1 to reach this server as same-origin.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${HTTP_PORT}`, `localhost:${HTTP_PORT}`]);
// The device page first loads from a file, where Max's web view sends Origin: file:// (some engines send null),
// and then moves to the bridge's own address, which is where it gets its token.
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${HTTP_PORT}`, `http://localhost:${HTTP_PORT}`, 'file://', 'null']);

// A fresh random token for every run of the bridge. The page is served with it filled in, and the API refuses
// requests without it, so another web page or program cannot drive the bridge.
const apiToken = randomBytes(32).toString('base64url');

function ensureSupportDir() {
  try { mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function writePrivateFile(file, text) {
  ensureSupportDir();
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch (_) {}
  renameSync(temporary, file);
}

// Settings: the Rekordbox database file (empty means find it) and the database key the user typed in the device. The key
// is never provided or derived by this project; with none saved the reader reports key-missing.
function loadSettings() {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      dbPath: typeof data.dbPath === 'string' ? data.dbPath : '',
      key: typeof data.key === 'string' ? data.key : '',
    };
  } catch (_) {
    return { dbPath: '', key: '' };
  }
}
let settings = loadSettings();

function saveSettings() {
  writePrivateFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// The Python that runs the reader: the private environment the device sets up when there is one, then a Python named
// in the environment (for tests), then the system Pythons.
function findPython() {
  const candidates = [VENV_PYTHON, process.env.RBOX_PYTHON, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || 'python3';
}

// The Python used to create the private environment. It needs the venv module, so each candidate is tried.
function findBasePython() {
  const candidates = [process.env.RBOX_PYTHON, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import venv, ensurepip'], { timeout: 20000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

let reader = null;
let ready = false;
let requestNo = 0;
let detectedDbPath = '';
const pending = [];
const requests = new Map();

let currentStatus = { online: false, tracks: 0, readOnly: true, error: null, errorCode: null };
let importState = { inProgress: false, ok: false, message: '' };

const emit = (event, value) => {
  try { maxApi.outlet(event, JSON.stringify(value)); } catch (_) {}
};

const reportOffline = (message, code) => {
  currentStatus = {
    online: false, tracks: 0, readOnly: true,
    error: String(message || 'Could not open the Rekordbox library.'),
    errorCode: code || 'other',
  };
  emit('status', currentStatus);
};

function send(payload, callback) {
  if (callback) requests.set(payload.requestId, callback);
  if (!reader) startReader();
  pending.push(payload);
  flush();
}

function flush() {
  if (!ready || !reader?.stdin?.writable) return;
  while (pending.length) reader.stdin.write(`${JSON.stringify(pending.shift())}\n`);
}

function startReader() {
  if (reader) return;
  const python = findPython();
  try {
    maxApi.post(`RBox to Live starting reader with ${python}`);
    reader = spawn(python, [dbReader], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    reader = null;
    reportOffline(error.message, 'other');
    return;
  }
  // The reader takes its configuration from the first line it is sent. The key is never logged.
  try {
    reader.stdin.write(`${JSON.stringify({ action: 'configure', dbPath: settings.dbPath, key: settings.key })}\n`);
  } catch (_) {}

  const lines = readline.createInterface({ input: reader.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      reportOffline('The direct Rekordbox reader returned an invalid response.', 'other');
      return;
    }

    if (message.event === 'ready') {
      const tracks = Number(message.tracks) || 0;
      maxApi.post(`RBox to Live reader ready: ${tracks} tracks`);
      ready = true;
      detectedDbPath = String(message.dbPath || '');
      currentStatus = { online: true, tracks, readOnly: true, error: null, errorCode: null };
      emit('status', currentStatus);
      flush();
      return;
    }
    if (message.event === 'fatal') {
      ready = false;
      reportOffline(message.message, message.code);
      return;
    }
    if (message.event === 'error') {
      const callback = requests.get(message.requestId);
      requests.delete(message.requestId);
      if (callback) callback(message);
      else emit('error', { message: message.message });
      return;
    }
    if (message.event !== 'response') return;

    const callback = requests.get(message.requestId);
    requests.delete(message.requestId);
    if (callback) { callback(null, message.data); return; }
    if (message.action === 'search') emit('tracks', message.data);
    else if (message.action === 'playlists') emit('playlists', message.data);
    else if (message.action === 'playlist') emit('tracks', { ...message.data, total: message.data.total });
  });

  reader.stderr.on('data', (data) => {
    const detail = String(data || '').trim();
    if (detail) maxApi.post(`RBox to Live reader: ${detail}`);
  });
  reader.on('error', (error) => {
    ready = false;
    reader = null;
    reportOffline(error.message, 'other');
  });
  reader.on('exit', (code) => {
    ready = false;
    reader = null;
    if (code && code !== 0) reportOffline(`The direct Rekordbox reader stopped (code ${code}).`, 'other');
  });
}

// Stop the reader and start it again, so new settings or newly installed components take effect.
function restartReader() {
  const old = reader;
  reader = null;
  ready = false;
  pending.length = 0;
  for (const [id, callback] of requests) callback({ message: 'The Rekordbox reader was restarted.' });
  requests.clear();
  detectedDbPath = '';
  currentStatus = { online: false, tracks: 0, readOnly: true, error: null, errorCode: null };
  try { old?.stdin?.end(); } catch (_) {}
  try { old?.kill('SIGTERM'); } catch (_) {}
  startReader();
}

// Components: the private Python environment holding the SQLCipher driver (requirements.txt, pinned by hash).
let setupState = { state: 'idle', message: '', lines: [] };

function setupLog(line) {
  const text = String(line || '').trim();
  if (!text) return;
  setupState.lines.push(text.slice(0, 300));
  if (setupState.lines.length > 60) setupState.lines.shift();
  setupState.message = text.slice(0, 200);
}

function runStep(command, args, label) {
  return new Promise((resolve, reject) => {
    setupLog(label);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (stream) => readline.createInterface({ input: stream }).on('line', setupLog);
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (code ${code})`))));
  });
}

async function installComponents() {
  if (setupState.state === 'running') return;
  setupState = { state: 'running', message: 'Looking for Python 3…', lines: [] };
  try {
    const base = findBasePython();
    if (!base) {
      throw new Error('Python 3 was not found. Install the Xcode command line tools (run xcode-select --install in Terminal) or Python from python.org, then try again.');
    }
    ensureSupportDir();
    if (!existsSync(VENV_PYTHON)) await runStep(base, ['-m', 'venv', VENV_DIR], 'Creating the private Python environment');
    await runStep(VENV_PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', requirementsFile], 'Installing the SQLCipher database driver');
    setupState.state = 'done';
    setupLog('Components installed.');
    restartReader();
  } catch (error) {
    setupState.state = 'error';
    setupState.message = String(error.message || error).slice(0, 300);
    setupLog(setupState.message);
  }
}

// What the settings panel shows. The key itself is never sent back, only whether one is saved.
function settingsView() {
  return {
    dbPath: settings.dbPath,
    detectedDbPath,
    hasKey: Boolean(settings.key),
    components: { privateEnvironment: existsSync(VENV_PYTHON), python: findPython() },
    setup: { state: setupState.state, message: setupState.message },
  };
}

function requestAsync(action, fields = {}) {
  return new Promise((resolve, reject) => {
    send({ action, ...fields, requestId: ++requestNo }, (error, data) => {
      if (error) reject(new Error(error.message || 'Database request failed'));
      else resolve(data);
    });
  });
}

// Beats in the grid sent with the most recent import (0 when the grid was not read).
let lastBeatGrid = 0;

function triggerImport(id, options = {}) {
  importState = { inProgress: true, ok: false, message: 'Reading track and cues…', newTrackId: 0 };
  emit('progress', { message: importState.message });

  // The beat grid comes from the track's analysis file. If the first read comes back empty, read once more before
  // the import falls back to the two-anchor warp, and say so in the console.
  const readDetail = () => requestAsync('detail', { id: Number(id), split: options.split || 'cues' })
    .then(async (detail) => {
      if (!detail.streaming && detail.fileAvailable && !(detail.beatTimesMs || []).length) {
        maxApi.post(`RBox to Live: no beat grid on the first read of track ${id}; reading it again`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const again = await requestAsync('detail', { id: Number(id), split: options.split || 'cues' });
        if ((again.beatTimesMs || []).length) return again;
        maxApi.post(`RBox to Live: still no beat grid for track ${id}; the import will use the two-anchor warp`);
      }
      return detail;
    })
    .then((detail) => {
      if (detail.streaming) {
        throw new Error('This is a streaming track, so there is no local audio file to import.');
      }
      if (!detail.fileAvailable || !detail.filePath) {
        throw new Error('The original audio file is unavailable. Connect its music drive in Finder and try again.');
      }
      const lengthMs = Math.max(1, Math.round(Number(detail.lengthSec || 0) * 1000));
      const firstBeatMs = Number(detail.firstBeatMs) || 0.0;
      const cues = (Array.isArray(detail.cues) ? detail.cues : [])
        .filter((cue) => Number.isFinite(Number(cue.ms)) && Number(cue.ms) >= 0 && Number(cue.ms) < lengthMs)
        .sort((a, b) => Number(a.ms) - Number(b.ms));

      const sections = (Array.isArray(detail.sections) && detail.sections.length > 0)
        ? detail.sections
        : (() => {
            const boundaries = [0, ...cues.map((cue) => Number(cue.ms)), lengthMs];
            return boundaries.slice(0, -1).map((startMs, index) => ({
              startMs,
              endMs: boundaries[index + 1],
              startBeat: (startMs - firstBeatMs) * (Number(detail.bpm) || 120.0) / 60000.0,
              endBeat: (boundaries[index + 1] - firstBeatMs) * (Number(detail.bpm) || 120.0) / 60000.0,
              name: index === 0 ? (cues.length ? 'Start' : detail.title) : (cues[index - 1].comment || cues[index - 1].letter || `Cue ${index}`),
              letter: index === 0 ? 'Start' : (cues[index - 1].letter || `Cue ${index}`),
            }));
          })();

      const splitNote = detail.sectionSource === 'structure' ? ' (song structure)' : (options.split === 'structure' ? ' (no song structure for this track; using cues)' : '');
      importState = { inProgress: true, ok: false, message: 'Creating clips in Ableton Live…' + splitNote, newTrackId: 0 };
      emit('progress', { message: importState.message });

      const importData = {
        id: detail.id,
        title: detail.title,
        artist: detail.artist,
        bpm: detail.bpm,
        firstBeatMs,
        key: detail.key,
        file: detail.filePath,
        lengthMs,
        cues,
        sections,
        targetTrack: options.targetTrack || 'new',
        targetView: options.targetView || 'both',
        sectionSource: detail.sectionSource || 'cues',
        beatMs: Array.isArray(detail.beatTimesMs) ? detail.beatTimesMs : [],
        vocalRegions: options.vocals === false ? [] : (Array.isArray(detail.vocalRegions) ? detail.vocalRegions : []),
        syncTempo: options.syncTempo !== false,
      };

      lastBeatGrid = importData.beatMs.length;
      maxApi.post(`RBox to Live beat grid from the reader: ${importData.beatMs.length} beats`);
      maxApi.post(`RBox to Live triggering liveimport for: ${detail.artist} — ${detail.title} (firstBeatMs: ${firstBeatMs}, cues: ${cues.length}, sections: ${sections.length}, target: ${importData.targetTrack}, view: ${importData.targetView})`);
      maxApi.outlet('liveimport', encodeURIComponent(JSON.stringify(importData)));
    })
    .catch((err) => {
      importState = { inProgress: false, ok: false, message: err.message, newTrackId: 0 };
      emit('error', { message: err.message });
    });

  readDetail();
}

// ---------------------------------------------------------------------------
// HTTP Server for M4L browser UI
// ---------------------------------------------------------------------------
// Reflect only the allowed origins. Other origins get no CORS headers, so the browser hides their responses.
function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RBox-Token');
  }
}

function tokenMatches(req) {
  const given = Buffer.from(String(req.headers['x-rbox-token'] || ''));
  const expected = Buffer.from(apiToken);
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

// Read a small JSON body. Answers 400 itself when it is not JSON, and 413 when it is far too large.
function readBody(req, res, handler) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 20000) { sendError(res, 413, 'Request too large'); req.destroy(); }
  });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { sendError(res, 400, 'Invalid JSON body'); return; }
    if (!payload || typeof payload !== 'object') { sendError(res, 400, 'Invalid JSON body'); return; }
    handler(payload);
  });
}

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) { sendError(res, 403, 'Forbidden host'); return; }
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) { sendError(res, 403, 'Forbidden origin'); return; }

  const parsed = parseUrl(req.url, true);
  const pathname = parsed.pathname;

  // The page carries the token, so it is served without CORS headers. A script on another origin cannot read it.
  if ((pathname === '/' || pathname === '/index.html' || pathname === '/rbox-to-live.html') && req.method === 'GET') {
    const htmlPath = path.join(__dirname, 'rbox-to-live.html');
    if (existsSync(htmlPath)) {
      const page = readFileSync(htmlPath, 'utf-8').split('__RBOX_TOKEN__').join(apiToken);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
  }

  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!tokenMatches(req)) { sendError(res, 401, 'Missing or wrong device token.'); return; }

  if (pathname === '/status' && req.method === 'GET') {
    sendJson(res, 200, currentStatus);
    return;
  }

  if (pathname === '/connect' && req.method === 'POST') {
    if (!reader) startReader();
    sendJson(res, 200, currentStatus);
    return;
  }

  if (pathname === '/search' && req.method === 'GET') {
    const query = String(parsed.query.q || '');
    const offset = Math.max(0, Math.floor(Number(parsed.query.offset) || 0));
    requestAsync('search', { query, limit: PAGE_SIZE, offset })
      .then((data) => sendJson(res, 200, { ...data, append: offset > 0 }))
      .catch((err) => sendError(res, 500, err.message));
    return;
  }

  if (pathname === '/playlists' && req.method === 'GET') {
    requestAsync('playlists')
      .then((data) => sendJson(res, 200, data))
      .catch((err) => sendError(res, 500, err.message));
    return;
  }

  if (pathname === '/playlist' && req.method === 'GET') {
    const id = Number(parsed.query.id);
    if (!id) { sendError(res, 400, 'Missing playlist id'); return; }
    requestAsync('playlist', { id })
      .then((data) => sendJson(res, 200, data))
      .catch((err) => sendError(res, 500, err.message));
    return;
  }

  if (pathname === '/import' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = Number(payload.id);
        if (!id) { sendError(res, 400, 'Missing track id'); return; }
        triggerImport(id, payload);
        sendJson(res, 200, { ok: true, message: 'Import started' });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON body');
      }
    });
    return;
  }

  if (pathname === '/select-track' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = Number(payload.id);
        if (id) {
          maxApi.post(`RBox to Live select_track: ${id}`);
          maxApi.outlet('select_track', id);
          sendJson(res, 200, { ok: true });
        } else {
          sendError(res, 400, 'Missing track id');
        }
      } catch {
        sendError(res, 400, 'Invalid JSON body');
      }
    });
    return;
  }

  if (pathname === '/settings' && req.method === 'GET') {
    sendJson(res, 200, settingsView());
    return;
  }

  if (pathname === '/settings' && req.method === 'POST') {
    readBody(req, res, (payload) => {
      const dbPath = payload.dbPath === undefined ? settings.dbPath : String(payload.dbPath).trim();
      let key = settings.key;
      if (payload.clearKey === true) key = '';
      else if (payload.key !== undefined && String(payload.key).trim() !== '') key = String(payload.key).trim();
      if (dbPath.length > 1024 || /[\u0000-\u001f]/.test(dbPath)) { sendError(res, 400, 'That database path is not valid.'); return; }
      if (key.length > 512 || /[\u0000-\u001f\s]/.test(key)) { sendError(res, 400, 'That key is not valid. It has no spaces or line breaks.'); return; }
      settings = { dbPath, key };
      try { saveSettings(); } catch (error) { sendError(res, 500, `Could not save the settings: ${error.message}`); return; }
      maxApi.post('RBox to Live: settings saved; restarting the reader');
      restartReader();
      sendJson(res, 200, settingsView());
    });
    return;
  }

  // Opens this page full size in the default browser, for when Live's short device area is too small to browse in.
  if (pathname === '/open-view' && req.method === 'POST') {
    if (!process.env.RBOX_NO_OPEN) {
      try { spawn('open', [`http://127.0.0.1:${HTTP_PORT}/`], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/setup' && req.method === 'POST') {
    installComponents();
    sendJson(res, 200, { ok: true, state: setupState.state });
    return;
  }

  if (pathname === '/setup-status' && req.method === 'GET') {
    sendJson(res, 200, setupState);
    return;
  }

  if (pathname === '/import-status' && req.method === 'GET') {
    sendJson(res, 200, { ...importState, beatGrid: lastBeatGrid });
    return;
  }

  // A newer device on this machine asks this bridge to free the port. Dropping and re-adding the device in Live
  // leaves the old bridge running, so the new one would otherwise find the port taken.
  if (pathname === '/takeover' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    res.on('finish', handOverPort);
    return;
  }

  sendError(res, 404, 'Endpoint not found');
});

// Each bridge publishes its token in a private file (mode 0600) in the support folder. A newer bridge reads it to ask
// an older one, left running by a device that was deleted in Live, to give up the port.
function publishInstance() {
  try { writePrivateFile(INSTANCE_PATH, JSON.stringify({ pid: process.pid, port: HTTP_PORT, token: apiToken })); } catch (_) {}
}

function previousToken() {
  try { return String(JSON.parse(readFileSync(INSTANCE_PATH, 'utf-8')).token || ''); } catch (_) { return ''; }
}

let takeoverAttempts = 0;
function handOverPort() {
  maxApi.post(`RBox to Live: handing port ${HTTP_PORT} to a newer device`);
  try { server.close(); } catch (_) {}
  try { server.closeAllConnections?.(); } catch (_) {}
  try { reader?.stdin?.end(); } catch (_) {}
  try { reader?.kill('SIGTERM'); } catch (_) {}
}

function takeOverPort() {
  takeoverAttempts++;
  const token = previousToken();
  if (!token) {
    maxApi.post(`RBox to Live: port ${HTTP_PORT} is in use and the other bridge cannot be asked to leave. Restart Live to free it.`);
    return;
  }
  maxApi.post(`RBox to Live: port ${HTTP_PORT} is in use by another RBox to Live bridge; asking it to hand over (attempt ${takeoverAttempts})`);
  const request = http.request({
    host: '127.0.0.1',
    port: HTTP_PORT,
    path: '/takeover',
    method: 'POST',
    headers: { Host: `127.0.0.1:${HTTP_PORT}`, 'X-RBox-Token': token },
  }, (response) => {
    response.resume();
    if (response.statusCode !== 200) {
      maxApi.post(`RBox to Live: the other bridge did not hand over (HTTP ${response.statusCode}). Restart Live to free port ${HTTP_PORT}.`);
      return;
    }
    // The old server stops listening once its open connections close, so give it a moment before retrying.
    setTimeout(() => server.listen(HTTP_PORT, '127.0.0.1'), 500);
  });
  request.on('error', (error) => {
    maxApi.post(`RBox to Live: could not reach the other bridge (${error.message}). Restart Live to free port ${HTTP_PORT}.`);
  });
  request.end();
}

server.listen(HTTP_PORT, '127.0.0.1', () => {
  publishInstance();
  maxApi.post(`RBox to Live HTTP bridge listening on http://127.0.0.1:${HTTP_PORT}`);
  // Start the Python reader immediately so Rekordbox is connected right away
  startReader();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && takeoverAttempts < 3) {
    takeOverPort();
    return;
  }
  maxApi.post(`RBox to Live HTTP server error: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Max Handlers (bidirectional fallback & Live Object Model results)
// ---------------------------------------------------------------------------
maxApi.addHandler('connect', () => {
  maxApi.post('RBox to Live: received connect message');
  if (!reader) startReader();
  requestAsync('search', { query: '', limit: PAGE_SIZE, offset: 0 }).then(d => emit('tracks', d)).catch(() => {});
  requestAsync('playlists').then(d => emit('playlists', d)).catch(() => {});
});

maxApi.addHandler('search', (query, offset) => {
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  requestAsync('search', { query: String(query || ''), limit: PAGE_SIZE, offset: pageOffset })
    .then(data => emit('tracks', { ...data, append: pageOffset > 0 }))
    .catch(err => emit('error', { message: err.message }));
});

maxApi.addHandler('playlists', () => {
  requestAsync('playlists').then(d => emit('playlists', d)).catch(err => emit('error', { message: err.message }));
});

maxApi.addHandler('playlist', (id) => {
  requestAsync('playlist', { id: Number(id) }).then(d => emit('tracks', d)).catch(err => emit('error', { message: err.message }));
});

maxApi.addHandler('import', (id) => {
  triggerImport(Number(id));
});

maxApi.addHandler('live_result', (...args) => {
  maxApi.post('RBox to Live: received live_result');
  const raw = args.join(' ');
  try {
    const decoded = raw.includes('%') ? decodeURIComponent(raw) : raw;
    const data = JSON.parse(decoded);
    importState = {
      inProgress: false,
      ok: !!data.ok,
      message: data.message || '',
      newTrackId: data.data?.newTrackId || 0,
      trackName: data.data?.trackName || '',
    };
    emit('result', data);
  } catch {
    importState = { inProgress: false, ok: false, message: String(raw || 'Could not read the Live import result.'), newTrackId: 0 };
    emit('result', { ok: false, message: importState.message });
  }
});

maxApi.addHandler('close', () => {
  try { server.close(); } catch (_) {}
  try { reader?.stdin?.end(); } catch (_) {}
  try { reader?.kill('SIGTERM'); } catch (_) {}
});

process.on('exit', () => {
  try { server.close(); } catch (_) {}
  try { reader?.kill('SIGTERM'); } catch (_) {}
});
