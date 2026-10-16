/* Live Object Model importer for RBox to Live.
   Handles importing Rekordbox audio tracks into Ableton Live (Arrangement View + Session View)
   with full cue support, proper track selection preservation, and verbose Max Console logging. */
autowatch = 1;
inlets = 1;
outlets = 1;

function log(msg) {
  post('[RBox Live] ' + msg + '\n');
}

function select_track(trackId) {
  try {
    var idNum = Number(trackId);
    if (!idNum) return;
    var songView = new LiveAPI(null, 'live_set view');
    songView.set('selected_track', 'id ' + idNum);
    log('Selected track ID: ' + idNum);
  } catch (e) {
    log('Could not select track ' + trackId + ': ' + e.message);
  }
}

function liveimport() {
  log('========================================');
  log('Starting Live import...');

  var args = arrayfromargs(arguments);
  var raw = args.join(' ');
  var item;
  try {
    var decoded = (raw.indexOf('%') !== -1 || raw.indexOf('{') === -1) ? decodeURIComponent(raw) : raw;
    item = JSON.parse(decoded);
  } catch (e) {
    log('ERROR: JSON parse failed: ' + e.message);
    report(false, 'Import data was invalid: ' + e.message);
    return;
  }

  currentBeatMs = Array.isArray(item.beatMs) ? item.beatMs : [];
  log('Beat grid received: ' + currentBeatMs.length + ' beats');
  if (!item.file) {
    log('ERROR: No audio file path provided.');
    report(false, 'The selected track has no audio file path.');
    return;
  }

  log('Track: ' + clean(item.artist) + ' — ' + clean(item.title));
  log('Audio file: ' + item.file);
  log('BPM: ' + item.bpm + ' | Key: ' + item.key);
  log('Target track mode: ' + (item.targetTrack || 'new') + ' | View mode: ' + (item.targetView || 'both'));

  // 1. Identify and remember the host track where RBox to Live is located
  // This is vital to keep RBox to Live in the device rack instead of jumping away!
  var hostTrack = null;
  var hostTrackPath = null;
  var hostTrackId = 0;
  try {
    var thisDev = new LiveAPI(null, 'this_device');
    if (thisDev && thisDev.id) {
      hostTrack = new LiveAPI(null, 'this_device canonical_parent');
      if (hostTrack && hostTrack.id) {
        hostTrackPath = hostTrack.unquotedpath;
        hostTrackId = hostTrack.id;
        log('RBox device is hosted on track: ' + hostTrackPath + ' (ID: ' + hostTrack.id + ')');
      }
    }
  } catch (devErr) {
    log('Notice: could not resolve host track: ' + devErr.message);
  }

  // 2. Set song tempo and key if requested
  var song = new LiveAPI(null, 'live_set');
  if (item.syncTempo !== false && item.bpm && Number(item.bpm) >= 20 && Number(item.bpm) <= 999) {
    try {
      song.set('tempo', Number(item.bpm));
      log('Set Live Set tempo to: ' + Number(item.bpm));
    } catch (tempoErr) {
      log('Notice: could not set tempo: ' + tempoErr.message);
    }
  }

  var key = liveKey(item.key);
  if (key) {
    try {
      song.set('root_note', key.root);
      song.set('scale_name', key.scale);
      song.set('scale_mode', 1);
      log('Set Live Set key to: ' + item.key + ' (' + key.scale + ', root ' + key.root + ')');
    } catch (_) {}
  }

  // 3. Resolve or create target track
  var targetTrack = null;
  var targetTrackId = 0;
  var isNewTrack = (item.targetTrack !== 'current');

  if (isNewTrack) {
    try {
      log('Creating new audio track in Live Set...');
      song.call('create_audio_track', -1);
      var trackIds = ids(song.get('tracks'));
      if (!trackIds.length) throw new Error('Live did not return any tracks after create_audio_track.');
      targetTrackId = trackIds[trackIds.length - 1];
      targetTrack = new LiveAPI(null, 'id ' + targetTrackId);
      var trackName = clean(item.artist) + ' — ' + clean(item.title) + (item.key ? ' [' + clean(item.key) + ']' : '');
      targetTrack.set('name', trackName.slice(0, 60));
      log('New audio track created: ID ' + targetTrackId + ' ("' + trackName + '")');
    } catch (e) {
      log('ERROR creating audio track: ' + e.message);
      report(false, 'Could not create an Ableton audio track: ' + e.message);
      return;
    }
  } else {
    // Current track mode
    try {
      targetTrack = new LiveAPI(null, 'live_set view selected_track');
      if (!targetTrack || !targetTrack.id) {
        if (hostTrack) targetTrack = hostTrack;
        else throw new Error('No track currently selected.');
      }
      targetTrackId = targetTrack.id;
      log('Using current track: ID ' + targetTrackId + ' (' + targetTrack.unquotedpath + ')');
    } catch (e) {
      log('ERROR resolving current track: ' + e.message);
      report(false, 'Could not determine target track: ' + e.message);
      return;
    }
  }

  // 4. Populate Arrangement View timeline
  var doArrangement = (item.targetView !== 'session');
  var arrangementOk = false;
  var locatorCount = 0;
  var cueMarkerCount = 0;
  var sectionClipCount = 0;
  // The clips go down first: the song length has to reach the end of the track, because Live will not move the playhead
  // past it and the later cues could not be placed. A locator can snap to a clip edge (a cue for beat 520 landed at 517,
  // the start of a section clip), which the locator step handles by zooming in until the cue lands on its own beat.
  function placeClips() {
    if (doArrangement) {
    try {
      if (item.sections && item.sections.length > 1) {
        // Cut the track into one arrangement clip per section, so the song reads as clips on its own track.
        sectionClipCount = createSectionClips(targetTrack, item);
        arrangementOk = sectionClipCount > 0;
        if (!arrangementOk) throw new Error('no section clips could be created');
      } else {
      log('Creating Arrangement clip on target track at beat 0.0...');
      targetTrack.call('create_audio_clip', item.file, 0.0);
      log('Arrangement audio clip created at beat 0.0');

      // Style and apply Rekordbox beatgrid to the arrangement clip
      try {
        var arrClips = ids(targetTrack.get('arrangement_clips'));
        if (arrClips.length > 0) {
          var arrClipId = arrClips[arrClips.length - 1];
          var arrClip = new LiveAPI(null, 'id ' + arrClipId);
          var clipName = clean(item.artist) + ' — ' + clean(item.title) + (item.key ? ' [' + clean(item.key) + ']' : '');
          arrClip.set('name', clipName.slice(0, 60));
          
          applyRekordboxBeatgrid(arrClip, item.bpm, item.firstBeatMs, item.lengthMs);
          try { arrClip.set('start_marker', 0.0); } catch (_) {}
          try { arrClip.set('looping', 0); } catch (_) {}
          log('Arrangement clip beatgrid and alignment applied successfully.');
        }
      } catch (namingErr) {
        log('Notice: arrangement clip setup: ' + namingErr.message);
      }
      arrangementOk = true;
      }
    } catch (arrErr) {
      log('ERROR placing audio on Arrangement timeline: ' + arrErr.message);
    }

    }
  }

  placeClips();

  if (doArrangement && hotCues(item.cues).length > 0) {
    createArrangementLocators(song, item.cues, function (created, already) {
      locatorCount = created + already;
      // When Live places no locators and none were there already, show the hot cues as named markers instead.
      if (created + already === 0) {
        try {
          cueMarkerCount = createCueMarkers(song, item);
        } catch (cueErr) {
          log('Notice: cue markers: ' + cueErr.message);
        }
      }
      finishImport();
    });
    return;
  }

  finishImport();

  function finishImport() {
    // 5. Populate Session View scenes & clip slots (for cue launch / DJ sets)
    var doSession = (item.targetView !== 'arrangement');
    var sessionCount = 0;
    var skippedCount = 0;
    var sections = (item.sections && item.sections.length > 0) ? item.sections : [
      { startBeat: 0, endBeat: 32, startMs: 0, endMs: Number(item.lengthMs) || 180000, name: clean(item.title), letter: 'Start' }
    ];

    if (doSession) {
      var tempoVal = song.get('tempo');
      var bpm = Number(item.bpm) || Number(Array.isArray(tempoVal) ? tempoVal[0] : tempoVal) || 120.0;
      log('Creating Session cue clips (' + sections.length + ' sections) at ' + bpm + ' BPM...');

      var clipColors = [13, 24, 30, 42, 54, 60, 4, 18, 36, 48];

      for (var i = 0; i < sections.length; i++) {
        var sec = sections[i];
        var secLabel = String(sec.name || ('Part ' + (i + 1))).slice(0, 50);

        // Ensure scene exists for slot i
        try {
          var scenes = ids(song.get('scenes'));
          while (scenes.length <= i) {
            song.call('create_scene', -1);
            scenes = ids(song.get('scenes'));
          }
          var scene = new LiveAPI(null, 'id ' + scenes[i]);
          // Keep scene names the user already set. Only an unnamed scene takes the cue label.
          var sceneName = scene.get('name');
          if (!String(Array.isArray(sceneName) ? sceneName.join(' ') : (sceneName || '')).trim()) {
            scene.set('name', secLabel);
          }
        } catch (scErr) {
          log('Notice: scene setup for part ' + (i + 1) + ': ' + scErr.message);
        }

        // Prepare slot and create clip using slot ID
        try {
          var slotIds = ids(targetTrack.get('clip_slots'));
          if (i >= slotIds.length) {
            log('Notice: slot index ' + i + ' exceeds available slots ' + slotIds.length);
            continue;
          }

          var slot = new LiveAPI(null, 'id ' + slotIds[i]);
          // Never replace a clip that is already in the slot.
          if (Number(slot.get('has_clip')) === 1) {
            log('Notice: slot ' + (i + 1) + ' already holds a clip; left it unchanged');
            skippedCount++;
            continue;
          }
          slot.call('create_audio_clip', item.file);

          // Resolve newly created clip in slot
          var clip = null;
          var clipProp = slot.get('clip');
          var cIds = ids(clipProp);
          if (cIds.length > 0) {
            clip = new LiveAPI(null, 'id ' + cIds[0]);
          }
          if (!clip || !clip.id) {
            clip = new LiveAPI(null, slot.unquotedpath + ' clip');
          }

          if (clip && clip.id) {
            clip.set('name', secLabel);
          
            // Apply beatgrid to this session clip
            applyRekordboxBeatgrid(clip, bpm, item.firstBeatMs, item.lengthMs);

            // Calculate start and end beats for this cue section
            var startBeat = (sec.startBeat !== undefined && sec.startBeat !== null)
              ? Number(sec.startBeat)
              : Math.max(0, (Number(sec.startMs) - (Number(item.firstBeatMs) || 0)) * bpm / 60000.0);
            var endBeat = (sec.endBeat !== undefined && sec.endBeat !== null)
              ? Number(sec.endBeat)
              : Math.max(startBeat + 0.25, (Number(sec.endMs) - (Number(item.firstBeatMs) || 0)) * bpm / 60000.0);

            setClipMarkers(clip, startBeat, endBeat);

            // The phrase colour when the track has phrase analysis; otherwise a distinct palette colour.
            if (!setSectionColor(clip, sec)) {
              try {
                clip.set('color_index', clipColors[i % clipColors.length]);
              } catch (_) {}
            }

            sessionCount++;
            log('Session clip ' + (i + 1) + ' ("' + secLabel + '") ready: beat ' + startBeat.toFixed(2) + ' to ' + endBeat.toFixed(2));
          } else {
            log('Notice: clip not found in slot ' + i);
          }
        } catch (clErr) {
          log('Notice: creating session clip ' + (i + 1) + ': ' + clErr.message);
        }
      }
      log('Configured ' + sessionCount + ' Session clips' + (skippedCount ? ' (' + skippedCount + ' slots already had clips and were left alone)' : '') + '.');
    }

    // 5b. Vocal regions from Rekordbox's vocal detection, as empty MIDI clips on a track of their own
    if (item.vocalRegions && item.vocalRegions.length > 0) {
      try {
        createVocalClips(song, item);
      } catch (vocErr) {
        log('Notice: vocal clips: ' + vocErr.message);
      }
    }

    // 6. Restore Selection to Host Track
    // This guarantees RBox to Live stays in view and does NOT disappear from the device rack!
    if (isNewTrack && hostTrackId) {
      try {
        var songView = new LiveAPI(null, 'live_set view');
        songView.set('selected_track', 'id ' + hostTrackId);
        log('Restored selection to RBox host track: ' + hostTrackPath);
      } catch (selErr) {
        log('Notice: restoring selection: ' + selErr.message);
      }
    }

    // 7. Verify result and report to UI
    if (!arrangementOk && sessionCount === 0) {
      log('ERROR: Neither Arrangement nor Session clips could be created.');
      report(false, 'Live could not create audio clips from this file. Check file format and permissions.');
      return;
    }

    var summaryParts = [];
    var cueCount = (item.cues ? item.cues.length : 0);
    if (arrangementOk) {
      var arrangementNote = locatorCount > 0 ? ' (' + locatorCount + ' locators)'
        : (sectionClipCount > 0 ? ' (' + sectionClipCount + ' section clips)'
        : (cueMarkerCount > 0 ? ' (' + cueMarkerCount + ' cue markers)' : ''));
      summaryParts.push('Arrangement' + arrangementNote);
    }
    if (sessionCount > 0) {
      summaryParts.push(sessionCount + ' Session cue clip' + (sessionCount === 1 ? '' : 's'));
    }
    var summary = summaryParts.join(' + ');

    var successMsg = 'Imported ' + clean(item.artist) + ' — ' + clean(item.title) + ' (' + summary + ')';
    log('SUCCESS: ' + successMsg);
    report(true, successMsg, {
      newTrackId: targetTrackId,
      trackName: clean(item.artist) + ' — ' + clean(item.title),
      arrangementOk: arrangementOk,
      sessionCount: sessionCount,
      cueCount: cueCount,
      isNewTrack: isNewTrack
    });
  }
}

