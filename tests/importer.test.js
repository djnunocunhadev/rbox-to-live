// Tests for src/rbox-to-live-live.js, run against a mock of Live's Object Model (see helpers/mock-live.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockLive, trackItem, sections } = require('./helpers/mock-live');

const USER_SCENES = ['A Plate (short)', 'B Hall (long)', 'C Echo 1/8D', 'D Throw Delay', 'E Huge Throw', 'Main'];

test('importing into the current track never deletes or renames what is already in the set', () => {
  const live = createMockLive({ sceneNames: USER_SCENES, userSlotClip: '/music/user-clip.aif' });
  const userClip = live.S[live.T[live.userTrack].clip_slots[0]].clip;
  live.runImport(trackItem({ targetTrack: 'current', targetView: 'both', sections: sections(3) }));

  assert.equal(live.calls.filter((c) => c === '!!DELETE_CLIP').length, 0, 'no clip is deleted');
  assert.equal(live.S[live.T[live.userTrack].clip_slots[0]].clip, userClip, 'the user clip in slot 1 is untouched');
  assert.deepEqual(live.song.scenes.map((id) => live.SC[id].name), USER_SCENES, 'scene names are untouched');
  assert.equal(live.S[live.T[live.userTrack].clip_slots[1]].has_clip, 1, 'free slots get the new clips');
  assert.equal(live.S[live.T[live.userTrack].clip_slots[2]].has_clip, 1);
  assert.ok(!live.calls.some((c) => /delete_(track|scene)/.test(c)), 'no track or scene is deleted');
});

