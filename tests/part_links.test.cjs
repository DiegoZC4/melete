const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
function source(name) {
  const start = app.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}
const start = app.indexOf('  function choosePracticePart(');
const end = app.indexOf('  elements.partChooserOptions.addEventListener("click"');
assert.ok(start > 0 && end > start);
const chooserSource = app.slice(start, end);
const plain = value => JSON.parse(JSON.stringify(value));

const SEED = ['Soprano', 'Alto', 'Tenor', 'Bass'].flatMap(name => [1, 2].map(line => `${name} ${line}`));

// Every mix control throws: arriving with a part may only say who is singing.
function fixture({names = SEED, practicePart = null, divisi = {}, view = 'standard', visible, href} = {}) {
  const toasts = [], stored = new Map(), replaced = [], calls = [];
  let options = [];
  const forbidden = name => () => assert.fail(`${name} must not run when a part is chosen`);
  const element = (extra = {}) => ({hidden: true, textContent: '', contains: () => false,
    classList: {contains: () => false}, focus() {}, ...extra});
  const c = vm.createContext({
    URL,
    parts: names.map((name, index) => ({index, id: `P${index + 1}`, name,
      short: name.split(' ').map((word, i) => i ? word : word[0]).join(''), color: '#123456'})),
    partDivisi: names.map((_, index) => ({maxLines: divisi[index] || 1})),
    practicePartIndex: practicePart, practiceDivisi: names.map(() => null), selectedScorePartIndex: 4,
    scoreView: view, visibleTracks: new Set(visible || names.map((_, index) => index)),
    audibleTracks: new Set(names.map((_, index) => index)),
    trackVolumes: names.map((_, index) => 100 - index * 5), trackPans: names.map((_, index) => index * 10 - 40),
    partChooserKey: 'choir-practice:song:part-chooser', pendingPartLink: null,
    practicePartPager: {setValue: value => calls.push(['pager', value])},
    updateMixerAppearance: () => calls.push(['mixer']), updateNoteActionLabel() {},
    savePreferences: () => calls.push(['save']), renderPitchTrace() {}, scheduleBarRender: () => calls.push(['bars']),
    setPracticePart: forbidden('setPracticePart'), applyPracticeMix: forbidden('applyPracticeMix'),
    cyclePartVolumeMix: forbidden('cyclePartVolumeMix'), togglePartPanSeparation: forbidden('togglePartPanSeparation'),
    setTrackAudible: forbidden('setTrackAudible'), restorePracticeMix: forbidden('restorePracticeMix'),
    showToast: (message, state, action) => toasts.push({message, undo: action}),
    localStorage: {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value))},
    document: {activeElement: null, createElement: () => ({dataset: {}, style: {setProperty() {}}})},
    elements: {
      partChooser: element(), partChooserNote: element(), settingsPanel: element(), practicePart: element(),
      settingsToggle: element(),
      partChooserOptions: {replaceChildren: (...children) => { options = children; }},
    },
    window: {location: {href: href || 'https://example.test/song/'},
      history: {state: null, replaceState: (_state, _title, address) => replaced.push(address)}},
  });
  vm.runInContext(source('practiceDivisiOptions') + chooserSource, c);
  const mix = () => plain({volumes: c.trackVolumes, pans: c.trackPans, audible: [...c.audibleTracks]});
  return {c, toasts, stored, replaced, calls, mix,
    options: () => options.map(option => c.parts[Number(option.dataset.partIndex)].name),
    note: () => c.elements.partChooserNote.textContent};
}

test('part links read the query and the hash, the hash winning, and ignore other fields', () => {
  const {c} = fixture();
  assert.deepEqual(plain(c.partLinkFields('?part=Alto', '#part=S1&div=2')), {part: 'S1', div: '2'});
  assert.deepEqual(plain(c.partLinkFields('?PART=Soprano+1&song=the-seed', '#the-seed')), {part: 'Soprano 1'});
  assert.deepEqual(plain(c.partLinkFields('#part=Ten%C3%B3r&div=')), {part: 'Tenór', div: ''});
  assert.deepEqual(plain(c.partLinkFields('#part=%E0%A4%A&=x&div')), {part: '%E0%A4%A'}, 'malformed escapes stay literal');
  assert.deepEqual(plain(c.partLinkFields('', undefined, '#autumn')), {});
});