// Sample time of the warp marker at this beat position, or null if there is none.
function warpMarkerSample(clip, beatTime) {
  try {
    var raw = clip.get('warp_markers');
    var jsonStr = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
    var startIdx = jsonStr.indexOf('{');
    if (startIdx === -1) return null;
    var markers = JSON.parse(jsonStr.slice(startIdx)).warp_markers || [];
    for (var i = 0; i < markers.length; i++) {
      if (Math.abs(Number(markers[i].beat_time) - beatTime) < 0.001) return Number(markers[i].sample_time);
    }
  } catch (e) {
    log('Notice: reading warp markers: ' + e.message);
  }
  return null;
}

// Remove the warp markers Live placed on the clip. remove_warp_marker takes the marker's beat position.
// The track cut into one arrangement clip per section: each clip plays its section of the file at that section's
// position, using the same beatgrid as the single-clip import.
// Colour a clip with its phrase colour (0xRRGGBB from the reader). Returns false when the section has none.
function setSectionColor(clip, sec) {
  if (!sec || typeof sec.color !== 'number') return false;
  try {
    clip.set('color', sec.color);
    return true;
  } catch (_) {
    return false;
  }
}

function createSectionClips(track, item) {
  var created = 0;
  for (var i = 0; i < item.sections.length; i++) {
    var sec = item.sections[i];
    var start = Number(sec.startBeat);
    var end = Number(sec.endBeat);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    try {
      track.call('create_audio_clip', item.file, start);
      var clipIds = ids(track.get('arrangement_clips'));
      if (!clipIds.length) throw new Error('Live returned no clip');
      var clip = new LiveAPI(null, 'id ' + clipIds[clipIds.length - 1]);
      clip.set('name', String(sec.name || ('Part ' + (i + 1))).slice(0, 60));
      setSectionColor(clip, sec);
      applyRekordboxBeatgrid(clip, item.bpm, item.firstBeatMs, item.lengthMs);
      setClipMarkers(clip, start, end);
      created++;
    } catch (e) {
      log('Notice: section clip ' + (i + 1) + ': ' + e.message);
    }
  }
  log('Section clips on the arrangement: ' + created + ' of ' + item.sections.length);
  return created;
}

