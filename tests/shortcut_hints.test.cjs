const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const trackerSource = app.slice(app.indexOf('  class ShortcutHintTracker {'), app.indexOf('  const shortcutHints ='));
const Tracker = vm.runInNewContext(`${trackerSource}\nShortcutHintTracker`);
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(stored = []) {
  let time = 0;
  const writes = [];
  const tracker = new Tracker({ now: () => time, read: () => stored, write: (value) => writes.push(plain(value)) });
  return { tracker, writes, advance(ms) { time += ms; } };
}

function isolate(tracker, row = 'hear') {
  assert.equal(tracker.toggle(row, 0, [true,true,true,true], [false,true,true,true]), null);
  assert.equal(tracker.toggle(row, 2, [false,true,true,true], [false,true,false,true]), null);
  return tracker.toggle(row, 3, [false,true,false,true], [false,true,false,false]);
}

test('several quick off-toggles ending in one part suggest isolation', () => {
  for (const row of ['see', 'hear']) {
    const { tracker } = fixture();
    assert.deepEqual(plain(isolate(tracker, row)), { id:'isolate', row, part:1, input:'mouse' });
  }
});

test('single toggles and ordinary mixes never suggest isolation', () => {
  const { tracker } = fixture();
  assert.equal(tracker.toggle('see', 0, [true,true], [false,true]), null);
  assert.equal(tracker.toggle('hear', 0, [true,true,true,true], [false,true,true,true]), null);
  assert.equal(tracker.toggle('hear', 1, [false,true,true,true], [false,false,true,true]), null);
  assert.equal(tracker.toggle('hear', 0, [false,false,true,true], [true,false,true,true]), null);
  assert.equal(tracker.toggle('hear', 2, [true,false,true,true], [true,false,false,true]), null);
});

test('slow toggles, other rows and intervening bulk changes cannot combine', () => {
  const { tracker, advance } = fixture();
  tracker.toggle('see', 0, [true,true,true], [false,true,true]);
  advance(3001);
  assert.equal(tracker.toggle('see', 1, [false,true,true], [false,false,true]), null);
  tracker.toggle('hear', 0, [true,true,true], [false,true,true]);
  assert.equal(tracker.toggle('see', 1, [true,true,true], [true,false,true]), null);
  assert.equal(tracker.toggle('hear', 1, [true,true,true], [true,false,true]), null);
});

test('two manually restored controls suggest one row reset', () => {
  const { tracker, advance } = fixture();
  assert.equal(tracker.adjust('vol', 0, 65, 100, 100), null);
  advance(7000);
  assert.deepEqual(plain(tracker.adjust('vol', 2, 130, 100, 100, 'touch')),
    { id:'reset-row', row:'vol', parts:[0,2], input:'touch' });
});

test('reset detection uses configured defaults, not assumed 100/center', () => {
  const { tracker } = fixture();
  assert.equal(tracker.adjust('pan', 0, -70, -25, -25), null);
  assert.deepEqual(plain(tracker.adjust('pan', 1, 30, 40, 40)).parts, [0,1]);
});

test('normal mixing, single-control fiddling, no-ops and slow resets stay quiet', () => {
  const { tracker, advance } = fixture();
  for (let i = 0; i < 5; i++) assert.equal(tracker.adjust('pan', 0, -20, 0, 0), null);
  assert.equal(tracker.adjust('pan', 1, 50, 20, 0), null);
  assert.equal(tracker.adjust('vol', 1, 100, 100, 100), null);
  advance(8001);
  assert.equal(tracker.adjust('pan', 2, 10, 0, 0), null);
});

test('changing a restored control away from default removes that evidence', () => {
  const { tracker } = fixture();
  tracker.adjust('vol', 0, 50, 100, 100);
  tracker.adjust('vol', 0, 100, 105, 100);
  assert.equal(tracker.adjust('vol', 1, 50, 100, 100), null);
});