test('a new track adds one track, keeps the user scenes and labels only the scenes it adds', () => {
  const live = createMockLive({ sceneNames: USER_SCENES, userSlotClip: '/music/user-clip.aif' });
  const before = live.song.tracks.length;
  live.runImport(trackItem({ targetView: 'session', sections: sections(8) }));

  assert.equal(live.song.tracks.length, before + 1);
  const names = live.song.scenes.map((id) => live.SC[id].name);
  assert.deepEqual(names.slice(0, 6), USER_SCENES);
  assert.equal(names[6], 'Part 7');
  assert.equal(names[7], 'Part 8');
  const created = live.T[live.song.tracks[live.song.tracks.length - 1]];
  assert.deepEqual(created.clip_slots.map((id) => live.S[id].has_clip), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(live.calls.filter((c) => c === '!!DELETE_CLIP').length, 0);
});

test('a track full of user clips is left alone', () => {
  const live = createMockLive({ sceneNames: USER_SCENES, userSlotClip: '/music/user-clip.aif' });
  for (const id of live.T[live.userTrack].clip_slots) live.S[id].has_clip = 1;
  live.runImport(trackItem({ targetTrack: 'current', targetView: 'session', sections: sections(6) }));
  assert.equal(live.calls.filter((c) => c === '!!DELETE_CLIP').length, 0);
});

test('a song-structure split puts one named, coloured clip per section on the track', () => {
  const live = createMockLive();
  const parts = [
    { name: 'Intro', color: 0xd4554f, startBeat: 0, endBeat: 32 },
    { name: 'Verse 1', color: 0x526ef6, startBeat: 32, endBeat: 64 },
    { name: 'Chorus', color: 0x89c182, startBeat: 64, endBeat: 96 },
  ];
  live.runImport(trackItem({ sections: parts }));
  const track = live.tracks()[live.tracks().length - 1];
  const clips = live.clipsOf(track);
  assert.deepEqual(clips.map((c) => c.name), ['Intro', 'Verse 1', 'Chorus']);
  assert.deepEqual(clips.map((c) => c.color), [0xd4554f, 0x526ef6, 0x89c182]);
  assert.deepEqual(clips.map((c) => c.start), [0, 32, 64]);
});

test('without a split the track is one clip', () => {
  const live = createMockLive();
  live.runImport(trackItem({ sections: [{ name: 'Whole', startBeat: 0, endBeat: 600 }] }));
  const track = live.tracks()[live.tracks().length - 1];
  assert.equal(live.clipsOf(track).length, 1);
});

test('every beat of the Rekordbox grid becomes a warp marker, with beat 0 left to Live', () => {
  const live = createMockLive();
  const beatMs = Array.from({ length: 40 }, (_, i) => 237 + i * 491.8);
  live.runImport(trackItem({ sections: sections(2), beatMs }));
  const track = live.tracks()[live.tracks().length - 1];
  for (const clip of live.clipsOf(track)) {
    assert.equal(clip.warp_markers.length, 39, 'beats 1 to 39 are placed');
    assert.ok(clip.warp_markers.every((m) => m.beat_time >= 1));
  }
  assert.ok(live.logs.some((l) => /39 of 39 beats placed in Live/.test(l)));
});

test('vocal regions go on a "Vocal Position" track, one clip per region named by its start bar', () => {
  const live = createMockLive();
  live.runImport(trackItem({
    vocalRegions: [{ startBeat: 69.05, endBeat: 106.87 }, { startBeat: 154.18, endBeat: 228.28 }, { startBeat: 10, endBeat: 10 }],
    sections: [{ name: 'Whole', startBeat: 0, endBeat: 300 }],
  }));
  const vocal = live.tracks().find((t) => t.name === 'Vocal Position');
  assert.ok(vocal, 'the track exists');
  const clips = live.clipsOf(vocal);
  assert.deepEqual(clips.map((c) => c.name), ['18 Vocal Position', '39 Vocal Position'], 'the empty region is skipped');
  assert.ok(clips.every((c) => c.color === 0x4695d0));
});

test('hot cues become letter-named locators and memory cues are not markers', () => {
  const live = createMockLive({ userCues: [96] });
  const report = live.runImport(trackItem({
    sections: [{ name: 'Whole', startBeat: 0, endBeat: 700 }],
    cues: [
      { letter: 'A', beat: 0, comment: 'Cue 1' }, { letter: 'B', beat: 32 }, { letter: 'C', beat: 160.001, comment: 'Drop' },
      { letter: 'Memory', beat: 250 },
    ],
  }));
  assert.ok(report.ok);
  const named = live.cues.filter((c) => c.name !== 'User cue');
  assert.deepEqual(named.map((c) => c.name).sort(), ['A', 'B', 'C']);
  assert.ok(live.cues.some((c) => c.name === 'User cue' && c.time === 96), 'the user cue is untouched');
  assert.ok(!live.cues.some((c) => c.name === 'Memory'));
});

test('locators land on their own beats although Live snaps new cues to a zoom-dependent grid, and the zoom is restored', () => {
  const live = createMockLive({ cueGrid: 'zoom', userCues: [96] });
  const wanted = [['A', 0], ['B', 32], ['C', 100], ['G', 520.001], ['H', 607.999]];
  live.runImport(trackItem({
    sections: [{ name: 'Whole', startBeat: 0, endBeat: 700 }],
    cues: wanted.map(([letter, beat]) => ({ letter, beat })),
  }));
  for (const [letter, beat] of wanted) {
    const hit = live.cues.find((c) => c.name === letter);
    assert.ok(hit && Math.abs(hit.time - beat) < 0.05, `${letter} sits on beat ${beat} (found ${hit && hit.time})`);
  }
  assert.ok(!live.cues.some((c) => !c.name), 'no unnamed stray cue is left behind');
  assert.ok(live.cues.some((c) => c.name === 'User cue' && c.time === 96), 'the user cue is still there, with its name');
  assert.ok(live.logs.some((l) => /Put back the cue "User cue" at beat 96/.test(l)),
    'cue C (beat 100) first snapped onto the user cue at 96, deleted it, and the importer put it back');
  assert.ok(live.maxZoom() > 0 && live.maxZoom() <= 16, 'zoomed in only as far as needed');
  assert.equal(live.zoomLevel(), 0, 'the Arranger zoom is back where it was');
});

test('a cue that lands off its beat and cannot be fixed is left out, not misplaced', () => {
  const live = createMockLive({ cueGrid: 'zoom', minGrid: 1 });
  live.runImport(trackItem({
    sections: [{ name: 'Whole', startBeat: 0, endBeat: 700 }],
    cues: [{ letter: 'A', beat: 0 }, { letter: 'B', beat: 41.37 }],
  }));
  assert.ok(live.cues.some((c) => c.name === 'A'));
  assert.ok(!live.cues.some((c) => c.name === 'B'), 'beat 41.37 is not on any grid step this Live offers (the finest is one beat)');
  assert.ok(!live.cues.some((c) => !c.name), 'the misplaced cue was removed again');
  assert.equal(live.zoomLevel(), 0);
});

test('when the playhead cannot be moved, hot cues fall back to marker clips and no cue is toggled blindly', () => {
  const live = createMockLive({ cueGrid: 'stuck' });
  live.runImport(trackItem({
    sections: [{ name: 'Whole', startBeat: 0, endBeat: 700 }],
    cues: [{ letter: 'A', beat: 0 }, { letter: 'B', beat: 32 }],
  }));
  assert.equal(live.calls.filter((c) => /set_or_delete_cue/.test(c)).length, 0);
  const markers = live.tracks().find((t) => t.name.startsWith('Cues'));
  assert.ok(markers, 'a Cues track exists');
  assert.deepEqual(live.clipsOf(markers).map((c) => c.name), ['A', 'B']);
});