// Hot cues as short named MIDI clips on a Cues track, one per cue at its beat. Used when Live cannot take locators.
// The hot cues of a track (A to H). Memory cues are not turned into markers.
function hotCues(cues) {
  return (cues || []).filter(function (cue) {
    var beat = Number(cue.beat);
    return cue.letter && cue.letter !== 'Memory' && isFinite(beat) && beat >= 0;
  });
}

function createCueMarkers(song, item) {
  song.call('create_midi_track', -1);
  var trackIds = ids(song.get('tracks'));
  if (!trackIds.length) throw new Error('Live did not return a track for the cue markers.');
  var cueTrack = new LiveAPI(null, 'id ' + trackIds[trackIds.length - 1]);
  cueTrack.set('name', ('Cues · ' + clean(item.title)).slice(0, 60));
  var created = 0;
  var markers = hotCues(item.cues);
  for (var i = 0; i < markers.length; i++) {
    var cue = markers[i];
    var beat = Number(cue.beat);
    var label = String(cue.letter);
    try {
      cueTrack.call('create_midi_clip', beat, 0.25);
      var clipIds = ids(cueTrack.get('arrangement_clips'));
      if (clipIds.length) {
        new LiveAPI(null, 'id ' + clipIds[clipIds.length - 1]).set('name', label.slice(0, 60));
      }
      created++;
    } catch (e) {
      log('Notice: cue marker ' + (i + 1) + ': ' + e.message);
    }
  }
  log('Cue markers created: ' + created + ' on track "Cues · ' + clean(item.title) + '"');
  return created;
}

