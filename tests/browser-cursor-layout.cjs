const assert = require('node:assert/strict');

async function checkCursorEdges(page, qaName = '__qa') {
  const cases = await page.evaluate(name => {
    const {api} = window[name], beats = api.tracks[0].staves[0].bars.flatMap(bar => bar.voices[0].beats);
    return [...beats.filter(beat => !beat.isRest).slice(0, 3), ...beats.filter(beat => beat.isRest).slice(0, 2)]
      .map(beat => ({bar: beat.voice.bar.index, index: beat.index, tick: beat.absolutePlaybackStart, rest: beat.isRest}));
  }, qaName);
  const results = [];
  for (const entry of cases) {
    await page.evaluate(({name, entry}) => {
      const {api, engine} = window[name];
      const master = api.boundsLookup.findMasterBarByIndex(entry.bar);
      scrollTo(0, document.querySelector('#score').getBoundingClientRect().top + scrollY + master.realBounds.y - 100);
      engine.seek(engine.secondsAtTick(entry.tick));
    }, {name: qaName, entry});
    await page.waitForTimeout(80);
    const result = await page.evaluate(({name, entry}) => {
      const {api} = window[name], lookup = api.boundsLookup;
      const beat = api.tracks[0].staves[0].bars[entry.bar].voices[0].beats[entry.index];
      const bounds = lookup.findBeat(beat), score = document.querySelector('#score');
      const candidates = [];
      for (const track of api.tracks) for (const staff of track.staves) for (const voice of staff.bars[entry.bar].voices)
        for (const other of voice.beats) if (other.absoluteDisplayStart === beat.absoluteDisplayStart && !other.isRest)
          for (const note of lookup.findBeat(other)?.notes || []) candidates.push(note.noteHeadBounds.x);
      let expected = candidates.length ? Math.min(...candidates) : null;
      if (expected === null) {
        const glyph = [...score.querySelectorAll(`.b${beat.id} text`)]
          .find(el => /^[\uE4E1-\uE4EB]$/u.test(el.textContent));
        if (!glyph) throw new Error(`No rendered rest at m${entry.bar + 1}`);
        expected = glyph.getBoundingClientRect().left - score.getBoundingClientRect().left + score.scrollLeft;
      }
      const cursor = score.querySelector('.at-cursor-beat').getBoundingClientRect();
      return {...entry, expected, actual: cursor.left + cursor.width / 2 - score.getBoundingClientRect().left + score.scrollLeft,
        center: bounds.onNotesX};
    }, {name: qaName, entry});
    assert.ok(Math.abs(result.actual - result.expected) < 0.6, `cursor left edge: ${JSON.stringify(result)}`);
    results.push(result);
  }
  return results;
}
module.exports = {checkCursorEdges};