test('names match exactly first, then by a unique beginning, ignoring case, accents and spacing', () => {
  const {c} = fixture();
  assert.deepEqual(plain(c.partsForLink('A1')), [2]);
  assert.deepEqual(plain(c.partsForLink('alto-1')), [2]);
  assert.deepEqual(plain(c.partsForLink('  Bass 2 ')), [7]);
  assert.deepEqual(plain(c.partsForLink('p4')), [3], 'the score part id also names a part');
  assert.deepEqual(plain(c.partsForLink('Alto')), [2, 3], 'a divided part is offered, not guessed');
  assert.deepEqual(plain(c.partsForLink('sop')), [0, 1]);
  assert.deepEqual(plain(c.partsForLink('Mezzo')), []);
  assert.deepEqual(plain(c.partsForLink('')), []);
  const satb = fixture({names: ['Soprano', 'Alto', 'Ténor', 'Bass']}).c;
  assert.deepEqual(plain(satb.partsForLink('tenor')), [2]);
  assert.deepEqual(plain(satb.partsForLink('ten')), [2]);
  assert.deepEqual(plain(satb.partsForLink('S')), [0], 'an exact short name beats longer names that start with it');
});

test('divisi links name a line, all lines, or are reported as missing', () => {
  const {c} = fixture({divisi: {0: 2}});
  assert.deepEqual(plain(c.divisiForLink(0, '2')), {value: 1});
  assert.deepEqual(plain(c.divisiForLink(0, 'Div 1')), {value: 0});
  assert.deepEqual(plain(c.divisiForLink(0, 'all')), {value: null});
  assert.deepEqual(plain(c.divisiForLink(0, '3')), {missing: '3'});
  assert.deepEqual(plain(c.divisiForLink(1, '2')), {missing: '2'}, 'an undivided part has no lines to choose');
  assert.deepEqual(plain(c.divisiForLink(0, undefined)), {});
});

