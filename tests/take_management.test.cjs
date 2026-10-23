const assert = require('node:assert/strict');
const {test} = require('node:test');
const {takeBytes, takeFilename, takeArchive, DELETE_UNDO_MS, STORAGE_WARNING_BYTES, wavBytes} = require('../template/loop_recorder.js');
const zip = require('../vendor/fflate/fflate.js');

test('take storage warning counts PCM bytes without loading audio', () => {
  assert.equal(DELETE_UNDO_MS, 10000);
  assert.equal(STORAGE_WARNING_BYTES, 250 * 1024 * 1024);
  assert.equal(takeBytes([{frames: 48000}, {length: 16000, frames: 8000}]), 128000);
});

test('favorite archive retains independent byte-identical WAVs and descriptive names', async () => {
  const takes = [1, 2].map(number => ({number, frames: 4, part: 'Bass 2', label: '19.3-24',
    rate: 1, complete: number === 1, createdAt: 12345}));
  const wav = new Blob([wavBytes(new Int16Array([1, -2, 3, -4]), 48000)], {type: 'audio/wav'});
  const progress = [], reads = [];
  const archive = await takeArchive(takes, 'The Seed', async take => { reads.push(take.number); return wav; }, zip,
    (done, total) => progress.push([done, total]));
  assert.equal(archive.type, 'application/zip');
  const files = zip.unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ['The-Seed-Bass-2-m19.3-24-100pct-take-1.wav',
    'The-Seed-Bass-2-m19.3-24-100pct-take-2-partial.wav']);
  for (const audio of Object.values(files)) assert.deepEqual(audio, new Uint8Array(await wav.arrayBuffer()));
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.ok(!takeFilename('../test/path', takes[0]).includes('/'));
});

test('archive failure returns no misleading partial ZIP and leaves sources alone', async () => {
  await assert.rejects(takeArchive([], 'test', () => {}, zip), /No favorites/);
  await assert.rejects(takeArchive([{frames: 0x80000000}], 'test', () => { throw new Error('must not read'); }, zip), /too large/);
  const take = {number: 1, frames: 4};
  await assert.rejects(takeArchive([take], 'test', async () => { throw new Error('read failure'); }, zip), /read failure/);
  assert.deepEqual(take, {number: 1, frames: 4});
});