// Rekordbox's vocal sections, drawn as empty MIDI clips named "Vocal N" on a new MIDI track.
// The track that holds one clip per vocal region Rekordbox detects, and the colour of its clips.
var VOCAL_TRACK_NAME = 'Vocal Position';
var VOCAL_COLOR = 0x4695D0;

function createVocalClips(song, item) {
  song.call('create_midi_track', -1);
  var trackIds = ids(song.get('tracks'));
  if (!trackIds.length) throw new Error('Live did not return a track for the vocal clips.');
  var vocalTrack = new LiveAPI(null, 'id ' + trackIds[trackIds.length - 1]);
  vocalTrack.set('name', VOCAL_TRACK_NAME);
  var created = 0;
  for (var i = 0; i < item.vocalRegions.length; i++) {
    var region = item.vocalRegions[i];
    var start = Number(region.startBeat);
    var length = Number(region.endBeat) - start;
    if (!isFinite(start) || !isFinite(length) || length <= 0) continue;
    try {
      vocalTrack.call('create_midi_clip', start, length);
      var clipIds = ids(vocalTrack.get('arrangement_clips'));
      if (clipIds.length) {
        var clip = new LiveAPI(null, 'id ' + clipIds[clipIds.length - 1]);
        // Each vocal clip is named by the bar it starts on.
        clip.set('name', (Math.floor(start / 4) + 1) + ' ' + VOCAL_TRACK_NAME);
        try { clip.set('color', VOCAL_COLOR); } catch (_) {}
      }
      created++;
    } catch (e) {
      log('Notice: vocal clip ' + (i + 1) + ': ' + e.message);
    }
  }
  log('Vocal clips created: ' + created + ' on track "' + VOCAL_TRACK_NAME + '"');
  return created;
}

