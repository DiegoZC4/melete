const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
function source(name) {
  const start = app.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}

function fixture() {
  let requests = 0, resolveRequest;
  const calls = [];
  const track = {enabled: false, readyState: 'live', addEventListener() {}};
  const stream = {getAudioTracks: () => [track]};
  const audio = {state: 'suspended', addEventListener() {}, resume: async function() { this.state = 'running'; },
    suspend: async function() { this.state = 'suspended'; },
    createAnalyser: () => ({}), createMediaStreamSource: () => ({
      connect(target) { calls.push(['connect', target]); }, disconnect(target) { calls.push(['disconnect', target]); },
    })};
  const output = {state: 'suspended', addEventListener() {}, resume: async function() { this.state = 'running'; }};
  const c = vm.createContext({
    pitchCaptureState: 'off', takeState: 'off', microphoneRequest: null,
    pitchCaptureContext: null, pitchCaptureStream: null, pitchCaptureSource: null,
    pitchCaptureAnalyser: null, pitchCaptureDetector: null, pitchCaptureBuffer: null,
    pitchCaptureRequestGeneration: 0, playing: false,
    PITCH_CAPTURE_BUFFER_SIZE: 4096, Float32Array, console,
    navigator: {mediaDevices: {getUserMedia() { requests++; return new Promise(resolve => { resolveRequest = resolve; }); }}},
    engine: {playbackIsolated: false, context: output, ensureAudio() {}},
    window: {AudioContext: function() { return audio; }, Pitchy: {PitchDetector: {forFloat32Array: () => ({})}}},
    pitchCaptureSupported: () => true, savePreferences() {}, updatePitchCaptureAppearance() {}, showToast() {},
    stopPitchSampling() {}, startPitchSampling() {}, beginPitchCapturePass() {},
  });
  for (const name of ['syncMicrophoneActivity', 'ensureMicrophoneInput', 'disablePitchCapture',
    'activateCachedPitchCapture', 'startPitchCapture']) vm.runInContext(source(name), c);
  return {c, track, audio, calls, requests: () => requests, permit: () => resolveRequest(stream)};
}

test('simultaneous Sing and recorder requests share one microphone permission and stream', async () => {
  const f = fixture();
  f.c.takeState = 'requesting';
  const recorder = f.c.ensureMicrophoneInput();
  const sing = f.c.startPitchCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests(), 1);
  f.permit();
  await recorder; await sing;
  assert.notEqual(f.c.pitchCaptureContext, f.c.engine.context, 'input stays outside the synthesis graph');
  assert.equal(f.c.pitchCaptureState, 'armed');
  assert.equal(f.track.enabled, true);
  f.c.takeState = 'recording';
  f.c.disablePitchCapture(false);
  assert.equal(f.track.enabled, true);
  assert.equal(f.calls.at(-1)[1], f.c.pitchCaptureAnalyser, 'only the pitch branch disconnects');
  f.c.takeState = 'off';
  f.c.syncMicrophoneActivity();
  assert.equal(f.track.enabled, false);
  await f.c.startPitchCapture();
  assert.equal(f.requests(), 1, 'cached input does not prompt again');
  assert.equal(f.track.enabled, true);
});

test('canceling a pending permission request cannot activate input after the late grant', async () => {
  const f = fixture();
  const pending = f.c.startPitchCapture();
  await new Promise(resolve => setImmediate(resolve));
  f.c.disablePitchCapture(false);
  f.permit();
  await pending;
  assert.equal(f.c.pitchCaptureState, 'off');
  assert.equal(f.track.enabled, false);
  assert.equal(f.calls.filter(([kind]) => kind === 'connect').length, 0);
});

test('releasing the recorder does not suspend the separate microphone context used by Sing', async () => {
  const f = fixture();
  await f.audio.resume();
  f.c.pitchCaptureContext = f.audio;
  f.c.engine.context = {};
  f.c.pitchCaptureState = 'armed';
  f.c.takeState = 'off';
  f.c.syncMicrophoneActivity();
  assert.equal(f.audio.state, 'running');
  f.c.disablePitchCapture(false);
  assert.equal(f.audio.state, 'suspended');
});
