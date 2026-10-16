// A small in-memory stand-in for Ableton Live's Live Object Model, enough to run src/rbox-to-live-live.js.
//
// It reproduces the behaviours of Live 12.3 that the importer has to work around:
//   - set_or_delete_cue puts a cue on the Arranger grid, which follows the zoom (16 beats fully zoomed out, finer with
//     every zoom_view step "in", down to minGrid); cueGrid 'zoom' models that, 'exact' puts cues exactly at the playhead.
//   - the playhead cannot be set past the song length, and with cueGrid 'stuck' it cannot be moved at all.
//   - a warp marker at beat 0 is refused.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'rbox-to-live-live.js');

// Max's Task object: scheduled steps run when flush() is called, which is where Live would have applied a playhead move.
function createScheduler() {
  const queue = [];
  class Task {
    constructor(fn, owner) { this.fn = fn; this.owner = owner; }
    schedule() { queue.push(() => this.fn.call(this.owner)); }
  }
  function flush() {
    let guard = 0;
    while (queue.length && guard++ < 200000) queue.shift()();
  }
  return { Task, flush };
}

function createMockLive(options = {}) {
  const {
    sceneNames = [],
    userSlotClip = null,
    cueGrid = 'exact',
    minGrid = 0.25,
    songLength = 900,
    userCues = [],
    selectedTrackName = 'User Drums',
  } = options;

  const calls = [];
  const logs = [];
  const outlets = [];
  let nextId = 1000;
  const T = {}, S = {}, C = {}, SC = {};
  const cues = [];
  const song = {
    id: 1, tempo: 122, root_note: 9, scale_name: 'Minor', scale_mode: 1, current_song_time: cueGrid === 'stuck' ? 512 : 0, loop: 0,
    tracks: [], scenes: [], song_length: songLength,
  };
  const view = { selected_track: 0 };
  let zoomLevel = 0;
  let maxZoom = 0;

  const flat = (xs) => xs.flatMap((x) => ['id', x]);
  const cueById = (id) => cues.find((c) => c.id === id);
  const kindOf = (id) => (T[id] ? 'track' : S[id] ? 'slot' : C[id] ? 'clip' : SC[id] ? 'scene' : cueById(id) ? 'cue' : null);
  const grid = () => Math.max(minGrid, 16 / Math.pow(2, zoomLevel / 2));

  function newSlot(trackId) { const id = nextId++; S[id] = { id, trackId, has_clip: 0, clip: null }; return id; }
  function newClip(file) {
    const id = nextId++;
    C[id] = { id, file, name: '', color: null, color_index: 0, warping: 0, looping: 1, start_marker: 0, end_marker: 0,
      loop_start: 0, loop_end: 0, warp_markers: [], start: 0, length: 0 };
    return id;
  }
  function newTrack(name) {
    const id = nextId++;
    T[id] = { id, name, clip_slots: [], arrangement_clips: [] };
    for (let i = 0; i < song.scenes.length; i++) T[id].clip_slots.push(newSlot(id));
    song.tracks.push(id);
    return id;
  }
  function newScene(name) {
    const id = nextId++;
    SC[id] = { id, name };
    song.scenes.push(id);
    for (const tid of song.tracks) T[tid].clip_slots.push(newSlot(tid));
    return id;
  }

  for (const n of sceneNames) newScene(n);
  const userTrack = newTrack(selectedTrackName);
  if (userSlotClip) {
    const slot0 = T[userTrack].clip_slots[0];
    S[slot0].clip = newClip(userSlotClip);
    S[slot0].has_clip = 1;
  }
  view.selected_track = userTrack;
  for (const time of userCues) cues.push({ id: nextId++, time, name: 'User cue' });

  function LiveAPI(_callback, apiPath) {
    if (apiPath === 'live_set') { this.kind = 'song'; this.id = song.id; }
    else if (apiPath === 'live_set view') { this.kind = 'view'; this.id = 2; }
    else if (apiPath === 'live_app view') { this.kind = 'appview'; this.id = 3; }
    else if (apiPath === 'live_set view selected_track') { this.kind = 'track'; this.id = view.selected_track; }
    else if (apiPath === 'this_device' || /canonical_parent/.test(apiPath)) { this.kind = 'none'; this.id = 0; }
    else if (/^id \d+$/.test(apiPath)) { this.id = Number(apiPath.slice(3)); this.kind = kindOf(this.id); }
    else throw new Error('mock: unsupported path ' + apiPath);
    this.unquotedpath = apiPath;
  }
  LiveAPI.prototype.get = function (prop) {
    const { kind: k, id } = this;
    if (k === 'song') {
      if (prop === 'tracks') return flat(song.tracks);
      if (prop === 'scenes') return flat(song.scenes);
      if (prop === 'cue_points') return cues.flatMap((c) => ['id', c.id]);
      if (prop === 'loop_start' || prop === 'loop_end') return [0];
      return [song[prop]];
    }
    if (k === 'track') {
      if (prop === 'clip_slots') return flat(T[id].clip_slots);
      if (prop === 'arrangement_clips') return flat(T[id].arrangement_clips);
      if (prop === 'name') return [T[id].name];
    }
    if (k === 'slot') {
      if (prop === 'has_clip') return [S[id].has_clip];
      if (prop === 'clip') return S[id].clip ? flat([S[id].clip]) : [];
    }
    if (k === 'scene' && prop === 'name') return [SC[id].name];
    if (k === 'clip') {
      if (prop === 'warp_markers') return [JSON.stringify({ warp_markers: C[id].warp_markers })];
      if (prop in C[id]) return [C[id][prop]];
    }
    if (k === 'cue') { const c = cueById(id); return [c ? c[prop] : 0]; }
    return [];
  };
  LiveAPI.prototype.set = function (prop, value) {
    const { kind: k, id } = this;
    calls.push(`set ${k}#${id}.${prop}`);
    if (k === 'song') {
      if (prop === 'current_song_time') {
        if (cueGrid === 'stuck') return;
        if (Number(value) > song.song_length) return;
        song.current_song_time = Number(value);
      } else song[prop] = value;
    } else if (k === 'track') T[id][prop] = value;
    else if (k === 'scene') SC[id][prop] = value;
    else if (k === 'clip') C[id][prop] = value;
    else if (k === 'cue') { const c = cueById(id); if (c && prop === 'name') c.name = value; }
    else if (k === 'view' && prop === 'selected_track') {
      const m = /^id (\d+)$/.exec(String(value));
      if (m) view.selected_track = Number(m[1]);
    }
  };
  LiveAPI.prototype.call = function (method, ...args) {
    const { kind: k, id } = this;
    calls.push(`call ${k}#${id}.${method}`);
    if (k === 'appview' && method === 'zoom_view') {
      if (args[0] === 3) { zoomLevel++; maxZoom = Math.max(maxZoom, zoomLevel); }
      else if (args[0] === 2) zoomLevel--;
      return;
    }
    if (k === 'song') {
      if (method === 'create_audio_track' || method === 'create_midi_track') { newTrack(''); return; }
      if (method === 'create_scene') { newScene(''); return; }
      if (method === 'set_or_delete_cue') {
        const g = cueGrid === 'zoom' ? grid() : 0;
        const at = g ? Math.round(song.current_song_time / g) * g : song.current_song_time;
        const existing = cues.findIndex((c) => Math.abs(c.time - at) < 0.001);
        if (existing >= 0) cues.splice(existing, 1);
        else cues.push({ id: nextId++, time: at, name: '' });
        return;
      }
    }
    if (k === 'track' && method === 'create_audio_clip') {
      const clipId = newClip(args[0]);
      C[clipId].start = Number(args[1]) || 0;
      T[id].arrangement_clips.push(clipId);
      return;
    }
    if (k === 'track' && method === 'create_midi_clip') {
      const clipId = newClip('midi');
      C[clipId].start = Number(args[0]);
      C[clipId].length = Number(args[1]);
      T[id].arrangement_clips.push(clipId);
      return;
    }
    if (k === 'slot') {
      if (method === 'delete_clip') { calls.push('!!DELETE_CLIP'); S[id].clip = null; S[id].has_clip = 0; return; }
      if (method === 'create_audio_clip') { S[id].clip = newClip(args[0]); S[id].has_clip = 1; return; }
    }
    if (k === 'clip') {
      if (method === 'add_warp_marker') {
        const marker = JSON.parse(args[0]);
        if (Number(marker.beat_time) <= 0) throw new Error('Segment length out of range');
        C[id].warp_markers = C[id].warp_markers.filter((m) => m.beat_time !== marker.beat_time).concat(marker);
        return;
      }
      if (method === 'remove_warp_marker') {
        C[id].warp_markers = C[id].warp_markers.filter((m) => m.beat_time !== Number(args[0]));
        return;
      }
    }
    throw new Error(`mock: unsupported ${k}.${method}`);
  };

  const scheduler = createScheduler();
  const context = vm.createContext({
    Task: scheduler.Task,
    post: (message) => logs.push(String(message)),
    outlet: (...a) => outlets.push(a),
    arrayfromargs: (args) => Array.from(args),
    LiveAPI,
    console,
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context);

  // Runs an import the way the device does: the bridge sends the item URL-encoded, then Max's scheduler runs the rest.
  function runImport(item) {
    context.liveimport(encodeURIComponent(JSON.stringify(item)));
    scheduler.flush();
    // The importer reports with outlet(0, 'live_result', <URL-encoded JSON>).
    const report = outlets.filter((o) => o[1] === 'live_result').pop();
    return report ? JSON.parse(decodeURIComponent(report[2])) : null;
  }

  return {
    runImport, calls, logs, outlets, T, S, C, SC, cues, song, userTrack,
    zoomLevel: () => zoomLevel,
    maxZoom: () => maxZoom,
    tracks: () => song.tracks.map((id) => T[id]),
    clipsOf: (track) => track.arrangement_clips.map((id) => C[id]),
  };
}

// A track item as the bridge builds it.
function trackItem(overrides = {}) {
  return {
    file: '/music/Test Artist - Test Track.aif',
    id: 1, title: 'Test Track', artist: 'Test Artist', bpm: 124, firstBeatMs: 120, key: '8A',
    lengthMs: 300000, cues: [], sections: [], beatMs: [], vocalRegions: [],
    targetTrack: 'new', targetView: 'arrangement', syncTempo: true,
    ...overrides,
  };
}

const sections = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  name: `Part ${i + 1}`, letter: 'ABCDEFGH'[i], startBeat: i * 32, endBeat: (i + 1) * 32, startMs: 0, endMs: 1, ...extra,
}));

module.exports = { createMockLive, trackItem, sections };
