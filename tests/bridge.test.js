// Tests for src/rbox-to-live-node.js. The bridge runs as a plain Node process here: max-api is a stub and the Rekordbox
// reader is a fake that speaks the same protocol, so no Live, Max or Rekordbox library is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'src', 'rbox-to-live-node.js');
const FAKE_READER = path.join(__dirname, 'stubs', 'fake-reader.py');
const PYTHON = process.env.PYTHON || 'python3';

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, pathname, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { Host: host || `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function startBridge(overrides = {}) {
  const port = overrides.port || await freePort();
  const support = overrides.support || fs.mkdtempSync(path.join(os.tmpdir(), 'rbox-support-'));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, 'stubs', 'node_modules'),
      RBOX_PORT: String(port),
      RBOX_SUPPORT_DIR: support,
      RBOX_READER: FAKE_READER,
      RBOX_PYTHON: PYTHON,
      RBOX_NO_OPEN: '1',
    },
    stdio: 'ignore',
  });
  // Wait until it answers.
  for (let i = 0; i < 60; i += 1) {
    try { await request(port, 'GET', '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(resolve, 1500); });
  return { port, support, child, stop };
}

// The page is served with the bridge's token filled in; that is how the page gets it.
async function tokenOf(port) {
  const page = await request(port, 'GET', '/');
  const m = /const API_TOKEN = '([^']+)'/.exec(page.text);
  return { page, token: m && m[1] };
}

async function waitForStatus(port, token, predicate) {
  let last;
  for (let i = 0; i < 50; i += 1) {
    last = JSON.parse((await request(port, 'GET', '/status', { headers: { 'X-RBox-Token': token } })).text);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

test('the page is served with a fresh token filled in, and the API refuses requests without it', async () => {
  const a = await startBridge();
  const b = await startBridge();
  try {
    const first = await tokenOf(a.port);
    const second = await tokenOf(b.port);
    assert.equal(first.page.status, 200);
    assert.ok(first.token && first.token.length >= 32, 'a token is in the page');
    assert.ok(!first.page.text.includes("'__RBOX_TOKEN__'") || first.page.text.includes("'__RBOX_' + 'TOKEN__'"), 'the placeholder is gone');
    assert.notEqual(first.token, second.token, 'every bridge has its own token');
    assert.match(first.page.headers['cache-control'], /no-store/);

    assert.equal((await request(a.port, 'GET', '/status')).status, 401, 'no token');
    assert.equal((await request(a.port, 'GET', '/status', { headers: { 'X-RBox-Token': 'wrong' } })).status, 401, 'wrong token');
    assert.equal((await request(a.port, 'GET', '/status', { headers: { 'X-RBox-Token': second.token } })).status, 401, "another bridge's token");
    assert.equal((await request(a.port, 'GET', '/status', { headers: { 'X-RBox-Token': first.token } })).status, 200);
  } finally {
    await a.stop(); await b.stop();
  }
});

test('requests for another host name or from another origin are refused', async () => {
  const bridge = await startBridge();
  try {
    const { token } = await tokenOf(bridge.port);
    const auth = { 'X-RBox-Token': token };
    assert.equal((await request(bridge.port, 'GET', '/status', { headers: auth, host: 'evil.example:80' })).status, 403, 'DNS rebinding');
    assert.equal((await request(bridge.port, 'GET', '/status', { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403, 'foreign origin');
    assert.equal((await request(bridge.port, 'GET', '/status', { headers: { ...auth, Origin: 'file://' } })).status, 200, 'the device page from a file');
  } finally {
    await bridge.stop();
  }
});

test('with no key the bridge says so, and a key typed in the settings is saved privately and accepted', async () => {
  const bridge = await startBridge();
  try {
    const { token } = await tokenOf(bridge.port);
    const auth = { 'X-RBox-Token': token, 'Content-Type': 'application/json' };

    const offline = await waitForStatus(bridge.port, token, (s) => s.errorCode);
    assert.equal(offline.online, false);
    assert.equal(offline.errorCode, 'key-missing');

    const wrong = await request(bridge.port, 'POST', '/settings', { headers: auth, body: { key: 'not-the-key' } });
    assert.equal(wrong.status, 200);
    const rejected = await waitForStatus(bridge.port, token, (s) => s.errorCode === 'key-rejected');
    assert.equal(rejected.errorCode, 'key-rejected');

    const right = await request(bridge.port, 'POST', '/settings', { headers: auth, body: { key: '  good-key\n', dbPath: '/some/master.db' } });
    assert.equal(right.status, 200);
    const online = await waitForStatus(bridge.port, token, (s) => s.online);
    assert.equal(online.online, true);
    assert.equal(online.tracks, 3);

    // The key is stored in a file only its owner can read, and is never sent back.
    const file = path.join(bridge.support, 'settings.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, 'good-key', 'surrounding whitespace is trimmed');
    const view = await request(bridge.port, 'GET', '/settings', { headers: auth });
    assert.ok(!view.text.includes('good-key'));
    const parsed = JSON.parse(view.text);
    assert.equal(parsed.hasKey, true);
    assert.equal(parsed.dbPath, '/some/master.db');

    // Removing it takes the reader back to key-missing.
    await request(bridge.port, 'POST', '/settings', { headers: auth, body: { clearKey: true } });
    const cleared = await waitForStatus(bridge.port, token, (s) => s.errorCode === 'key-missing');
    assert.equal(cleared.errorCode, 'key-missing');
    assert.equal(JSON.parse((await request(bridge.port, 'GET', '/settings', { headers: auth })).text).hasKey, false);
  } finally {
    await bridge.stop();
  }
});

test('settings with an invalid key or database path are rejected', async () => {
  const bridge = await startBridge();
  try {
    const { token } = await tokenOf(bridge.port);
    const auth = { 'X-RBox-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await request(bridge.port, 'POST', '/settings', { headers: auth, body: { key: 'two words' } })).status, 400);
    assert.equal((await request(bridge.port, 'POST', '/settings', { headers: auth, body: { key: 'k'.repeat(600) } })).status, 400);
    assert.equal((await request(bridge.port, 'POST', '/settings', { headers: auth, body: { dbPath: '/a\nb' } })).status, 400);
    assert.equal((await request(bridge.port, 'POST', '/settings', { headers: auth, body: '{nope' })).status, 400);
    assert.ok(!fs.existsSync(path.join(bridge.support, 'settings.json')), 'nothing was saved');
  } finally {
    await bridge.stop();
  }
});

test('saved settings are used the next time the bridge starts', async () => {
  const support = fs.mkdtempSync(path.join(os.tmpdir(), 'rbox-support-'));
  fs.writeFileSync(path.join(support, 'settings.json'), JSON.stringify({ dbPath: '', key: 'good-key' }), { mode: 0o600 });
  const bridge = await startBridge({ support });
  try {
    const { token } = await tokenOf(bridge.port);
    const status = await waitForStatus(bridge.port, token, (s) => s.online || s.errorCode);
    assert.equal(status.online, true);
  } finally {
    await bridge.stop();
  }
});

test('a newer bridge asks an older one to give up the port', async () => {
  const first = await startBridge();
  const second = await startBridge({ port: first.port, support: first.support });
  try {
    // The first one published its token in the support folder; the second used it to ask for the port.
    const instance = JSON.parse(fs.readFileSync(path.join(first.support, 'instance.json'), 'utf8'));
    assert.equal(instance.port, first.port);
    assert.equal(fs.statSync(path.join(first.support, 'instance.json')).mode & 0o777, 0o600);
    let page;
    for (let i = 0; i < 40; i += 1) {
      page = await tokenOf(first.port).catch(() => null);
      if (page && page.token && page.token !== instance.token) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(page && page.token && page.token !== instance.token, 'the second bridge now serves the port');
  } finally {
    await second.stop(); await first.stop();
  }
});

test('the components installer reports idle until asked, and has a status route', async () => {
  const bridge = await startBridge();
  try {
    const { token } = await tokenOf(bridge.port);
    const status = JSON.parse((await request(bridge.port, 'GET', '/setup-status', { headers: { 'X-RBox-Token': token } })).text);
    assert.equal(status.state, 'idle');
    const view = JSON.parse((await request(bridge.port, 'GET', '/settings', { headers: { 'X-RBox-Token': token } })).text);
    assert.equal(typeof view.components.privateEnvironment, 'boolean');
  } finally {
    await bridge.stop();
  }
});

test('the large view route answers without opening anything during tests, and needs the token', async () => {
  const bridge = await startBridge();
  try {
    const { token } = await tokenOf(bridge.port);
    assert.equal((await request(bridge.port, 'POST', '/open-view')).status, 401);
    const opened = await request(bridge.port, 'POST', '/open-view', { headers: { 'X-RBox-Token': token } });
    assert.equal(opened.status, 200);
    assert.equal(JSON.parse(opened.text).ok, true);
  } finally {
    await bridge.stop();
  }
});
