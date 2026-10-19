const assert = require('node:assert/strict');

async function checkMeasureRests(page, measure, expectedCount) {
  // The renderer attaches SVG after renderFinished; centering settles over eight frames.
  await page.evaluate(() => new Promise(resolve => {
    let frames = 10;
    const next = () => --frames ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  }));
  const rests = await page.evaluate(measure => {
    const score = document.querySelector('#score');
    const origin = score.getBoundingClientRect().left - score.scrollLeft;
    const bounds = __qa.api.boundsLookup.findMasterBarByIndex(measure - 1);
    return (bounds?.bars || []).flatMap(bar => bar.beats.filter(b => b.beat.isFullBarRest && !b.beat.isEmpty).map(b => {
      const glyph = [...score.querySelectorAll(`.b${b.beat.id} text`)].find(text => text.textContent === '\uE4E3');
      if (!glyph) return {id:b.beat.id, missing:true};
      const rect = glyph.getBoundingClientRect();
      return {id:b.beat.id, left:rect.left - origin, right:rect.right - origin,
        expected:b.realBounds.x + b.realBounds.w / 2, start:b.realBounds.x, end:b.realBounds.x + b.realBounds.w};
    }));
  }, measure);
  assert.equal(rests.length, expectedCount, `m${measure}: expected full-measure rests`);
  for (const rest of rests) {
    assert.ok(!rest.missing, `m${measure}: rest glyph ${rest.id} missing`);
    assert.ok(Math.abs((rest.left + rest.right) / 2 - rest.expected) < .25,
      `m${measure}: rest must center in the post-signature span: ${JSON.stringify(rest)}`);
    assert.ok(rest.left >= rest.start && rest.right <= rest.end,
      `m${measure}: rest must clear the opening symbols and closing barline: ${JSON.stringify(rest)}`);
  }
  return rests;
}

module.exports = {checkMeasureRests};