test('once shown, a shortcut stays quiet across rows and page reloads', () => {
  const { tracker, writes } = fixture();
  assert.ok(isolate(tracker));
  assert.equal(tracker.shown('isolate'), true);
  assert.equal(tracker.shown('isolate'), false);
  assert.equal(isolate(tracker, 'see'), null);
  assert.equal(isolate(fixture(writes.at(-1)).tracker), null);
});

test('using a shortcut first suppresses advice without needing a popup', () => {
  const { tracker } = fixture();
  tracker.learn('isolate');
  tracker.learn('reset-row');
  assert.equal(isolate(tracker), null);
  tracker.adjust('pan', 0, -20, 0, 0);
  assert.equal(tracker.adjust('pan', 1, 20, 0, 0), null);
});

test('different tips are separated by at least a minute', () => {
  const { tracker, advance } = fixture();
  tracker.shown('isolate');
  assert.equal(tracker.eligible('reset-row'), false);
  advance(60000);
  assert.equal(tracker.eligible('reset-row'), true);
});

test('corrupt or blocked local storage does not affect practice controls', () => {
  const tracker = new Tracker({ read() { throw Error('blocked'); }, write() { throw Error('blocked'); } });
  assert.doesNotThrow(() => tracker.learn('isolate'));
  assert.equal(tracker.eligible('isolate'), false);
  assert.equal(fixture({ bad: true }).tracker.eligible('isolate'), true);
  assert.equal(fixture(['bogus']).tracker.eligible('isolate'), true);
});

class Button {
  constructor(value) {
    this.dataset = { value:String(value) };
    this.listeners = new Map();
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)};
  }
  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(type, properties = {}) {
    this.dispatchEvent({ type, preventDefault() {}, ...properties });
  }
  dispatchEvent(event) { (this.listeners.get(event.type) || []).forEach(fn => fn(event)); }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; this.emit('lostpointercapture'); }
}

const controlRuntime = (globals = {}) => vm.runInNewContext(`
  const PAN_VALUES = Array.from({length:41}, (_, i) => i * 5 - 100);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const nearestAllowed = (value, values) => values.reduce((a,b) => Math.abs(b-value)<Math.abs(a-value) ? b : a);
  ${app.slice(app.indexOf('  function createDragNumber('), app.indexOf('  class InfinitePager'))}
  ({createDragNumber, createPanRing});
`, { Event, document:{createElement:()=>({})}, addDragAffordance(){}, ...globals });
const controls = controlRuntime();

