const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = app.indexOf('  function observePlaybackCursor(');
const source = app.slice(start < 0 ? app.indexOf('  function trimPlaybackCursor(') : start,
  app.indexOf('  function cancelVerticalFollowAnimation('));

function fixture() {
  const frames = [], observers = [];
  let writes = 0, pending = false;
  const rect = (top, height, width = 300) => ({top, bottom: top + height, height, width});
  const cursor = () => {
    const values = new Map();
    return {bounds: rect(100, 80),
      style: {getPropertyValue: key => values.get(key) || '', setProperty: (key, value) => {
        values.set(key, value); writes++; pending = true;
      }}, getBoundingClientRect() { return this.bounds; }};
  };
  let bar = cursor(), beat = cursor();
  let lines = [110, 119, 129, 139, 149];
  const surface = {getBoundingClientRect: () => rect(0, 1500),
    querySelectorAll: () => lines.map(y => ({getAttribute: () => '#a5a5a5', getBoundingClientRect: () => rect(y, 1)}))};
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push(target); assert.deepEqual(Array.from(options.attributeFilter), ['style']); }
    disconnect() { this.targets = []; }
  }
  const context = vm.createContext({scoreView: 'standard', cursorTrimFrame: 0, cursorTrimBurstGeneration: 0,
    cursorTrimObserver: null, cursorTrimTargets: [], MutationObserver: Observer,
    clamp: (n, min, max) => Math.max(min, Math.min(max, n)),
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    elements: {score: {querySelector: selector => selector === '.at-cursor-bar' ? bar : beat,
      querySelectorAll: () => [surface]}}});
  vm.runInContext(source + '\nglobalThis.trim = trimPlaybackCursor; globalThis.schedule = scheduleCursorTrim;', context);
  function flushMutations() {
    let count = 0;
    while (pending) {
      assert.ok(count++ < 5, 'cursor clipping must not observe itself indefinitely');
      pending = false;
      for (const observer of observers) if (observer.targets.length) observer.callback([]);
    }
  }
  return {context, observers, flushMutations,
    frame() { frames.splice(0).forEach(fn => fn()); flushMutations(); },
    geometry(top, height, nextLines) {
      bar.bounds = beat.bounds = rect(top, height); lines = nextLines; pending = true;
    },
    replace() { bar = cursor(); beat = cursor(); },
    visible(cursor) {
      const bounds = cursor.bounds;
      const top = parseFloat(cursor.style.getPropertyValue('--cursor-clip-top')) || 0;
      const bottom = parseFloat(cursor.style.getPropertyValue('--cursor-clip-bottom')) || 0;
      return [bounds.top + bounds.height * top / 100, bounds.bottom - bounds.height * bottom / 100];
    }, get bar() { return bar; }, get beat() { return beat; }, get writes() { return writes; }};
}

for (const [description, top, height, lines] of [
  ['showing more parts', 100, 220, [110, 119, 129, 139, 149, 230, 242, 254, 266, 278]],
  ['a different system after hiding parts', 500, 110, [530, 539, 549, 559, 569]],
]) test(`the first paused seek corrects cursor height after ${description}`, () => {
  const f = fixture();
  f.context.trim(); f.flushMutations();
  // The position event runs our scheduled trim before AlphaTab's nested frame
  // finally places its cursors. No subsequent seek or playback tick follows.
  f.context.schedule(); f.frame();
  f.geometry(top, height, lines); f.flushMutations();
  for (const cursor of [f.bar, f.beat]) {
    const [actualTop, actualBottom] = f.visible(cursor);
    assert.ok(Math.abs(actualTop - lines[0]) < 1e-6);
    assert.ok(Math.abs(actualBottom - (lines.at(-1) + 1)) < 1e-6,
      `${description}: bottom ${actualBottom} should be ${lines.at(-1) + 1}`);
  }
});

test('repeated trims are idle and replacement cursor nodes disconnect the old observer', () => {
  const f = fixture();
  f.context.trim(); f.flushMutations();
  const writes = f.writes;
  for (let i = 0; i < 10; i++) { f.context.trim(); f.flushMutations(); }
  assert.equal(f.writes, writes);
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].targets.length, 2);
  f.replace(); f.context.trim(); f.flushMutations();
  assert.equal(f.observers.length, 2);
  assert.equal(f.observers[0].targets.length, 0);
  assert.deepEqual(f.observers[1].targets, [f.bar, f.beat]);
  f.context.scoreView = 'bars';
  const last = f.writes;
  f.geometry(100, 220, [120, 210]); f.flushMutations();
  assert.equal(f.writes, last, 'pitchbar view does not recrop hidden notation');
});
