// Silent strips may be culled by Chrome, leaving AudioParam.value stale even
// while the context clock advances. A subaudible carrier keeps this probe live.
async function withMixerSignal(surface, probe, check) {
  await surface.evaluate(probe => {
    const engine = window[probe].engine, source = engine.context.createOscillator();
    const level = engine.context.createGain();
    level.gain.value = .000001;
    source.connect(level);
    engine.trackStrips.forEach(strip => level.connect(strip.gain));
    source.start();
    window.__mixerSignal = {source, level};
  }, probe);
  try { return await check(); }
  finally {
    await surface.evaluate(() => {
      __mixerSignal.source.stop();
      __mixerSignal.source.disconnect();
      __mixerSignal.level.disconnect();
      delete window.__mixerSignal;
    });
  }
}

module.exports = {withMixerSignal};