test('a first visit arriving with a part chooses it and leaves the whole mix alone', () => {
  const f = fixture();
  const before = f.mix();
  assert.equal(f.c.applyPartLink({part: 'A1'}), true);
  assert.equal(f.c.practicePartIndex, 2);
  assert.equal(f.c.selectedScorePartIndex, null);
  assert.deepEqual(f.mix(), before);
  assert.deepEqual(plain([...f.c.visibleTracks]), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(f.stored.get('choir-practice:song:part-chooser'), 'chosen');
  assert.deepEqual(f.toasts.map(toast => [toast.message, Boolean(toast.undo)]), [['Practising Alto 1', false]]);
  assert.deepEqual(f.calls.filter(call => call[0] === 'pager'), [['pager', 2]]);
  assert.ok(f.calls.some(call => call[0] === 'save'));
});

test('ambiguous and unknown links ask instead of guessing, and never change a chosen part', () => {
  const ambiguous = fixture();
  assert.equal(ambiguous.c.applyPartLink({part: 'Alto'}), true);
  assert.equal(ambiguous.c.practicePartIndex, null);
  assert.equal(ambiguous.c.elements.partChooser.hidden, false);
  assert.deepEqual(ambiguous.options(), ['Alto 1', 'Alto 2']);
  assert.equal(ambiguous.note(), 'The link’s “Alto” could be either of these.');
  assert.equal(ambiguous.stored.size, 0, 'nothing is remembered until the singer answers');
  const three = fixture({names: ['Bass 1', 'Bass 2', 'Bass 3']});
  three.c.applyPartLink({part: 'bass'});
  assert.equal(three.note(), 'The link’s “bass” could be any of these.');

  const unknown = fixture();
  unknown.c.applyPartLink({part: 'Mezzo'});
  assert.deepEqual(unknown.options(), SEED, 'a first visit is offered every part');
  assert.equal(unknown.note(), 'This song has no part called “Mezzo”.');

  const returning = fixture({practicePart: 5});
  const before = returning.mix();
  returning.c.applyPartLink({part: 'Mezzo'});
  returning.c.applyPartLink({part: 'Bass'});
  assert.equal(returning.c.practicePartIndex, 5);
  assert.equal(returning.toasts[0].message, 'This song has no part called “Mezzo”; still practising Tenor 2');
  assert.deepEqual(returning.options(), ['Bass 1', 'Bass 2']);
  assert.deepEqual(returning.mix(), before);
});

test('a returning singer can undo a link that changed their part', () => {
  const f = fixture({practicePart: 0, view: 'bars', visible: [0]});
  const before = f.mix();
  f.c.applyPartLink({part: 'B2'});
  assert.equal(f.c.practicePartIndex, 7);
  const [toast] = f.toasts;
  assert.equal(toast.message, 'Practising Bass 2 from the link (shown in pitchbar view)');
  assert.deepEqual(f.mix(), before);
  f.c.visibleTracks.add(7);
  toast.undo();
  assert.equal(f.c.practicePartIndex, 0);
  assert.deepEqual(plain([...f.c.visibleTracks]), [0], 'Undo also hides what the link revealed');
  assert.equal(f.toasts.at(-1).message, 'Practising Soprano 1');
  const same = fixture({practicePart: 3});
  same.c.applyPartLink({part: 'A2'});
  assert.deepEqual(same.toasts.map(t => [t.message, Boolean(t.undo)]), [['Practising Alto 2', false]]);
});

test('divisi links choose a line of the named or current part', () => {
  const f = fixture({divisi: {0: 2}});
  f.c.applyPartLink({part: 'S1', div: '2'});
  assert.equal(f.c.practiceDivisi[0], 1);
  assert.equal(f.toasts.at(-1).message, 'Practising Soprano 1 Div 2');
  f.c.applyPartLink({div: 'all'});
  assert.equal(f.c.practiceDivisi[0], null);
  assert.equal(f.toasts.at(-1).message, 'Practising Soprano 1 from the link');
  assert.equal(typeof f.toasts.at(-1).undo, 'function');
  f.c.applyPartLink({part: 'S1', div: '5'});
  assert.equal(f.toasts.at(-1).message, 'Soprano 1 has no Div 5; practising Soprano 1');
  const first = fixture({divisi: {0: 2}});
  assert.equal(first.c.applyPartLink({div: '2'}), false, 'a line without a part leaves the first-visit question');
  assert.equal(first.c.practicePartIndex, null);
});

test('links arriving before the parts are known wait for them', () => {
  const f = fixture({names: []});
  assert.equal(f.c.applyPartLink({part: 'Alto'}), true);
  assert.deepEqual(plain(f.c.pendingPartLink), {part: 'Alto'});
  assert.equal(f.c.applyPartLink({}), false);
  assert.equal(f.c.applyPartLink(null), false);
});

test('a followed link leaves the address, keeping every other field', () => {
  const f = fixture({href: 'https://example.test/song/?part=Alto&x=1#part=A1&div=2&keep=1'});
  f.c.consumePartLink();
  assert.deepEqual(f.replaced, ['https://example.test/song/?x=1#keep=1']);
  const only = fixture({href: 'https://example.test/song/#part=A1'});
  only.c.consumePartLink();
  assert.deepEqual(only.replaced, ['https://example.test/song/']);
  const opaque = fixture({href: 'about:srcdoc'});
  opaque.c.window.history.replaceState = () => { throw new Error('SecurityError'); };
  assert.doesNotThrow(() => opaque.c.consumePartLink());
});

test('the chooser needs two parts, remembers a dismissal and returns focus', () => {
  const single = fixture({names: ['Melody']});
  single.c.showPartChooser();
  assert.equal(single.c.elements.partChooser.hidden, true);
  const f = fixture();
  f.c.showPartChooser();
  assert.deepEqual(f.options(), SEED);
  assert.equal(f.note(), 'You can change it later in settings, under Practice.');
  let focused = null;
  f.c.elements.partChooser.contains = () => true;
  f.c.elements.settingsToggle.focus = () => { focused = 'settings'; };
  f.c.dismissPartChooser();
  assert.equal(f.c.elements.partChooser.hidden, true);
  assert.equal(f.stored.get('choir-practice:song:part-chooser'), 'dismissed');
  assert.equal(f.c.partChooserAnswered(), true);
  assert.equal(focused, 'settings', 'focus leaves the hidden card for the settings button');
  const blocked = fixture();
  blocked.c.localStorage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  assert.equal(blocked.c.partChooserAnswered(), false);
  assert.doesNotThrow(() => blocked.c.dismissPartChooser());
});