function clearWarpMarkers(clip) {
  try {
    var raw = clip.get('warp_markers');
    var jsonStr = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
    var startIdx = jsonStr.indexOf('{');
    if (startIdx === -1) return;
    var markers = JSON.parse(jsonStr.slice(startIdx)).warp_markers || [];
    for (var i = markers.length - 1; i >= 0; i--) {
      try {
        clip.call('remove_warp_marker', Number(markers[i].beat_time));
      } catch (_) {}
    }
  } catch (e) {
    log('Notice: clearing warp markers: ' + e.message);
  }
}

// Lock the Rekordbox grid to the file. Live keeps a marker just after beat 0 that blocks a new marker at beat 0,
// so anchor on beat 1 instead: the file's first beat plus one beat length. Every beat from 1 onward lines up.
// Then read the marker list back to check that the anchor is where it should be.
function setDownbeatMarker(clip, firstBeatSec, bpm) {
  clearWarpMarkers(clip);
  var anchorBeat = 1.0;
  var anchorSec = firstBeatSec + anchorBeat * 60.0 / bpm;
  try {
    clip.call('add_warp_marker', JSON.stringify({ beat_time: anchorBeat, sample_time: anchorSec }));
  } catch (_) {}
  var sample = warpMarkerSample(clip, anchorBeat);
  if (sample !== null && Math.abs(sample - anchorSec) < 0.002) {
    log('Grid anchor warp marker: beat 1.0 -> ' + anchorSec.toFixed(3) + 's');
    return true;
  }
  log('Notice: could not place the grid anchor marker at beat 1.0; the beatgrid may be off. Markers now: ' + String(clip.get('warp_markers')).slice(0, 400));
  return false;
}

// Beat times of the track's Rekordbox grid in ms, set for each import. Empty when the grid is not available.
var currentBeatMs = [];

// The warp markers on the clip as [{beat_time, sample_time}], read back from Live.
function readWarpMarkers(clip) {
  try {
    var raw = clip.get('warp_markers');
    var jsonStr = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
    var startIdx = jsonStr.indexOf('{');
    if (startIdx === -1) return [];
    return JSON.parse(jsonStr.slice(startIdx)).warp_markers || [];
  } catch (e) {
    log('Notice: reading warp markers: ' + e.message);
    return [];
  }
}

// Warp the clip to every beat of the Rekordbox grid, so each beat in the file sits on its beat in Live.
// Live keeps its own marker just after beat 0, and a marker at beat 0 would have to sit before it, so Live refuses it.
// Beat 0 is left to Live's start marker and beats 1 onward go on the file's beats. The count is read back from Live.
function applyRekordboxBeatgrid(clip, bpm, firstBeatMs, lengthMs) {
  if (currentBeatMs.length >= 2) {
    try { clip.set('warping', 1); } catch (_) {}
    clearWarpMarkers(clip);
    for (var i = 1; i < currentBeatMs.length; i++) {
      try { clip.call('add_warp_marker', JSON.stringify({ beat_time: i, sample_time: currentBeatMs[i] / 1000.0 })); } catch (_) {}
    }
    var markers = readWarpMarkers(clip);
    var placed = 0;
    for (var j = 0; j < markers.length; j++) {
      var beat = Number(markers[j].beat_time);
      if (beat >= 1 && beat < currentBeatMs.length && Math.abs(Number(markers[j].sample_time) - currentBeatMs[Math.round(beat)] / 1000.0) < 0.002) placed++;
    }
    log('Warp markers from the Rekordbox beat grid: ' + placed + ' of ' + (currentBeatMs.length - 1) + ' beats placed in Live');
    return;
  }
  log('Notice: no beat grid for this track; warping with the two anchors only');
  applyAnchorBeatgrid(clip, bpm, firstBeatMs, lengthMs);
}

