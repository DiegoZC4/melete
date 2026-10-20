# Working On Melete

Reusable playback, notation and interaction changes belong in this repository,
not in a replacement script injected into one song. Song-specific musical
choices belong in configuration or an explicit adapter. Keep both separate.

## Regression Gate

From this repository, with Python 3.11+ and Node.js 22+ installed:

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -q
```

These checks use the bundled libraries and synthetic scores; no npm install or
MuseScore installation is needed. They cover extraction, source safety,
standalone bundling, playback scheduling, slurs, divisi, lyrics, cursor geometry,
mixing gestures and notation formatting. New bugs should get a regression test
here, not just a passing custom-song test.

For the real-browser gate, install the pinned test-only dependency and Chromium:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

On Linux, `npx playwright install --with-deps chromium` can also install required
system libraries. On Windows set `PYTHON=python` if `python3` is not on PATH.
`QA_BROWSER_CHANNEL=chrome` uses an already installed Chrome instead of the
Playwright Chromium download. `GUI_QA_NODE_MODULES` can optionally select an
existing dependency directory; it is never required.

The smoke test makes a fresh standalone build, intercepts requests in an isolated
browser context (no server), and checks desktop/mobile layouts, all visible-part
subsets, section frames, rests, first/seek note playback, actual audio output,
pan holds with mouse/touch/keyboard, and persisted settings. External requests
fail the test. It closes the browser and deletes its temporary build in a
`finally` block. Small reports and review screenshots are retained in ignored `qa/`.

The loop-recorder checks use a generated 997 Hz fake microphone, never a physical
microphone. They validate bounded three-pass storage, independent WAV downloads,
absence of guide-synth audio in the recording, permission denial/cancellation,
transport edits, and independent Sing/recorder microphone ownership. Temporary
WAVs are deleted with the test build. `QA_RECORDER_ONLY=1` runs just these focused
browser checks; add `QA_FILE_ORIGIN=1` to verify a standalone file opened offline.
Keep latency-sensitive audio/browser checks serialized against
other tests using the same audio device; do not relax their timing assertions to
accommodate competing render jobs.

Where `heavy-run` is installed, run heavyweight tests through it, for example:

```sh
heavy-run --label melete-browser-qa --key melete-browser-qa -- npm run test:browser
```

CI runs the source tests on macOS, Linux and Windows, plus the browser gate on
Linux. Native MuseScore export still needs an actual installed app:

```sh
python3 tests/native-smoke.py
```

The native check accepts `--musescore PATH`, creates a synthetic `.mscz`, converts
it, checks its cached rebuild and source preservation, and cleans up all outputs.
It uses the builder's optional process supervisor automatically. Never publish
a private score as a fixture. A new successful build does not establish that every
possible score engraving is correct; visually review representative passages.

## Repository Boundaries

`build_trainer.py`, `extract_score.mjs`, `template/`, `vendor/` and `tests/`
are the conversion pipeline. The top-level `.gitignore` is an allowlist to avoid
publishing personal score projects, generated HTML, recordings, deployment
credentials or local QA artifacts. Review `git diff --cached --stat` and
`git diff --cached` before a push. Add new top-level paths deliberately.

Keep user scores and generated projects beside the repository, not inside it.
Do not hand-edit generated HTML as the lasting fix. Update the shared template,
rerun the gate, and rebuild the affected song. A clean clone must work without
any sibling project or private script.

The maintainer's active conversion folder is the repository itself, not an
export copy. Future verified fixes can be committed and pushed to `main`;
users receive them with `git pull --ff-only` and rebuild their HTML. Never
commit a score just to demonstrate the new feature; add a tiny synthetic fixture.

## Library Updates

Runtime dependencies are vendored to keep conversions offline and reproducible.
Preserve licenses and upstream notices. Check their hashes and provenance in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when changing them. Run the full
gate after an AlphaTab update, since the layout adapters use its renderer APIs.