function holdFixture({pan = false} = {}) {
  let time = 0, next = 0, held = 0, manual = 0;
  const timers = new Map();
  const events = new Map();
  const runtime = controlRuntime({performance: {now: () => time}, window: {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, {fn, at: time + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { events.set(name, fn); },
  }});
  const button = new Button(100);
  const control = runtime[pan ? 'createPanRing' : 'createDragNumber'](button, {
    name: 'Tenor',
    values: Array.from({length: 31}, (_, i) => i * 5), defaultValue: 100, pixelsPerStep: 4,
    format: String, aria: String, onHold() { held++; control.setValue(20, false); },
    onManualChange() { manual++; },
  });
  return {button, control, held: () => held, manual: () => manual,
    windowEvent(name, event = {}) { events.get(name)?.(event); },
    down(type = 'mouse') { button.emit('pointerdown', {button: 0, pointerId: 1, clientX: 100, clientY: 100, pointerType: type}); },
    advance(ms) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
  };
}

test('volume hold fires once, freezes that drag and has a keyboard equivalent', () => {
  const f = holdFixture();
  f.down(); f.advance(599); assert.equal(f.held(), 0);
  f.advance(1); assert.equal(f.held(), 1);
  f.advance(1000); assert.equal(f.held(), 1);
  f.button.emit('pointermove', {pointerId: 1, clientX: 100, clientY: 80});
  f.button.emit('pointerup', {pointerId: 1});
  assert.equal(f.control.value(), 20, 'movement after holding cannot undo the mix');
  assert.equal(f.manual(), 0, 'a hold is not reported as a manual volume edit');
  f.button.emit('keydown', {key: 'Enter', shiftKey: true});
  f.button.emit('keydown', {key: 'Enter', shiftKey: true, repeat: true});
  assert.equal(f.held(), 2);
});

test('pan hold fires once, shows progress, freezes dragging and supports Shift+Enter', () => {
  const f = holdFixture({pan: true});
  f.down(); f.advance(250);
  assert.equal(f.button.classList.contains('is-holding'), true);
  f.advance(349); assert.equal(f.held(), 0);
  f.advance(1); assert.equal(f.held(), 1);
  assert.equal(f.button.classList.contains('is-holding'), false);
  f.advance(1000); assert.equal(f.held(), 1);
  f.button.emit('pointermove', {pointerId: 1, clientX: 40, clientY: 100});
  f.button.emit('pointerup', {pointerId: 1});
  assert.equal(f.control.value(), 20);
  assert.equal(f.manual(), 0);
  let suppressed = 0;
  f.button.emit('click', {stopImmediatePropagation() { suppressed++; }});
  assert.equal(suppressed, 1);
  f.button.emit('keydown', {key: 'Enter', shiftKey: true});
  f.button.emit('keydown', {key: 'Enter', shiftKey: true, repeat: true});
  assert.equal(f.held(), 2);
});

test('pan holds cancel on drag, vertical scroll movement, release, lost capture and reset', () => {
  for (const [event, properties] of [
    ['pointermove', {clientX: 96, clientY: 100}],
    ['pointermove', {clientX: 100, clientY: 110}],
    ['pointerup', {}], ['pointercancel', {}], ['lostpointercapture', {}],
    ['keydown', {key: 'Escape'}], ['keydown', {key: 'F10', shiftKey: true}],
    ['contextmenu', {pointerType: 'mouse'}],
  ]) {
    const f = holdFixture({pan: true}); f.down();
    f.button.emit(event, {pointerId: 1, ...properties});
    f.advance(1000);
    assert.equal(f.held(), 0, `${event} ${JSON.stringify(properties)}`);
    assert.equal(f.button.classList.contains('is-holding'), false);
  }
  for (const [event, properties] of [['blur', {}], ['scroll', {}], ['pointerdown', {pointerId: 2}]]) {
    const f = holdFixture({pan: true}); f.down();
    f.windowEvent(event, properties); f.advance(1000);
    assert.equal(f.held(), 0, event);
  }
});

test('touch pan holds suppress context-menu reset before and after release', () => {
  const f = holdFixture({pan: true}); let suppressed = 0;
  const context = () => f.button.emit('contextmenu', {pointerType: 'touch', stopImmediatePropagation() { suppressed++; }});
  f.down('touch'); f.advance(500); context();
  f.advance(100); f.button.emit('pointerup', {pointerId: 1}); context();
  assert.equal(suppressed, 2);
  assert.equal(f.held(), 1);
  assert.equal(f.control.value(), 20);
});

test('pan no-ops do not emit input and ordinary drags return to their starting value', () => {
  const f = holdFixture({pan: true}); let changes = 0;
  f.button.addEventListener('input', () => changes++);
  f.down();
  f.button.emit('pointermove', {pointerId: 1, clientX: 100, clientY: 100});
  f.control.setValue(100);
  assert.equal(changes, 0);
  f.button.emit('pointermove', {pointerId: 1, clientX: 80, clientY: 100});
  assert.equal(f.control.value(), 75);
  f.button.emit('pointermove', {pointerId: 1, clientX: 100, clientY: 100});
  assert.equal(f.control.value(), 100);
  f.advance(1000); assert.equal(f.held(), 0);
  assert.equal(changes, 2);
});

test('drags, short clicks, cancellation and capture loss cannot become volume holds', () => {
  for (const [event, properties] of [
    ['pointermove', {clientX: 100, clientY: 96}],
    ['pointermove', {clientX: 110, clientY: 100}],
    ['pointerup', {}], ['pointercancel', {}], ['lostpointercapture', {}],
    ['keydown', {key: 'Escape'}], ['keydown', {key: 'F10', shiftKey: true}],
    ['contextmenu', {pointerType: 'mouse'}],
  ]) {
    const f = holdFixture(); f.down();
    f.button.emit(event, {pointerId: 1, ...properties});
    f.advance(1000);
    assert.equal(f.held(), 0, `${event} ${JSON.stringify(properties)}`);
  }
});

test('a touch volume hold suppresses the native context menu without invoking reset', () => {
  const f = holdFixture(); let suppressed = 0;
  f.down('touch'); f.advance(650);
  f.button.emit('contextmenu', {pointerType: 'touch', stopImmediatePropagation() { suppressed++; }});
  f.button.emit('pointerup', {pointerId: 1});
  assert.equal(suppressed, 1);
  assert.equal(f.held(), 1);
  assert.equal(f.control.value(), 20);
});

test('a long volume drag counts once, not once per input event', () => {
  const button = new Button(50);
  const calls = [];
  const control = controls.createDragNumber(button, {
    values:Array.from({length:31}, (_,i) => i*5), defaultValue:100, pixelsPerStep:4,
    format:String, aria:String, onManualChange:(...args) => calls.push(args),
  });
  button.emit('pointerdown', {button:0, pointerId:1, clientY:100});
  for (let y = 99; y >= 60; y--) button.emit('pointermove', {pointerId:1, clientY:y});
  assert.equal(calls.length, 0);
  button.emit('pointerup', {pointerId:1, pointerType:'mouse'});
  assert.deepEqual(calls, [[50,100,'mouse']]);
  control.setValue(70);
  button.emit('dblclick');
  assert.equal(calls.length, 1, 'programmatic changes and existing shortcuts are not slow input');
});

test('pan gestures track completion, ignore cancellations and preserve keyboard input', () => {
  const button = new Button(-50);
  const calls = [];
  controls.createPanRing(button, {name:'Alto', defaultValue:0, onManualChange:(...args) => calls.push(args)});
  button.emit('pointerdown', {button:0, pointerId:1, clientX:0});
  button.emit('pointermove', {pointerId:1, clientX:40});
  button.emit('pointerup', {pointerId:1, pointerType:'touch'});
  assert.deepEqual(calls, [[-50,0,'touch']]);
  button.emit('pointerdown', {button:0, pointerId:2, clientX:0});
  button.emit('pointermove', {pointerId:2, clientX:4});
  button.emit('pointercancel', {pointerId:2});
  assert.equal(calls.length, 1);
  button.emit('keydown', {key:'ArrowLeft'});
  assert.deepEqual(calls.at(-1), [5,0,'keyboard']);
  button.emit('keydown', {key:'0'});
  assert.equal(calls.length, 2);
});

test('Escape dismisses only the visible tip, leaving the settings panel open', () => {
  let hidden = false;
  let prevented = 0;
  let stopped = 0;
  const source = app.slice(app.indexOf('  function shortcutTipKeydown('),
    app.indexOf('  document.addEventListener("keydown", shortcutTipKeydown'));
  const handler = vm.runInNewContext(`${source}\nshortcutTipKeydown`, {
    elements:{shortcutTip:{get hidden() { return hidden; }, contains:() => false}},
    hideShortcutTip() { hidden = true; },
  });
  const escape = { key:'Escape', preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
  handler(escape);
  assert.equal(hidden, true);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  handler(escape);
  assert.equal(stopped, 1, 'a second Escape can reach the normal settings handler');
});
