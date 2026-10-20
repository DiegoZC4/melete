const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {checkLocalTakeFailures} = require('./browser-local-takes.cjs');

const recordingProbe = `
  get takeStore() { return takeStore; },
  get recording() { return {state: takeState, notice: takeNotice, part: takeJournal?.spec.part,
    ready: takeLibraryReady, capacity: takeJournal?.buffer.passFrames || 0,
    sampleRate: takeJournal?.buffer.sampleRate || allTakes()[0]?.sampleRate || 0,
    takes: allTakes().reverse(),
    bytes: takeJournal?.buffer.takes.reduce((n, take) => n + take.pcm.byteLength, 0) || 0,
    microphone: pitchCaptureStream?.getAudioTracks()[0]?.enabled || false,
    pitch: pitchCaptureState}; },
`;

async function checkLoopRecorder(page, origin, settled, {mobile, output, temporary}) {
  await page.goto(origin + '?loop=1-1.3');
  await settled();
  await page.waitForFunction(() => __qa.engine.hasLoop() && __qa.recording.ready);
  if (await page.locator('#partChooser').isVisible()) await page.locator('#partChooserDismiss').click();
  assert.equal((await page.evaluate(() => __qa.recording)).state, 'off', 'URL never arms audio recording');
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#loopRecorder').click();
  assert.equal(await page.locator('#takePanel').isVisible(), true);
  await page.locator('#recordTake').click();
  try { await page.waitForFunction(() => __qa.recording.state === 'recording'); }
  catch (error) {
    console.error('Recorder start failure:', await page.evaluate(() => ({...__qa.recording, captureError: __qa.captureError,
      status: document.getElementById('takeStatus').textContent, secure: isSecureContext})));
    throw error;
  }
  assert.equal(await page.locator('#settingsToggle').evaluate(button => button.classList.contains('has-recording')), true);
  await page.waitForFunction(() => __qa.recording.takes.length >= 5 && __qa.recording.takes.at(-1)?.seconds > .2);
  await page.locator('#recordTake').click();
  await page.waitForFunction(() => __qa.recording.state === 'off');
  const result = await page.evaluate(() => __qa.recording);
  assert.ok(result.takes.length >= 5, 'no three-take limit');
  assert.ok(result.takes.slice(0, -1).every(take => take.complete), JSON.stringify(result));
  assert.equal(result.takes.at(-1).complete, false, 'interrupted pass is explicitly partial');
  assert.ok(result.takes.every(take => !take.unsaved));
  assert.ok(result.bytes <= result.capacity * 3 * 2);
  assert.equal(result.bytes, 0, 'saved takes do not retain PCM arrays in RAM');
  assert.equal(result.microphone, false, 'only recorder owned input, so Stop disables it');
  assert.equal(await page.locator('#settingsToggle').evaluate(button => button.classList.contains('has-recording')), false);
  const complete = result.takes[0];
  await page.getByRole('button', {name: `Listen to take ${complete.number}`, exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('#takePreview').paused && document.querySelector('#takePreview').readyState >= 2);
  assert.equal(await page.evaluate(() => __qa.engine.playing), false, 'preview cannot overlap guide playback');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#takePreview').evaluate(audio => audio.paused), true);
  assert.equal(await page.evaluate(() => __qa.engine.playing), false, 'Space controls an open take preview');
  const beforePreviewSeek = await page.evaluate(() => __qa.engine.currentSeconds());
  await page.locator('#takePreview').press('ArrowRight');
  assert.equal(await page.evaluate(() => __qa.engine.currentSeconds()), beforePreviewSeek, 'native audio keys do not seek the score');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: `Download take ${complete.number} as WAV`, exact: true}).click();
  const download = await pending;
  const filename = path.join(temporary, `loop-take-${mobile ? 'mobile' : 'desktop'}.wav`);
  await download.saveAs(filename);
  assert.match(download.suggestedFilename(), new RegExp(`take-${complete.number}\\.wav$`));
  const wav = await fs.readFile(filename);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), result.sampleRate);
  assert.equal(wav.readUInt32LE(40), complete.length * 2);
  const amplitude = frequency => {
    let re = 0, im = 0;
    for (let i = 0; i < complete.length; i++) {
      const sample = wav.readInt16LE(44 + i * 2) / 32768;
      const angle = 2 * Math.PI * frequency * i / result.sampleRate;
      re += sample * Math.cos(angle); im += sample * Math.sin(angle);
    }
    return 2 * Math.hypot(re, im) / complete.length;
  };
  const micAmplitude = amplitude(997), guideAmplitude = amplitude(523.251);
  assert.ok(micAmplitude > .05, `microphone signal present (${micAmplitude})`);
  assert.ok(guideAmplitude < .005, `score output not mixed into file (${guideAmplitude})`);
  await page.screenshot({path: path.join(output, `loop-recorder-${mobile ? 'mobile' : 'desktop'}.png`)});
  const bounds = await page.locator('#takePanel').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1);
  const panelAboveReturn = await page.evaluate(() => {
    const panel = document.getElementById('takePanel');
    const control = document.getElementById('playbackReturn');
    const style = control.getAttribute('style'), classes = control.className;
    const box = panel.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    try {
      control.classList.add('is-visible');
      control.style.cssText = `position:fixed;left:${x - 20}px;top:${y - 20}px;right:auto;bottom:auto;transform:none;opacity:1;visibility:visible`;
      return panel.contains(document.elementFromPoint(x, y));
    } finally {
      if (style === null) control.removeAttribute('style'); else control.setAttribute('style', style);
      control.className = classes;
    }
  });
  assert.equal(panelAboveReturn, true, 'floating score controls cannot cover take review');

  await page.getByRole('button', {name: `Favorite take ${complete.number}`, exact: true}).click();
  await page.waitForFunction(id => __qa.recording.takes.find(take => take.id === id)?.favorite, complete.id);
  await page.reload(); await settled();
  await page.waitForFunction(() => __qa.recording.ready);
  const restored = await page.evaluate(() => __qa.recording);
  assert.equal(restored.takes.length, result.takes.length);
  assert.equal(restored.takes[0].favorite, true, 'favorites survive reload');
  assert.equal(restored.bytes, 0, 'restoring a library loads metadata, not every audio file');
  assert.equal(restored.state, 'off');
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#loopRecorder').click();
  const restoredAudio = await page.evaluate(async id => Array.from(new Uint8Array(await (await __qa.takeStore.wav(id)).arrayBuffer())), complete.id);
  assert.deepEqual(Buffer.from(restoredAudio), wav, 'reloaded WAV is byte-identical');
  await page.locator('#takeFavorites').click();
  assert.equal(await page.locator('.take-row').count(), 1);
  assert.equal(await page.getByRole('button', {name: `Delete take ${complete.number}`, exact: true}).isDisabled(), true);
  await page.locator('#takeFavorites').click();
  const unwanted = restored.takes[1];
  await page.getByRole('button', {name: `Delete take ${unwanted.number}`, exact: true}).click();
  await page.waitForFunction(id => !__qa.recording.takes.some(take => take.id === id), unwanted.id);

  // Sing and audio recording own separate branches of a single input stream.
  await page.locator('#closeTakes').click();
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#pitchCapture').click();
  await page.waitForFunction(() => __qa.recording.pitch === 'armed');
  await page.locator('#loopRecorder').click();
  await page.locator('#recordTake').click();
  await page.waitForFunction(() => __qa.recording.state === 'recording');
  await page.locator('#closeTakes').click();
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#pitchCapture').click();
  assert.equal((await page.evaluate(() => __qa.recording)).microphone, true, 'Sing off leaves recording input live');
  await page.waitForFunction(() => __qa.recording.takes.at(-1)?.seconds > .35);
  await page.locator('#pitchCapture').click();
  await page.waitForFunction(() => __qa.recording.pitch === 'recording');
  await page.locator('#loopRecorder').click();
  await page.locator('#recordTake').click();
  await page.waitForFunction(() => __qa.recording.state === 'off');
  assert.equal((await page.evaluate(() => __qa.recording)).microphone, true, 'recorder off leaves Sing input live');
  await page.locator('#closeTakes').click();
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#pitchCapture').click();

  // Transport edits retain the interrupted take rather than silently splicing.
  await page.locator('#loopRecorder').click();
  for (const operation of ['rate', 'seek', 'loop']) {
    await page.locator('#recordTake').click();
    await page.waitForFunction(() => __qa.recording.state === 'recording');
    await page.waitForFunction(() => __qa.recording.takes.at(-1)?.seconds > .12);
    await page.evaluate(operation => {
      if (operation === 'rate') __qa.api.playbackSpeed = .9;
      if (operation === 'seek') __qa.engine.seek(__qa.engine.loopEndSeconds + .2);
      if (operation === 'loop') __qa.engine.setLoop(0, 960);
    }, operation);
    await page.waitForFunction(() => __qa.recording.state === 'off');
    assert.equal((await page.evaluate(() => __qa.recording)).takes.at(-1).complete, false);
    assert.equal(await page.evaluate(() => __qa.engine.playing), false);
  }
  // Hold-clear also works from the keyboard and never starts a new recording.
  await page.locator('#recordTake').press('Delete');
  await page.locator('#cancelTakeDelete').click();
  assert.ok((await page.evaluate(() => __qa.recording)).takes.length > 1);
  await page.locator('#recordTake').press('Delete');
  await page.locator('#confirmTakeDelete').click();
  await page.waitForFunction(() => __qa.recording.takes.length === 1);
  await page.reload(); await settled();
  await page.waitForFunction(() => __qa.recording.ready);
  assert.equal((await page.evaluate(() => __qa.recording)).state, 'off');
  assert.equal((await page.evaluate(() => __qa.recording)).takes.length, 1, 'cleanup keeps starred audio');
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.locator('#loopRecorder').click();
  await page.evaluate(() => {
    window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test denial', 'NotAllowedError'); };
  });
  await page.locator('#recordTake').click();
  await page.waitForFunction(() => __qa.recording.state === 'off' && __qa.recording.notice === 'Microphone access was blocked');
  assert.equal(await page.evaluate(() => __qa.engine.playing), false);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = constraints => new Promise(resolve => {
      window.grantLateMicrophone = async () => resolve(await realGetUserMedia(constraints));
    });
  });
  await page.locator('#recordTake').click();
  await page.waitForFunction(() => Boolean(window.grantLateMicrophone));
  await page.locator('#recordTake').click();
  await page.evaluate(() => grantLateMicrophone());
  await page.waitForFunction(() => __qa.recording.state === 'off');
  assert.equal((await page.evaluate(() => __qa.recording)).microphone, false, 'late permission cannot restart a canceled take');
  assert.equal((await page.evaluate(() => __qa.recording)).takes.length, 1);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = realGetUserMedia; });
  await page.locator('#closeTakes').click();
  const localStorage = await checkLocalTakeFailures(page, origin, settled, {mobile, output, temporary});
  return {retained: result.takes.map(({number, complete}) => ({number, complete})), micAmplitude, guideAmplitude,
    boundedBytes: result.bytes, wavBytes: wav.length, independentMicrophoneOwners: true, transportEdits: 3,
    deniedPermission: true, canceledPermission: true, reloadExactAudio: true, favoritesAndDeletion: true, localStorage};
}

module.exports = {recordingProbe, checkLoopRecorder};
