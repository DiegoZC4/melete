const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = app.indexOf('  function installNotationFormatting(');
const installer = app.slice(start, app.indexOf('\n  }', start) + 4);

test('tempo glyphs round display values without changing native playback automation', () => {
  const marks = [126.000126000126, 83.99998320000336, 28.0000028, 84.5, 64.3125]
    .map((value, i) => ({value, isVisible: i !== 4, ratioPosition: i / 10, text: 'cue'}));
  const before = JSON.stringify(marks);
  const master = {tempoAutomations: marks};
  const bar = {get masterBar() { return master; }};
  const beat = {voice: {bar}, index: 0};
  const effect = {
    notationElement: 33,
    createNewGlyph(renderer, receivedBeat) {
      assert.equal(this, effect);
      assert.equal(receivedBeat.index, 0);
      assert.equal(renderer, 'native renderer');
      return receivedBeat.voice.bar.masterBar.tempoAutomations.filter(mark => mark.isVisible);
    },
  };
  const band = {effect};
  const window = {alphaTab: {
    NotationElement: {EffectTempo: 33, EffectMarker: 20, EffectChordNames: 21},
    Environment: {defaultRenderers: [{effectBands: [band]}, {effectBands: [band]}]},
  }};
  vm.runInNewContext(installer + '\ninstallNotationFormatting(); installNotationFormatting();', {window});
  const display = effect.createNewGlyph('native renderer', beat);
  assert.deepEqual(Array.from(display, mark => mark.value), [126, 84, 28, 84.5]);
  assert.deepEqual(Array.from(display, mark => mark.ratioPosition), [0, .1, .2, .3]);
  assert(display.every(mark => mark.text === 'cue'));
  assert.equal(JSON.stringify(marks), before);
  assert.equal(beat.voice.bar.masterBar, master);
  assert.equal(master.tempoAutomations, marks);
});

test('section headings and chords reserve separate effect lanes', () => {
  const effects = [20, 21, 22].map(notationElement => ({notationElement, canShareBand: true}));
  const window = {alphaTab: {
    NotationElement: {EffectTempo: 33, EffectMarker: 20, EffectChordNames: 21},
    Environment: {defaultRenderers: [{effectBands: effects.map(effect => ({effect}))}]},
  }};
  vm.runInNewContext(installer + '\ninstallNotationFormatting();', {window});
  assert.deepEqual(effects.map(effect => effect.canShareBand), [false, false, true]);
});

test('section headings have upright bold type and a padded rounded frame on every layout', () => {
  const alpha = require('../vendor/alphatab/alphaTab.min.js');
  const calls = [];
  const effect = {notationElement: alpha.NotationElement.EffectMarker, createNewGlyph: () => ({
    font: new alpha.model.Font('Arial', 12), x: 10, y: 20,
    doLayout() {this.width = 40; this.height = 18;},
    paint(x, y) {calls.push(['text', x, y]);},
  })};
  const window = {alphaTab: {...alpha, Environment: {defaultRenderers: [{effectBands: [{effect}]}]}}};
  vm.runInNewContext(installer + '\ninstallNotationFormatting(); installNotationFormatting();', {window});
  const glyph = effect.createNewGlyph();
  glyph.doLayout(); glyph.doLayout();
  assert.equal(glyph.font.weight, alpha.model.FontWeight.Bold);
  assert.equal(glyph.font.style, alpha.model.FontStyle.Plain);
  assert.equal(glyph.font.size, 18);
  assert.deepEqual([glyph.width, glyph.height], [52, 26]);
  const canvas = {lineWidth: 2};
  for (const name of ['beginGroup', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'stroke', 'endGroup'])
    canvas[name] = (...args) => calls.push([name, ...args]);
  glyph.paint(100, 200, canvas);
  assert.equal(calls.filter(c => c[0] === 'quadraticCurveTo').length, 4);
  assert.deepEqual(calls.find(c => c[0] === 'text'), ['text', 106, 204]);
  assert.equal(canvas.lineWidth, 2);
});
