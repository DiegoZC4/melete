const assert = require('node:assert/strict');
const {test} = require('node:test');
const {countInPlan, recordingEntrance, CountIn, TakeBuffer} = require('../template/loop_recorder.js');

const measures = Array.from({length: 24}, (_, i) => [i * 6720, 6720, 7, 4]);
const seconds = tick => tick / 960 * .5;
const start18 = measures[17][0], start19 = measures[18][0];
const planAt = (start, rate = 1) => countInPlan(measures, 960, start, seconds, rate);

test('Seed entrances count 5-6-7 into soprano pickups and the A2 downbeat, 1-2-3 into the others', () => {
  const sop = planAt(start18 + 6 * 960);
  assert.deepEqual(sop.beats.map(beat => beat.label), [5, 6, 7]);
  assert.deepEqual(sop.beats.map(beat => beat.seconds), [0, .5, 1]);
  assert.equal(sop.duration, 1); // Recording includes the eighth rest before "Let".
  const exactPickup = planAt(start18 + 6.5 * 960);
  assert.equal(exactPickup.duration, 1.25, 'fractional pickups do not get snapped to a beat');
  const alto = planAt(start19);
  assert.deepEqual(alto.beats.map(beat => beat.label), [5, 6, 7]);
  assert.equal(alto.duration, 1.5);
  const other = planAt(start19 + 2 * 960);
  assert.deepEqual(other.beats.map(beat => beat.label), [1, 2, 3]);
  assert.equal(other.beats[2].seconds, other.duration, '3 is the entry, not an extra beat before it');
  assert.equal(planAt(start19 + 2 * 960, .5).duration, 2);
});

test('general count-ins use written beats, pickups and tempo changes, including before score zero', () => {
  const bars = [[0, 3840, 4, 4], [3840, 2880, 6, 8]];
  const at = tick => tick <= 3840 ? tick / 960 : 4 + (tick - 3840) / 1920;
  const beginning = countInPlan(bars, 960, 0, at);
  assert.deepEqual(beginning.beats.map(beat => beat.label), [2, 3, 4]);
  assert.equal(beginning.duration, 3);
  const change = countInPlan(bars, 960, 4320, at);
  assert.deepEqual(change.beats.map(beat => beat.label), [4, 1, 2]);
  assert.deepEqual(change.beats.map(beat => beat.seconds), [0, 1, 1.25]);
  assert.equal(change.duration, 1.25);
});

test('authored entry overrides apply only to the matching audition, part and known start positions', () => {
  const addresses = {'19': start19, '24': measures[23][0], '18.7': start18 + 5760, '19.3': start19 + 1920};
  const addressTick = address => addresses[address] ?? null;
  const rules = [{loop: '19-24', parts: {S1: '18.7', S2: '18.7', A2: '19', B2: '19.3'}}];
  const range = {start: start19, end: measures[23][0]};
  assert.equal(recordingEntrance(rules, range, 'S1', addressTick), addresses['18.7']);
  assert.equal(recordingEntrance(rules, {...range, start: addresses['18.7']}, 'B2', addressTick), addresses['19.3']);
  assert.equal(recordingEntrance(rules, {...range, start: addresses['19.3']}, 'A2', addressTick), start19);
  assert.equal(recordingEntrance(rules, range, 'unknown', addressTick), start19);
  assert.equal(recordingEntrance(rules, {...range, end: range.end - 1}, 'S1', addressTick), start19);
  assert.equal(recordingEntrance(rules, {...range, start: start19 + 1}, 'S1', addressTick), start19 + 1);
  assert.equal(recordingEntrance([{loop: 'broken', parts: {S1: '18.7'}}], range, 'S1', addressTick), start19);
});

function clock() {
  let pending;
  const nodes = [];
  const context = {currentTime: 0, state: 'running',
    createOscillator() {
      const node = {frequency: {}, stopped: false, disconnected: false, connect: () => ({connect() {}}),
        start(at) { this.startAt = at; }, stop(at) { if (at === undefined) this.stopped = true; },
        disconnect() { this.disconnected = true; }};
      nodes.push(node);
      return node;
    },
    createGain() { return {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, disconnect() {}}; },
  };
  const timers = {setTimeout(callback) { pending = callback; return 1; }, clearTimeout() { pending = null; }};
  const advance = time => { context.currentTime = time; const callback = pending; pending = null; callback?.(); };
  return {context, timers, advance, nodes};
}

test('count-in clicks and numbers share the audio clock and resolve at the entrance', async () => {
  const c = clock(), shown = [];
  const count = new CountIn(c.context, {}, planAt(start19 + 1920), beat => shown.push(beat.label), c.timers);
  assert.deepEqual(c.nodes.map(node => node.startAt), [.12, .62, 1.12]);
  c.advance(.12); c.advance(.63);
  assert.deepEqual(shown, [1, 2]);
  c.advance(1.12);
  assert.equal(await count.done, true);
  assert.deepEqual(shown, [1, 2, 3]);
});

test('cancel or audio suspension cannot fire a late entrance, and cancel stops scheduled clicks', async () => {
  for (const suspend of [false, true]) {
    const c = clock(), shown = [];
    const count = new CountIn(c.context, {}, planAt(start19), beat => shown.push(beat.label), c.timers);
    c.advance(.12);
    if (suspend) { c.context.state = 'suspended'; c.advance(.2); }
    else count.cancel();
    assert.equal(await count.done, false);
    c.advance(10);
    assert.deepEqual(shown, [5]);
    assert.ok(c.nodes.every(node => node.stopped && node.disconnected));
  }
});

test('warming the microphone during count-in saves no take or pre-count audio', () => {
  const buffer = new TakeBuffer(100, 1);
  buffer.append(0, new Float32Array(120).fill(.8));
  assert.equal(buffer.takes.length, 0);
  buffer.begin(120);
  buffer.append(120, new Float32Array(100).fill(.2));
  buffer.finish(220, true);
  assert.equal(buffer.samples(buffer.takes[0]).length, 100);
  assert.ok(buffer.samples(buffer.takes[0]).every(sample => sample === Math.round(.2 * 32767)));
  assert.equal(buffer.info(buffer.takes[0]).complete, true);
});
