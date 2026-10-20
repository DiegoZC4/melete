const assert = require('node:assert/strict');
const {test} = require('node:test');
const vm = require('node:vm');
const {TakeBuffer, wavBytes, WORKLET_SOURCE, MAX_LOOP_SECONDS, PcmCapture} = require('../template/loop_recorder.js');

test('three-pass storage includes the active pass and evicts only the oldest take', () => {
  const buffer = new TakeBuffer(100, 2);
  for (let pass = 0; pass < 6; pass++) {
    buffer.begin(pass * 200);
    buffer.append(pass * 200, new Float32Array(200).fill((pass + 1) / 10));
    assert.ok(buffer.takes.length <= 3);
    assert.ok(buffer.takes.reduce((sum, take) => sum + take.pcm.byteLength, 0) <= 3 * 200 * 2);
  }
  buffer.finish(1200, true);
  assert.deepEqual(buffer.takes.map(take => take.id), [4, 5, 6]);
  assert.ok(buffer.takes.every(take => buffer.info(take).complete));
  assert.equal(buffer.samples(buffer.takes[1])[0], Math.round(.5 * 32767));
});

test('frame routing splits asynchronous chunks at the actual loop boundary without mixing takes', () => {
  const buffer = new TakeBuffer(100, 1);
  buffer.append(0, new Float32Array(30).fill(.1));
  buffer.begin(20);
  buffer.append(30, new Float32Array(60).fill(.2));
  buffer.begin(120);
  buffer.append(90, new Float32Array(60).fill(.3));
  const first = buffer.takes[0];
  assert.equal(buffer.info(first).complete, true);
  assert.equal(buffer.samples(first).length, 100);
  assert.equal(buffer.samples(first)[0], Math.round(.1 * 32767));
  assert.equal(buffer.samples(first)[99], Math.round(.3 * 32767));
  assert.equal(buffer.samples(buffer.current).length, 30);
  buffer.append(150, new Float32Array(30).fill(.4));
  buffer.finish(180);
  assert.equal(buffer.info(buffer.takes[1]).complete, false);
  assert.equal(buffer.info(buffer.takes[1]).seconds, .6);
});

test('long scheduler delays cannot grow memory or turn missing input into a complete take', () => {
  const buffer = new TakeBuffer(100, 1);
  buffer.begin(0);
  buffer.append(0, new Float32Array(20).fill(.1));
  buffer.append(40, new Float32Array(1000).fill(.2));
  buffer.finish(1040, true);
  assert.equal(buffer.samples(buffer.takes[0]).length, 100);
  assert.equal(buffer.info(buffer.takes[0]).complete, false);
  assert.equal(buffer.info(buffer.takes[0]).gap, true);
  assert.equal(buffer.samples(buffer.takes[0])[21], 0);
  assert.throws(() => new TakeBuffer(48000, MAX_LOOP_SECONDS + 1));
  assert.throws(() => new TakeBuffer(48000, NaN));
});

test('stop preserves the tail delivered by flush, but excludes audio after stop', () => {
  const buffer = new TakeBuffer(48000, 2);
  buffer.begin(800);
  buffer.append(800, new Float32Array(2048).fill(.2));
  buffer.finish(3000);
  buffer.append(2848, new Float32Array(800).fill(.3));
  assert.equal(buffer.samples(buffer.takes[0]).length, 2200);
  assert.equal(buffer.samples(buffer.takes[0]).at(-1), Math.round(.3 * 32767));
  assert.equal(buffer.info(buffer.takes[0]).complete, false);
});

test('WAVs are independent mono little-endian PCM16 files with true sample rate and length', () => {
  const pcm = new Int16Array([-32768, -1234, 0, 32767]);
  const wav = Buffer.from(wavBytes(pcm, 48000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 96000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length * 2);
  pcm.forEach((sample, index) => assert.equal(wav.readInt16LE(44 + index * 2), sample));
});

test('worklet mixes input channels, timestamps arbitrary blocks, flushes once, and never monitors input', () => {
  const messages = [];
  const context = vm.createContext({Float32Array, currentFrame: 1000,
    AudioWorkletProcessor: class { constructor() { this.port = {postMessage: message => messages.push(message)}; } },
    registerProcessor: (name, processor) => { context.Processor = processor; },
  });
  vm.runInContext(WORKLET_SOURCE, context);
  const processor = new context.Processor();
  const output = [new Float32Array(256)];
  for (let i = 0; i < 10; i++) {
    context.currentFrame = 1000 + i * 256;
    assert.equal(processor.process([[new Float32Array(256).fill(.5), new Float32Array(256).fill(.1)]], [output]), true);
  }
  processor.port.onmessage({data: 'stop'});
  assert.equal(messages.length, 3);
  assert.equal(messages[0].frame, 1000);
  assert.equal(messages[1].frame, 3048);
  assert.equal(messages[1].samples.length, 512);
  assert.ok(Math.abs(messages[0].samples[0] - .3) < 1e-6);
  assert.equal(messages[2].stopped, true);
  assert.ok(output[0].every(value => value === 0));
  assert.equal(processor.process([[]]), false);
});

test('capture waits for real input frames before letting transport start, even if they are silent', async () => {
  const original = global.AudioWorkletNode;
  let node, connected = false;
  global.AudioWorkletNode = class {
    constructor() {
      node = this;
      this.port = {close() {}, postMessage: () => queueMicrotask(() => this.port.onmessage({data: {stopped: true}}))};
    }
    connect() {} disconnect() {}
  };
  try {
    const context = {destination: {}, audioWorklet: {addModule: async () => {}}};
    const source = {connect() { connected = true; }, disconnect() { connected = false; }};
    let ready = false, samples = 0;
    const pending = PcmCapture.create(context, source, (_frame, pcm) => { samples += pcm.length; }, assert.fail)
      .then(capture => { ready = true; return capture; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connected, true);
    assert.equal(ready, false, 'permission and graph construction are not microphone readiness');
    node.port.onmessage({data: {frame: 0, samples: new Float32Array(256), hasInput: false}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false, 'an inactive input does not start playback');
    node.port.onmessage({data: {frame: 256, samples: new Float32Array(2048), hasInput: true}});
    const capture = await pending;
    assert.equal(ready, true);
    assert.equal(samples, 2304);
    await capture.stop();
    assert.equal(connected, false);
  } finally { global.AudioWorkletNode = original; }
});

test('inactive input quanta retain silence and elapsed time instead of punching holes in a take', () => {
  const messages = [];
  const c = vm.createContext({Float32Array, currentFrame: 0,
    AudioWorkletProcessor: class { constructor() { this.port = {postMessage: message => messages.push(message)}; } },
    registerProcessor: (_name, processor) => { c.Processor = processor; },
  });
  vm.runInContext(WORKLET_SOURCE, c);
  const processor = new c.Processor();
  const output = [[new Float32Array(128)]];
  processor.process([[new Float32Array(128).fill(.5)]], output);
  c.currentFrame = 128;
  processor.process([[]], output);
  c.currentFrame = 256;
  processor.process([[new Float32Array(128).fill(.25)]], output);
  processor.port.onmessage({data: 'stop'});
  assert.equal(messages[0].samples.length, 384);
  assert.equal(messages[0].frame, 0);
  assert.equal(messages[0].hasInput, true);
  assert.ok(messages[0].samples.subarray(128, 256).every(value => value === 0));
  assert.ok(messages[0].samples.subarray(256).every(value => value === .25));
});
