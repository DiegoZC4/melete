const {test} = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../template/system_annotations.js');

const element = (localName, children = [], attrs = {}, text = '') => ({
  localName, children, textContent: text || children.map(child => child.textContent).join(''),
  getAttribute: name => attrs[name] ?? null,
});
const value = (name, text) => element(name, [], {}, String(text));
const direction = (text, attrs = {}, extras = [], kind = 'words') => element('direction', [
  element('direction-type', [value(kind, text)]), ...extras,
], attrs);

test('only explicitly system-wide words and rehearsal headings follow visibility', () => {
  const document = {documentElement: element('score-partwise', [element('part', [element('measure', [
    element('attributes', [value('divisions', 4)]),
    direction('Intro', {}, [], 'rehearsal'),
    direction('breathe'),
    direction('Lightly', {system: 'only-top'}),
    element('note', [value('duration', 4)]),
    element('note', [element('chord'), value('duration', 4)]),
    element('note', [element('grace')]),
    direction('rit.', {system: 'only-top'}, [value('offset', 2)]),
    element('backup', [value('duration', 4)]),
    element('forward', [value('duration', 8)]),
    direction('listen', {system: 'also-top'}, [value('staff', 2)]),
    direction('\uECA7 = \uECA7', {system: 'only-top'}),
  ])])])};
  const marks = tools.fromXml(document);
  assert.deepEqual(marks.map(mark => [mark.bar, mark.at, mark.heading, mark.cue]), [
    [0, 0, 'Intro', ''], [0, 0, '', 'Lightly'], [0, 1.5, '', 'rit.'], [0, 2, '', 'listen'],
  ]);
  assert.equal(marks.at(-1).sources[0].staff, 1);
  assert.equal(marks.at(-1).sources[0].alsoTop, true);
});

test('duplicate system cues across parts are displayed once while retaining their source ownership', () => {
  const part = () => element('part', [element('measure', [direction('rit.', {system: 'only-top'})])]);
  const marks = tools.fromXml({documentElement: element('score-partwise', [part(), part()])});
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].sources.map(source => source.track), [0, 1]);
});