// Fallback when no beat grid is available: two anchor markers (downbeat and tempo).
function applyAnchorBeatgrid(clip, bpm, firstBeatMs, lengthMs) {
  try {
    clip.set('warping', 1);
  } catch (_) {}

  var trackBpm = Number(bpm) || 120.0;
  var firstBeatSec = Math.max(0, Number(firstBeatMs || 0) / 1000.0);
  var totalSec = Math.max(1, Number(lengthMs || 180000) / 1000.0);
  var totalBeats = Math.max(4, Math.round((totalSec - firstBeatSec) * trackBpm / 60.0));

  log('Applying Rekordbox beatgrid: BPM=' + trackBpm + ', firstBeat=' + firstBeatSec.toFixed(3) + 's (' + firstBeatMs + 'ms), totalBeats=' + totalBeats);

  // Lock the Rekordbox beatgrid to the file
  setDownbeatMarker(clip, firstBeatSec, trackBpm);

  // Add tempo anchor marker
  try {
    var endSec = firstBeatSec + (totalBeats * 60.0 / trackBpm);
    var m2 = JSON.stringify({ beat_time: totalBeats, sample_time: endSec }).replace(/\s+/g, '');
    clip.call('add_warp_marker', m2);
    log('Added tempo anchor warp marker: beat ' + totalBeats + ' -> ' + endSec.toFixed(3) + 's');
  } catch (err2) {
    log('Notice: adding tempo anchor warp marker: ' + err2.message);
  }
}

// Run fn after ms milliseconds, on Max's scheduler. Live applies a playhead move only when the script yields, so
// anything that depends on the new playhead position has to run in a later step.
function later(ms, fn) {
  var task = new Task(fn, this);
  task.schedule(ms);
}

// Poll test every 25 ms until it passes or about a second has gone by. Calls back with whether it passed.
function awaitValue(test, callback) {
  var tries = 0;
  (function poll() {
    if (test()) return callback(true);
    tries++;
    if (tries > 40) return callback(false);
    later(25, poll);
  })();
}

// Time for Live to finish moving the playhead before set_or_delete_cue reads it. Measured in Live: 0 ms placed the
// cue at the previous position, 300 ms placed it exactly.
var SETTLE_MS = 300; // retries wait twice as long each time: 300, 600, then 1200 ms

// Live puts a new cue on the Arranger's grid, and the grid follows the zoom: at the zoom of a whole song it is 16 beats
// (the cue for beat 520 landed at 528, 100 at 96, 7 at 0), and every zoom-in step makes it finer (four steps: one bar).
// So when a cue lands off its beat, the Arranger is zoomed in one step and the cue is tried again. The steps are undone
// when all the locators are placed, so the view ends where the user had it. Measured in Live 12.3, 2026-10-16.
var MAX_ZOOM_STEPS = 16;
var ZOOM_IN = 3;
var ZOOM_OUT = 2;

function zoomArranger(direction) {
  try {
    new LiveAPI(null, 'live_app view').call('zoom_view', direction, 'Arranger', 0);
    return true;
  } catch (e) {
    log('Notice: zooming the Arranger: ' + e.message);
    return false;
  }
}

