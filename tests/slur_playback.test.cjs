const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'template/app.js'), 'utf8');
const guide = app.slice(app.indexOf('  class GuideEngine {'), app.indexOf('  function createSvgElement('));
const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

class Param {
  value = 1;
  events = [];
  setValueAtTime(value, time) { this.events.push(['set', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.events.push(['exp', value, time]); }
  linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  setTargetAtTime(value, time, constant) { this.events.push(['target', value, time, constant]); }
}
class Node {
  frequency = new Param(); detune = new Param(); gain = new Param(); Q = new Param();
  starts = []; stops = [];
  connect(destination) { return destination; }
  setPeriodicWave() {}
  addEventListener() {}
  start(time) { this.starts.push(time); }
  stop(time) { this.stops.push(time); }
}
class Audio {
  currentTime = 10;
  state = 'running';
  nodes = [];
  create(kind) { const node = new Node(); node.kind = kind; this.nodes.push(node); return node; }
  createOscillator() { return this.create('oscillator'); }
  createGain() { return this.create('gain'); }
  createBiquadFilter() { return this.create('filter'); }
}
const data = {
  division:960, endTick:3840, tempos:[[0,60]], measures:[[0,3840,4,4]], parts:[{}],
  notes:[[0,0,960,60,60],[0,960,1920,62,85],[0,1920,2880,64,80],[0,2880,3840,65,80]],
  legato:[[0,1,2]],
};
function engine(sequence = data) {
  const c = vm.createContext({config:{}, parts:sequence.parts, clamp:(v,lo,hi)=>Math.max(lo,Math.min(hi,v)),
    window: {clearInterval() {}, setInterval() { return 1; }},
    SCHEDULER_INTERVAL_MS:40, SCHEDULER_LEAD_SECONDS:.028, SCHEDULER_HORIZON_SECONDS:.34,
    showToast: message => assert.fail(message)});
  vm.runInContext(guide + '\nglobalThis.Engine = GuideEngine;', c);
  const e = new c.Engine(sequence);
  e.context = new Audio(); e.master = new Node(); e.wave = {};
  return e;
}

test('MusicXML slurs survive MIDI extraction, including ties and independent divisi', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'melete-slurs-'));
  try {
    const playback = path.join(directory, 'playback.json'), metadata = path.join(directory, 'metadata.json');
    execFileSync(process.execPath, [path.join(root, 'extract_score.mjs'),
      '--score',path.join(__dirname,'fixtures/slurs.musicxml'),'--playback',playback,'--metadata',metadata]);
    const p = JSON.parse(fs.readFileSync(playback)), m = JSON.parse(fs.readFileSync(metadata));
    const chains = p.legato.map(chain=>chain.map(index=>p.notes[index]));
    assert.deepEqual(chains.map(chain=>chain.map(n=>n[3])), [[60,62,64],[62,64],[60,62],[64,65],[60,60]]);
    assert.equal(chains[0][1][2] - chains[0][1][1], 1920, 'tie remains one sustained event');
    assert.equal(chains[1][0][1], 5760, 'rest breaks the phrase');
    assert.ok(chains.flat().every(n=>n[3]>=60), 'unslurred second voice remains separate');
    assert.equal(m.counts.legato, 5);
    assert.deepEqual(m.warnings, []);
  } finally { fs.rmSync(directory, {recursive:true,force:true}); }
});

test('joining slurs preserves every note, and rejects malformed or disconnected chains', () => {
  const e = engine();
  assert.equal(e.notes.length, 2);
  assert.equal(e.notes[0].segments.length, 3);
  assert.deepEqual(plain(e.notes.flatMap(n=>n.segments||[n]).map(n=>n.key)), [60,62,64,65]);
  for (const legato of [[[0,0]], [[0,9]], [[0,2]], [[2,1]], [[0,1],[0,1]]]) {
    const notes = engine({...data,legato}).notes.flatMap(n=>n.segments||[n]);
    assert.equal(notes.length, 4, JSON.stringify(legato));
  }
  const e2 = engine({...data,notes:[[0,0,960,60,60],[1,960,1920,62,85]],legato:[[0,1]]});
  assert.ok(e2.notes.every(n=>!n.segments), 'never connect different singers');
});

for (const rate of [.5,1,1.5,2]) test(`one continuous oscillator with 3 ms on-time glides at ${rate}x`, () => {
  const e = engine(); e.rate = rate;
  e.scheduleNote(e.notes[0], 0, .028);
  assert.equal(e.scheduled.size, 1);
  assert.equal(e.context.nodes.filter(n=>n.kind==='oscillator').length, 2, 'one carrier plus vibrato for whole phrase');
  const voice = [...e.scheduled][0];
  const changes = voice.oscillator.frequency.events.filter(event=>event[0]==='exp');
  assert.equal(changes.length, 2);
  for (const [i,change] of changes.entries()) {
    near(change[2], 10+(i+1)/rate);
    near(change[1], 440 * 2 ** ((data.notes[i+1][3]-69)/12));
    const anchor = voice.oscillator.frequency.events.find(event=>event[0]==='set' && Math.abs(event[2]-(change[2]-.003))<1e-9);
    assert.ok(anchor, 'glide duration is 3 ms, not scaled with practice speed');
  }
  assert.equal(voice.envelope.gain.events.filter(e=>e[0]==='set'&&e[1]===.0001).length, 1);
  assert.equal(voice.envelope.gain.events.filter(e=>e[0]==='exp').length, 2, 'one attack and one release');
  assert.ok(voice.envelope.gain.events.filter(e=>e[0]==='linear').every(e=>e[1]>.01), 'dynamics stay above zero between notes');
  near(voice.oscillator.stops[0], 10+3/rate+.01);
});

