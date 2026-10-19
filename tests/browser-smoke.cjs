// Starts an isolated browser and cleans its build on exit. Use heavy-run where installed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.GUI_QA_NODE_MODULES
  ? path.join(process.env.GUI_QA_NODE_MODULES, 'playwright') : 'playwright');
const {checkMeasureRests} = require('./browser-rest-layout.cjs');
const {checkCursorEdges} = require('./browser-cursor-layout.cjs');
const {checkPanHolds} = require('./browser-pan-hold.cjs');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'melete-shared-smoke-'));
  let browser;
  const results = [], errors = [], requests = [];
  try {
    const project = path.join(temporary, 'player');
    execFileSync(process.env.PYTHON || 'python3', [path.resolve(__dirname, '../build_trainer.py'),
      path.join(__dirname, 'fixtures/shared-regressions.musicxml'), '--project-dir', project], {stdio: 'pipe'});
    let html = await fs.readFile(path.join(project, 'dist/index.html'), 'utf8');
    const marker = 'engine = new GuideEngine(sequence);';
    assert.equal(html.split(marker).length, 2);
    html = html.replace(marker, marker + `
      window.__qa = {engine, api, onsets: [], get busy() { return notationRenderInFlight || notationRenderQueued; }};
      const scheduleNote = engine.scheduleNote;
      engine.scheduleNote = function(note, ...args) {
        const before = this.scheduled.size;
        const result = scheduleNote.call(this, note, ...args);
        if (this.scheduled.size > before) __qa.onsets.push({start: note.start, track: note.track, key: note.key});
        return result;
      };
    `);
    browser = await chromium.launch({channel: process.env.QA_BROWSER_CHANNEL || undefined, headless: true});
    const origin = 'http://127.0.0.1:8809/shared-regression-fixture';
    const output = path.resolve(__dirname, '../qa');
    await fs.mkdir(output, {recursive: true});
    for (const mobile of [false, true]) {
      const context = await browser.newContext({viewport: mobile ? {width:393,height:852} : {width:1440,height:900},
        isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, colorScheme: 'dark'});
      try {
        await context.route('**/*', route => {
          if (route.request().url() === origin) return route.fulfill({contentType: 'text/html', body: html});
          requests.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        const settled = () => page.waitForFunction(() => window.__qa && !__qa.busy &&
          document.querySelector('#playPause:not(:disabled)') && document.querySelector('#score svg'));
        await page.goto(origin);
        await settled();
        assert.equal(await page.locator('#verticalScale').getAttribute('data-value'), mobile ? '70' : '100');
        assert.equal(await page.locator('#annotationLayout').getAttribute('aria-pressed'), String(mobile));
        if (mobile) await page.locator('#settingsToggle').click();

        // All nonempty visibility subsets: global directions survive, local ones do not migrate.
        for (const selected of [[0,1,2],[1,2],[0,2],[0,1],[2],[1],[0]]) {
          for (const part of [...selected, ...[0,1,2].filter(part => !selected.includes(part))]) {
            const control = page.locator(`[data-visible-index="${part}"]`);
            if ((await control.getAttribute('aria-pressed') === 'true') !== selected.includes(part)) await control.click();
          }
          await page.waitForFunction(selected => JSON.stringify(__qa.api.tracks.map(track => track.index)) === JSON.stringify(selected), selected);
          await settled();
          const labels = await page.locator('#score svg text').allTextContents();
          for (const text of ['Intro', 'Verse', 'Chorus', 'Lightly', 'rit.', 'a tempo']) {
            assert.equal(labels.filter(label => label.trim() === text).length, 1, `${selected}: ${text}`);
          }
          assert.equal(labels.filter(label => label.trim() === 'breathe').length, selected.includes(1) ? 1 : 0);
          assert.equal(labels.filter(label => label.trim() === 'Listen').length,
            selected.includes(2) && selected[0] !== 2 ? 2 : 1, 'also-top retains the source-part cue without doubling the top');
          assert.ok(!labels.some(label => /\d\.\d{4}/.test(label)), 'no MIDI precision leaks into printed tempos');
          const engraving = await page.evaluate(() => {
            const texts = [...document.querySelectorAll('#score svg text')];
            const box = text => {
              const node = texts.find(node => node.textContent.trim() === text);
              if (!node) return null;
              const r = node.getBoundingClientRect(), css = getComputedStyle(node);
              return {x:r.x, top:r.top, bottom:r.bottom, weight:css.fontWeight, style:css.fontStyle};
            };
            return {intro:box('Intro'), cue:box('Lightly'), chord:box('C'), verse:box('Verse'), rit:box('rit.')};
          });
          assert.equal(engraving.intro.weight, '700');
          assert.equal(engraving.intro.style, 'normal');
          assert.equal(await page.locator('#score .section-heading').count(), 3);
          assert.equal(await page.locator('#score .section-heading path').count(), 3);
          assert.ok(engraving.cue.top > engraving.intro.bottom, 'heading and cue have visible clearance');
          if (engraving.chord) assert.ok(engraving.chord.top > engraving.cue.bottom, 'chord has its own lane');
          assert.ok(engraving.rit.x > engraving.verse.x + 8, 'mid-bar rit. must not migrate to the bar start');
          const state = await page.evaluate(() => ({renderedTracks: __qa.api.tracks.map(track => track.index)}));
          assert.deepEqual(state.renderedTracks, selected);
        }
        // Reset visibility before exercising actual score taps and playback.
        for (const part of [1,2]) await page.locator(`[data-visible-index="${part}"]`).click();
        await page.waitForFunction(() => __qa.api.tracks.length === 3);
        await settled();
        // Changed key/time signatures must not share the rest's centering span.
        await page.locator('#horizontalScale').press('Home');
        await page.waitForFunction(() => !__qa.busy && __qa.api.settings.display.stretchForce === .05);
        const restLayout = await checkMeasureRests(page, 4, 3);
        await page.locator('#horizontalScale').press('End');
        await page.waitForFunction(() => !__qa.busy && __qa.api.settings.display.stretchForce === 2);
        await checkMeasureRests(page, 4, 3);
        const cursorEdges = await checkCursorEdges(page);
        await page.evaluate(() => __qa.engine.seek(0));
        if (mobile) await page.locator('#settingsToggle').click();
        await page.locator('#playPause').click();
        await page.waitForFunction(() => __qa.engine.playing && __qa.engine.context.state === 'running');
        assert.deepEqual(await page.evaluate(() => __qa.onsets.filter(note => Math.abs(note.start) < 1e-6)
          .map(note => [note.track, note.key]).sort((a, b) => a[0] - b[0])), [[0,72],[1,67],[2,48]],
          'first Play schedules each opening note exactly once');
        await page.evaluate(() => {
          __qa.analyser = __qa.engine.context.createAnalyser();
          __qa.analyser.fftSize = 256;
          __qa.engine.master.connect(__qa.analyser);
        });
        const sounding = () => page.waitForFunction(() => {
          const samples = new Float32Array(256); __qa.analyser.getFloatTimeDomainData(samples);
          return samples.some(value => Math.abs(value) > .0001);
        });
        await sounding();
        for (const measure of [2, 1, 2]) {
          await page.evaluate(() => { __qa.onsets = []; });
          const label = page.locator('#score svg text').filter({hasText: new RegExp(`^${measure}\\s*$`)}).first();
          if (mobile) await label.tap(); else await label.click();
          const seek = await page.evaluate(measure => ({
            position: __qa.engine.basePosition,
            wanted: __qa.engine.secondsAtTick((measure - 1) * 4 * 960),
            onsets: __qa.onsets.filter(note => Math.abs(note.start - __qa.engine.basePosition) < 1e-6)
              .map(note => [note.track, note.key]).sort((a, b) => a[0] - b[0]),
          }), measure);
          assert.ok(Math.abs(seek.position - seek.wanted) < 1e-6, JSON.stringify(seek));
          assert.deepEqual(seek.onsets, measure === 1 ? [[0,72],[1,67],[2,48]] : [[0,76],[1,69],[2,53]],
            'clicked chord is scheduled exactly once, not skipped');
          await sounding();
        }
        await page.locator('#playPause').click();
        // Explicit scale choices survive reload instead of being overwritten by responsive defaults.
        if (mobile) await page.locator('#settingsToggle').click();
        const panHolds = await checkPanHolds(page, page, mobile, '__qa');
        await page.locator('[data-pan-index="1"]').press('Shift+Enter');
        assert.deepEqual(await page.locator('[data-pan-index]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.value))),
          [-100, 100, -100], 'separation is active before the persistence check');
        await page.locator('#verticalScale').press('ArrowUp');
        const saved = await page.locator('#verticalScale').getAttribute('data-value');
        const storedMixes = await page.evaluate(() => Object.values(localStorage).flatMap(value => {
          try { const data = JSON.parse(value); return Array.isArray(data?.pans) ? [data.pans] : []; }
          catch { return []; }
        }));
        assert.ok(storedMixes.some(pans => JSON.stringify(pans) === '[-100,100,-100]'),
          `pan separation is saved (${mobile ? 'mobile' : 'desktop'}): ${JSON.stringify(storedMixes)}`);
        await page.reload(); await settled();
        assert.equal(await page.locator('#verticalScale').getAttribute('data-value'), saved);
        assert.deepEqual(await page.locator('[data-pan-index]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.value))),
          [-100, 100, -100], 'pan separation survives reload');
        if (mobile && await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true')
          await page.locator('#settingsToggle').click();
        await page.locator('[data-pan-index="1"]').press('Shift+Enter');
        assert.deepEqual(await page.locator('[data-pan-index]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.value))),
          [0, 0, 0], 'reloaded separation still toggles back to center');
        if (mobile && await page.locator('#settingsToggle').getAttribute('aria-expanded') === 'true')
          await page.locator('#settingsToggle').click();
        await page.screenshot({path: path.join(output, `shared-${mobile ? 'mobile' : 'desktop'}.png`)});
        results.push({viewport: mobile ? 'mobile' : 'desktop', visibilitySubsets: 7, onsetChecks: 4, savedScale: saved,
          fullMeasureRests: {scales:[5,200], count:restLayout.length}, cursorEdges, panHolds});
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    const report = {passed: true, freshGenericBuild: true, results, errors, externalRequests: requests};
    await fs.writeFile(path.join(__dirname, '../qa/shared-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser?.close();
    await fs.rm(temporary, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