// Place a locator at each Rekordbox cue, one cue at a time. set_or_delete_cue toggles at the playhead, so a cue is
// added only after the playhead reads back at that beat. A cue that already sits there is left alone. If Live puts
// the new cue somewhere else, that stray is removed again and the cue is tried once more (zoomed in, see above).
// Calls done with the number of locators placed; the playhead and the zoom are put back where they were.
function createArrangementLocators(song, cues, done) {
  var list = hotCues(cues);
  var savedPlayhead = Number(song.get('current_song_time'));
  // With the loop on, a cue past the loop end can land at the loop end instead (seen with the cue at beat 520 and a
  // loop that ends at beat 512). Switch the loop off while the locators are placed, and put it back afterwards.
  var savedLoop = Number(song.get('loop'));
  var created = 0;
  var already = 0;
  var index = 0;
  log('Configuring ' + list.length + ' Arrangement locators (cue points)...');
  log('Timeline: song_length ' + song.get('song_length') + ' loop ' + savedLoop + ' loop_start ' + song.get('loop_start') +
      ' loop_end ' + song.get('loop_end') + ' playhead ' + savedPlayhead);
  if (savedLoop) {
    try { song.set('loop', 0); } catch (_) {}
  }

  var zoomSteps = 0;

  function finish() {
    var remaining = zoomSteps;
    zoomSteps = 0;
    if (remaining) log('Zooming the Arranger back out by ' + remaining + ' steps');
    (function zoomBack() {
      if (remaining <= 0) {
        try { song.set('current_song_time', savedPlayhead); } catch (_) {}
        if (savedLoop) {
          try { song.set('loop', 1); } catch (_) {}
        }
        done(created, already);
        return;
      }
      remaining--;
      zoomArranger(ZOOM_OUT);
      later(300, zoomBack);
    })();
  }

  function next() {
    if (index >= list.length) return finish();
    var cue = list[index];
    index++;
    var label = String(cue.letter);
    placeCue(Number(cue.beat), label, 1, function (ok) {
      if (ok) created++;
      next();
    });
  }

  function placeCue(beat, label, attempt, callback) {
    var before = cuePoints(song);
    if (cueAt(before, beat) !== null) {
      log('Locator already at beat ' + beat.toFixed(2) + '; left unchanged');
      already++;
      callback(false);
      return;
    }
    // Cues are compared by position, not by id: Live hands out new ids as cues change (seen with the cue at beat 0).
    var beforeTimes = before.map(function (point) { return point.time; });
    song.set('current_song_time', beat);
    awaitValue(function () {
      return Math.abs(Number(song.get('current_song_time')) - beat) < 0.01;
    }, function (moved) {
      if (!moved) {
        log('Notice: could not move the playhead to beat ' + beat.toFixed(2) + '; no locator added');
        callback(false);
        return;
      }
      // The playhead keeps moving for a moment after it reads back, so the toggle waits for it to settle.
      later(SETTLE_MS * Math.pow(2, attempt - 1), function () {
        log('Toggle at beat ' + beat.toFixed(3) + ' (attempt ' + attempt + '): playhead reads ' + JSON.stringify(song.get('current_song_time')) +
            ' loop ' + JSON.stringify(song.get('loop')) + ' cues ' + cuePoints(song).length);
        song.call('set_or_delete_cue');
        // The toggle either adds a cue, or deletes one that already sits on the grid point it landed on. Wait for
        // either change.
        awaitValue(function () {
          return !sameTimes(beforeTimes, cuePoints(song).map(function (point) { return point.time; }));
        }, function () {
          var afterPoints = cuePoints(song);
          var added = afterPoints.filter(function (point) {
            return !beforeTimes.some(function (t) { return Math.abs(t - point.time) < 0.01; });
          });
          var removed = before.filter(function (old) {
            return !afterPoints.some(function (point) { return Math.abs(point.time - old.time) < 0.01; });
          });
          var hit = added.filter(function (point) { return Math.abs(point.time - beat) < 0.05; })[0];
          if (hit) {
            hit.api.set('name', label);
            log('Created locator at beat ' + beat.toFixed(2) + ' ("' + label + '")');
            callback(true);
            return;
          }
          // The toggle landed elsewhere. If it deleted a cue that was already there, put that cue back (with its
          // name); if it added one, take that one out again. Then try again, zoomed in one more step.
          restoreCues(removed, 0, function () {
            removeStrays(added, 0, function () {
              if ((added.length || removed.length) && zoomSteps < MAX_ZOOM_STEPS && zoomArranger(ZOOM_IN)) {
                zoomSteps++;
                var at = (added[0] || removed[0]).time;
                log('Cue landed at beat ' + at.toFixed(2) + ' instead of ' + beat.toFixed(2) + '; zoomed the Arranger in (step ' + zoomSteps + ')');
                later(SETTLE_MS, function () { placeCue(beat, label, attempt, callback); });
              } else if (attempt < 3) {
                placeCue(beat, label, attempt + 1, callback);
              } else {
                log('Notice: no locator appeared at beat ' + beat.toFixed(2) + ' after ' + attempt + ' tries');
                callback(false);
              }
            });
          });
        });
      });
    });
  }

  // Put back cues that were there before and that a toggle deleted by landing on them, each with its name.
  function restoreCues(points, i, callback) {
    if (i >= points.length) return callback();
    var gone = points[i];
    song.set('current_song_time', gone.time);
    awaitValue(function () {
      return Math.abs(Number(song.get('current_song_time')) - gone.time) < 0.01;
    }, function () {
      later(SETTLE_MS, function () {
        song.call('set_or_delete_cue');
        awaitValue(function () {
          return cueAt(cuePoints(song), gone.time) !== null;
        }, function (back) {
          var found = cueAt(cuePoints(song), gone.time);
          if (found) {
            found.api.set('name', gone.name);
            log('Put back the cue "' + gone.name + '" at beat ' + gone.time.toFixed(2) + ' that the placement had deleted');
          }
          if (!back) log('Notice: could not put back the cue "' + gone.name + '" at beat ' + gone.time.toFixed(2));
          restoreCues(points, i + 1, callback);
        });
      });
    });
  }

  // Remove cues this import added by mistake, each at its own position.
  function removeStrays(points, i, callback) {
    if (i >= points.length) return callback();
    var stray = points[i];
    song.set('current_song_time', stray.time);
    awaitValue(function () {
      return Math.abs(Number(song.get('current_song_time')) - stray.time) < 0.01;
    }, function () {
      later(SETTLE_MS, function () {
        song.call('set_or_delete_cue');
        awaitValue(function () {
          return cuePoints(song).every(function (point) { return Math.abs(point.time - stray.time) > 0.01; });
        }, function () {
          log('Removed a stray locator at beat ' + stray.time.toFixed(2));
          removeStrays(points, i + 1, callback);
        });
      });
    });
  }

  next();
}