test('written tempo changes position the glide at the performed onset', () => {
  const e = engine({...data,tempos:[[0,60],[960,120]]});
  e.scheduleNote(e.notes[0], 0, .028);
  assert.deepEqual(plain([...e.scheduled][0].oscillator.frequency.events.filter(e=>e[0]==='exp').map(e=>e[2])), [11,11.5]);
});

test('seeking to every slurred onset sounds that note exactly once, never its predecessor', () => {
  for (const position of [0,1,2,2.0000001]) for (const carryHeldNotes of [false,true]) {
    const e = engine(); e.playing = true; e.basePosition = position; e.anchorTime = 10;
    e.resetScheduler(.028, {carryHeldNotes});
    assert.equal(e.scheduled.size,1);
    near([...e.scheduled][0].oscillator.frequency.events[0][1],440*2**((data.notes[Math.floor(position)][3]-69)/12));
    e.scheduleAhead();
    assert.equal(e.scheduled.size,1,'next scheduler pass cannot restart the phrase');
  }
});

test('loop ends clip the phrase and omit later glides; restart sounds the new first note', () => {
  const e = engine(); e.loopStartSeconds = 1; e.loopEndSeconds = 1.5;
  e.scheduleNote(e.notes[0], 1, .028);
  const voice = [...e.scheduled][0];
  near(voice.oscillator.frequency.events[0][1],440*2**((62-69)/12));
  assert.equal(voice.oscillator.frequency.events.filter(e=>e[0]==='exp').length,0);
  near(voice.oscillator.stops[0],10.51);
});

test('separate syllables still articulate separately without changing held-note start policy', () => {
  const e = engine({...data,legato:[]});
  assert.equal(e.notes.length,4);
  e.playing=true; e.basePosition=.5; e.anchorTime=10;
  e.resetScheduler();
  assert.equal(e.scheduled.size,0);
  e.resetScheduler(.028,{carryHeldNotes:true});
  assert.equal(e.scheduled.size,1);
});

test('shared transport waits for slow audio activation without consuming the first note', async () => {
  const e = engine();
  let wake, calls = 0, playback;
  const pending = new Promise(resolve => { wake = resolve; });
  e.context.state = 'suspended';
  e.context.resume = async () => { calls++; await pending; e.context.state = 'running'; };
  let starts = 0;
  e.api = {play() { starts++; playback = e.play(); }, pause() {}};
  const starting = e.startTransport();
  assert.equal(calls, 1);
  assert.equal(starts, 0);
  e.context.currentTime += 4;
  assert.equal(e.currentSeconds(), 0);
  assert.equal(e.scheduled.size, 0);
  wake(); await starting; await playback;
  assert.equal(starts, 1);
  assert.equal(e.scheduled.size, 1);
  near([...e.scheduled][0].oscillator.starts[0], 14.028);
  e.pauseTransport();
});

test('canceling cold startup cannot start playback after audio finally wakes', async () => {
  const e = engine();
  let wake, starts = 0;
  const pending = new Promise(resolve => { wake = resolve; });
  e.context.state = 'suspended';
  e.context.resume = async () => { await pending; e.context.state = 'running'; };
  e.api = {play() { starts++; }, pause() {}};
  const starting = e.startTransport();
  e.pauseTransport(); wake(); await starting;
  assert.equal(starts, 0);
  assert.equal(e.playing, false);
  assert.equal(e.scheduled.size, 0);
});

test('every generic onset survives seek rounding at multiple rates, paused or running', async () => {
  for (const legato of [data.legato, []]) for (const rate of [.5,1,1.5]) {
    for (const running of [false,true]) for (const onset of [0,1,2,3]) for (const drift of [0,.0000005]) {
      const e = engine({...data, legato}); e.rate = rate;
      if (running) await e.play();
      e.seek(onset + drift);
      if (!running) await e.play();
      assert.equal(e.scheduled.size, 1, `${rate}x, onset ${onset}, drift ${drift}, running ${running}`);
      near([...e.scheduled][0].oscillator.frequency.events[0][1], 440*2**((data.notes[onset][3]-69)/12));
      e.scheduleAhead();
      assert.equal(e.scheduled.size, 1, 'no duplicate after the next scheduler pass');
      e.pause();
    }
  }
});