// Every cue point in the set, read fresh.
function cuePoints(song) {
  var out = [];
  var cueIds = ids(song.get('cue_points'));
  for (var k = 0; k < cueIds.length; k++) {
    var api = new LiveAPI(null, 'id ' + cueIds[k]);
    out.push({ id: cueIds[k], time: Number(api.get('time')), name: String(api.get('name')), api: api });
  }
  return out;
}

// Whether two lists of cue positions hold the same cues.
function sameTimes(a, b) {
  if (a.length !== b.length) return false;
  return a.every(function (t) { return b.some(function (u) { return Math.abs(u - t) < 0.01; }); });
}

// The cue point within a twentieth of a beat of this position, or null.
function cueAt(points, beat) {
  for (var i = 0; i < points.length; i++) {
    if (Math.abs(points[i].time - beat) < 0.05) return points[i];
  }
  return null;
}

function setClipMarkers(clip, startBeat, endBeat) {
  try { clip.set('looping', 0); } catch (_) {}
  try { clip.set('warping', 1); } catch (_) {}

  var s = Math.max(0, Number(startBeat) || 0);
  var e = Math.max(s + 0.25, Number(endBeat) || (s + 4));

  var curEnd = 0;
  var curStart = 0;
  try {
    var rawEnd = clip.get('end_marker');
    curEnd = Number(Array.isArray(rawEnd) ? rawEnd[0] : rawEnd) || 0;
    var rawStart = clip.get('start_marker');
    curStart = Number(Array.isArray(rawStart) ? rawStart[0] : rawStart) || 0;
  } catch (_) {}

  try {
    if (s >= curEnd) {
      clip.set('end_marker', e);
      clip.set('start_marker', s);
    } else if (e <= curStart) {
      clip.set('start_marker', s);
      clip.set('end_marker', e);
    } else {
      clip.set('end_marker', e);
      clip.set('start_marker', s);
    }
  } catch (err) {
    try {
      clip.set('start_marker', s);
      clip.set('end_marker', e);
    } catch (_) {}
  }

  try {
    clip.set('loop_start', s);
    clip.set('loop_end', e);
  } catch (_) {}
}

function ids(value) {
  var out = [];
  if (!value) return out;
  if (!Array.isArray(value)) value = [value];
  for (var i = 0; i < value.length; i++) {
    if (value[i] === 'id' && Number(value[i + 1]) > 0) { out.push(Number(value[i + 1])); i++; }
  }
  return out;
}

function clean(value) { return String(value || '').replace(/[\r\n]+/g, ' ').trim(); }

function report(ok, message, extra) {
  var payload = JSON.stringify({
    ok: !!ok,
    message: String(message),
    data: extra || {}
  });
  outlet(0, 'live_result', encodeURIComponent(payload));
}

function liveKey(raw) {
  var value = clean(raw).replace(/♯/g, '#').replace(/♭/g, 'b').trim();
  var openKey = /^(1[0-2]|[1-9])\s*([md])$/i.exec(value);
  if (openKey) {
    var converted = ((Number(openKey[1]) + 6) % 12) + 1;
    return liveKey(String(converted) + (openKey[2].toLowerCase() === 'm' ? 'A' : 'B'));
  }
  var camelot = /^(1[0-2]|[1-9])\s*([AB])$/i.exec(value);
  var minorRoots = [8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1];
  var majorRoots = [11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4];
  if (camelot) {
    var n = Number(camelot[1]) - 1;
    var minor = camelot[2].toUpperCase() === 'A';
    return { root: (minor ? minorRoots : majorRoots)[n], scale: minor ? 'Minor' : 'Major' };
  }
  var note = /^([A-Ga-g])\s*([#b]?)\s*(m|min|minor|maj|major)?$/i.exec(value);
  if (!note) return null;
  var names = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, FB: 4, 'E#': 5, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11, CB: 11 };
  var rootName = (note[1] + note[2]).toUpperCase();
  var scale = /^m(in(or)?)?$/i.test(note[3] || '') ? 'Minor' : 'Major';
  if (names[rootName] === undefined) return null;
  return { root: names[rootName], scale: scale };
}
