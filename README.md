# Melete

Turn your MuseScore score into an interactive choir rehearsal page: hear and
isolate parts, loop passages, slow playback, view notation or pitchbars, and
practice with microphone pitch feedback. Each song becomes one self-contained
HTML file. No account, hosted backend, API key, or subscription is required.

`build_trainer.py` turns a MuseScore or MusicXML source into both:

- a readable development project with separate HTML, CSS, JavaScript, vendor,
  and generated-data files; and
- one downloadable HTML file containing the score, playback data, AlphaTab,
  Bravura, Pitchy, configuration, and third-party notices. It has no runtime
  CDN or other external asset dependency.

The builder is intentionally score-agnostic. Song-specific choices belong in
an optional JSON config, while score structure and playback are derived from
MusicXML by `extract_score.mjs`.

## Requirements

- Python 3.11 or newer (standard library only)
- Node.js 22 or newer for the bundled score extractor; no `npm install` is required
- MuseScore 4 for the first conversion of a new or changed `.mscz` or `.mscx`

AlphaTab, the Bravura music font, Pitchy, and fft.js are vendored with their
licenses, so builds do not depend on a CDN or network connection. Every build
also checks the pitch detector against a synthetic 220 Hz tone.

Install [Python](https://www.python.org/downloads/),
[Node.js](https://nodejs.org/en/download), and
[MuseScore Studio](https://musescore.org/en/download). On Windows, enable the
Python installer's PATH option. MuseScore is optional if you already have an
uncompressed `.musicxml` or `.xml` export.

## Quick Start

Clone this repository (or use GitHub's **Code > Download ZIP** and extract it):

```sh
git clone https://github.com/DiegoZC4/melete.git
cd melete
python3 build_trainer.py "/path/to/My Song.mscz"
```

On Windows, use `py -3` in place of `python3`:

```powershell
py -3 build_trainer.py "C:\Music\My Song.mscz"
```

The command prints the exact output path. Open the generated
`<song>-practice-web/dist/index.html` in a browser. You can send that one HTML
file to singers or put it on any static web host. Playback works offline;
microphone availability depends on the browser and its permission/security
rules. HTTPS hosting is recommended when sharing microphone practice online.
The generated HTML contains the score itself, so share it only where you have
permission to share that music. Nothing is uploaded by the converter.

To try the pipeline without your own score or a MuseScore installation:

```sh
python3 build_trainer.py tests/fixtures/shared-regressions.musicxml --project-dir ../melete-demo
```

This uses a tiny synthetic test score, not a copyrighted arrangement. Open
`../melete-demo/dist/index.html` when it finishes. Keep your scores and generated
projects outside this repository; the builder protects its own source tree.

### Locating MuseScore

The builder looks for MuseScore in the standard macOS/Windows install locations
and on PATH. For an AppImage, portable install, or different location, specify
the executable explicitly:

```sh
python3 build_trainer.py "/path/to/My Song.mscz" --musescore "/path/to/MuseScore"
```

```powershell
py -3 build_trainer.py "C:\Music\My Song.mscz" --musescore "C:\Program Files\MuseScore 4\bin\MuseScore4.exe"
```

`MUSESCORE` is the equivalent environment variable. On macOS, point to the
executable inside the app, such as
`/Applications/MuseScore 4.app/Contents/MacOS/mscore`, not the `.app` directory.
If command-line export fails, export **uncompressed MusicXML** from MuseScore
and give that file to the same command. Compressed `.mxl` is not currently an
input format. On a headless Linux machine, MuseScore may additionally need a
working Qt display setup; the MusicXML route avoids launching it.

### Getting Updates

Keep the cloned repository and run:

```sh
git pull --ff-only
python3 build_trainer.py "/path/to/My Song.mscz"
```

Rebuilding an unchanged source reuses its verified MusicXML export and picks up
the latest shared player fixes. Already-sent HTML files do not update themselves;
replace or resend them after rebuilding. ZIP downloads can instead be replaced
with a fresh ZIP. There is no automatic upload or website deployment step.

## Scope And Limits

- This is the reusable shared pipeline, not a bundle of song arrangements or
  the private adapters used for particular recordings.
- MusicXML is the interchange layer. Responsive web notation will not match
  MuseScore's printed page layout, and not every native effect survives export.
- Slurs use continuous synthesis with 3 ms pitch glides. Sound is a practice
  synth, not Muse Sounds or a recording of singers.
- Generic playback uses AlphaTab's MusicXML timing, repeats and dynamics.
  Check unusual jumps, swing, fermatas, tuplets and polyphonic voices against
  the source before sharing. A successful conversion is not a musical proof.
- Text such as "Clap" does not automatically create percussion audio. Custom
  percussion samples, bespoke fermata timing, and handwritten diagrams need
  explicit integration; they are not guessed from prose.
- Source/PDF download buttons require supplied download data or links; the
  basic converter does not automatically export and embed a printable PDF.
- The current release is locally tested on macOS with MuseScore 4.7.5. Windows
  and Linux discovery paths are covered by unit tests, not a claim that every
  MuseScore version has been tested on those systems.

See [CONTRIBUTING.md](CONTRIBUTING.md) for regression tests and future updates,
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled-library licenses.

## Slurred Playback

Slur continuity belongs to the shared builder, not just the Get It Right adapter.
The extractor preserves MusicXML slurs as note-index chains in `playback.legato`,
following the original staff and voice through ties. Rests and detached notes
break a chain; ambiguous polyphony is left articulated with an extraction warning
rather than connecting unrelated voices. Parallel chord tones retain separate
oscillators. Original note events, dynamics, lyrics and timing are unchanged.

The player sustains one oscillator/envelope per chain and glides to each new
pitch over 3 ms, arriving at the written onset. The glide stays 3 ms at different
practice speeds. Seeking inside a slur starts at its current pitch; loop ends
clip the phrase, and divisi filtering preserves only the selected connected notes.

`tests/slur_playback.test.cjs` covers extraction, ties, rests, divisi, timing,
seek/loop boundaries and oscillator/envelope scheduling. The fresh-build browser
test additionally verifies actual audio output without a song-specific adapter.

## Trainer interface

The generated interface is designed around the score rather than a permanent
title block. Its compact sticky transport keeps play/pause, a segmented
measure timeline, and elapsed time visible while the document itself scrolls.
Written MusicXML dynamics and hairpins retain their above/below-staff placement.
They share an expression lane with clearance between the dynamic and wedge;
divisi voices do not duplicate staff-wide hairpins. Compact Lyrics can still
consolidate dynamics without removing the hairpins. Metric-modulation note
equations use the embedded music font in the system-wide tempo lane, including
MuseScore's word-form SMuFL export. These display repairs never change the
playback tempo map or note velocities.
The score follows playback until the reader deliberately scrolls away; it then
stays put and offers a directional return-to-playback button instead of
forcefully reclaiming the viewport. The playback timeline and initial score
cursor are always present rather than being optional display settings.
On wide screens, compact Parts, Practice, Display and Tools groups sit side by
side, wrapping when needed. Tools uses two columns and four rows, matching the
other groups' height. The phone drawer puts Parts above paired three-column
Practice/Display grids, with Tools below in three columns and two rows.
Every utility occupies one base cell. The pencil is icon-only, with Annotate as its
tooltip and an explicit accessible name. Part and conditional divisi pagers share a row.
Each moving part page carries its own full-width or split layout during browsing;
changing between parts with and without divisi never resizes its label on release.
Score/Pitchbar and scroll-direction pills toggle when tapped anywhere.
Tap Sing to toggle capture; hold to clear its trace without toggling capture.
Holding either joined Loop endpoint clears the loop. Delete/Backspace is the
keyboard equivalent on those controls. PDF opens a new tab; the adjacent MSCZ
download is available only on desktop.

Each extracted part receives a compact matrix for notation visibility,
audibility, volume, and stereo pan. Other built-in practice controls include
volume-number holds for emphasizing or reducing a voice, tempo, a wooden
metronome, always-on written dynamics, measure-snapped loop
boundaries, vertical or horizontal score direction, independent
vertical and horizontal score scaling, a Compact Lyrics toggle, plus fullscreen,
WYSIWYG score annotations, and self-download. Playback cursors, measure numbers,
chapter-start emphasis, and highlights remain permanently available rather than
becoming display toggles. Compact Lyrics combines matching words across visible
parts when onset and sung duration agree. A supplied `sharedNotation.leadRanges`
map can place melody above and accompaniment below the score; without a map,
only genuinely matching words are shared, and distinct phrases stay local.
Shared owner labels use contiguous voice-part ranges, such as `S1-A1` and
`A2-B2`. Gaps stay explicit rather than including unshared or hidden parts.
The same toggle shows only syllable changes, independently per part and lyric
verse: each run of identical syllables keeps its first occurrence, even for a
short run or across rests and barlines. A return after different words is shown
again. Pitchbar view uses the same repeat rule. No source or playback data is
edited, and turning Compact Lyrics off restores every original lyric.

Press a notehead or pitchbar to hear its sounding pitch immediately. Release
before 250 ms to also move the playhead; keep holding to sustain the preview
without seeking. Every release starts the click-free fade immediately, with no
minimum sounding duration. A preview released before audio finishes starting
cannot sound later. A drag begun on a note follows nearby visible notes without
moving the playhead. Start just above the top staff of a system (or above the
pitch grid) to hear the full sounding vocal chord, including held, hidden and
muted parts but no percussion. Dragging keeps its initial note/chord mode;
unchanged tones sustain while changed tones crossfade. Chord previews bypass
vocal levels, retain pan, and use a balanced ensemble level without changing
the saved mix. Ordinary blank-space drags still scrub.

Release of a held note or cancellation stops the preview, including touch scrolling, pinch,
reflow and leaving the window. Native vertical touch scrolling stays available;
horizontal reading mode retains two-axis touch scrolling. Tap/hold classification
uses input timestamps so cold audio initialization cannot turn a tap into a hold.

Left/Right steps through and auditions the selected voice's note onsets, including
notes within slurs, rather than jumping by one beat. It pauses continuous playback.
Click a voice's note or choose a practice part to select the voice. Up/Down still
moves between sections; focused controls keep their own arrow-key behavior.
Divisi playback uses a compact pager beside the chosen practice part: **All Div**,
**Div 1**, **Div 2**, and further divisions as needed, numbered highest to lowest.
The score's simultaneous distinct pitches determine the available divisions;
the control is omitted entirely for unsplit scores and hidden for an unsplit
chosen part. Only that practice part's playback is filtered. Other parts,
percussion, notation, note/chord auditions and independent pitch-trace lanes
remain unchanged. Unison passages play for every division; where fewer lines
are present, selection maps proportionally from highest to lowest. Choices are
remembered per part, and default to All Div. Retired Upper/Lower preferences
are still ignored. Numeric controls and the part pager keep their dragging
behavior without decorative vertical-arrow indicators.

Automatic scrolling follows current-measure geometry rather than the animated
cursor's previous position. Paused position refreshes never pull the page back.
Finishing leaves the view at the final chord; explicitly pressing Play restarts.

Compact Lyrics defaults off on desktop and on at mobile widths up to 600px;
each remembers its own explicit choice. The old repetition-only setting migrates
to this single toggle, without overriding existing viewport-specific choices.
The alternate Pitch view renders all visible parts as color-coded bars on one
cropped, key-relative pitch grid. Lyrics follow the chosen practice part, which
stays visible while in pitchbar view; other parts remain optional. Crowded
syllables use extra rows without shifting their horizontal note alignment.
Optional microphone tracking samples at roughly 15 Hz, stores accepted
contours locally, and grades intonation from bright green at the target pitch to
bright red at 50 cents of error. It uses confidence and temporal continuity
rather than an adaptive amplitude noise floor, and accepted samples overwrite
only their own score-time windows.
Sing works in both standard notation and Pitchbar view. Switching views keeps
the microphone state and the same saved take. In standard notation, zero error
is centered on the target's engraved notehead; 25 cents moves one line-to-space
step, independently of the color grading. Sounding pitch determines the error,
including octave-transposing clefs and accidentals. The last note's written
position carries over rests and line breaks. Horizontal position follows the
engraved time columns, including swing, rather than assuming uniform beat widths.
The overlay reflows with scale, visibility and scrolling direction, updates
only affected edges during capture, and never intercepts score gestures.
On touch devices, two-finger pinch on the score adjusts its vertical scale;
vertical notation reflows whenever the score surface's available width changes.
New visits start at 70% notation size on screens up to 600px, or 100% on desktop.
Explicit song defaults and saved user choices take precedence.
Score clicks establish the current measure; the loop endpoint and note actions
then use that shared location. Device-local notes retain their exact musical
tick, display a decimal measure address such as `12.5`, and are redrawn from
AlphaTab's beat and measure bounds after every responsive reflow. Playback is a
local Web Audio synthesis path, and settings
stay in local storage rather than creating long share URLs. Scores and playback
data are embedded at build time; the trainer has no load-score-from-URL mode.

Hold an individual singer's volume number for 600 ms to cycle Emphasize (100%,
others 20%), Reduce (20%, others 100%), and Normal (every voice audible at 100%).
Choose the next step from the actual volume levels, not stored preset history:
an exact emphasized mix advances to Reduce, an exact reduced mix to Normal,
and all other mixes start at Emphasize. This also works after manual edits or
reloads without an active preset session. Tooltips describe the next action.
This targets the held singer without changing the chosen practice part and
leaves percussion untouched. Shift+Enter is the keyboard equivalent;
dragging still adjusts volume, and right-click still resets the number.
An active preset follows explicit changes to the chosen practice part while
keeping the original Hear/Vol snapshot. Resetting that choice restores the
snapshot, including across reloads; completing the volume-hold cycle instead
sets all voices to 100% and clears that snapshot. Mix target and mode are saved separately
from the chosen practice part. The former separate preset buttons are removed.
Manual volume/audibility edits instead start a new custom mix. Loop End includes
the whole selected measure even when selection is exactly on its downbeat.

Hold a part's Pan dial for 600 ms to put that part fully right and all other
parts fully left; hold the same dial again to center all parts. Shift+Enter does
the same. The current pan values determine the next action, so manually created
or reloaded separation also resets correctly. Holding another part retargets
the separation. Volume, Hear/See, the practice selection and notation stay
unchanged. Horizontal dragging still adjusts pan; movement, scrolling, another
touch, cancellation or window blur cancels a pending hold. Individual resets
remain available by right-click, double-click and `0`.

### Contextual shortcut tips

Brief anchored tips teach shortcuts after a matching sequence of manual actions:

- Two or more distinct off-toggles within three seconds that leave one part on
  in See or Hear suggest holding the retained part to isolate it.
- Manually returning two distinct volumes or pans to their configured defaults
  within eight seconds suggests resetting the row label. A drag is one action;
  normal mixing, cancelled gestures, and programmatic updates do not count.
- Tips wait 650 ms for interaction to settle and recheck the resulting state.
  Mouse, touch, and keyboard users get the corresponding shortcut wording.
- Each shortcut is offered only once per browser origin, shared across songs.
  Successfully using the shortcut first also suppresses it. A session-wide
  one-minute cooldown separates different tips. Storage failures fall back to
  in-memory suppression; nothing is sent to a server or exported in portable state.
- Tips do not change playback, controls, or focus. They dismiss with the X,
  Escape, another interaction, or after nine seconds; hover/focus pauses expiry.
  The opt-in help mode remains available and suppresses automatic tips.

Run `node --test tests/shortcut_hints.test.cjs` for detection/gesture regressions,
alongside `python3 -m unittest discover -s tests -q`.

## Conversion Details

The default project is created beside the input as
`weekly-song-practice-web/`, and the standalone file is written to
`weekly-song-practice-web/dist/index.html`.

Explicit destinations and configuration:

```sh
python3 build_trainer.py \
  "/path/to/Weekly Song.musicxml" \
  --project-dir "/path/to/weekly-song-web" \
  --output "/path/to/weekly-song.html" \
  --config "/path/to/weekly-song.config.json"
```

Use short lowercase ASCII kebab-case filenames for standalone builds and public
URLs (for example, `birds-lullaby.html`). Keep the human-readable title inside
the document rather than encoding punctuation or long labels in its filename.

Supported score inputs are `.mscz`, `.mscx`, `.musicxml`, and `.xml`.
MuseScore inputs are exported using its `-o` command-line conversion mode.
When the optional `heavy-run` process supervisor is installed on PATH or at
`~/.local/bin/heavy-run`, the builder uses it and respects its admission checks.
Other machines do not need that helper. The builder never installs it or
silently bypasses an installed supervisor.

On Apple-silicon Macs the builder pins MuseScore's native arm64 slice; this
avoids an intermittent Rosetta startup crash in noninteractive exports. Other
platforms invoke the MuseScore executable directly. For `.mscz` input, the
builder reads the single contained `.mscx` document into its temporary export
directory before launching MuseScore. The original archive is still preserved
unchanged under `assets/source/`. On macOS, supervised export staging uses
`/private/tmp`; MuseScore 4.7 can abort during noninteractive startup when the
same export is staged under the per-app `$TMPDIR` tree. The contained score's
original basename is also preserved because renaming a valid document to a
generic `source.mscx` can trigger the same MuseScore 4.7 abort. On macOS the
builder retries that specific exit-134 startup failure at most twice; every
attempt remains inside transaction staging, so an existing generated project
is untouched if MuseScore never starts successfully.

After that initial conversion, an owned generated project reuses its normalized
MusicXML whenever both the original MuseScore source SHA-256 and cached export
SHA-256 still match. This makes routine HTML, CSS, JavaScript, and config
rebuilds pure Python/Node operations without launching MuseScore. Pass
`--refresh-score` to deliberately discard that verified cache and re-export.

MusicXML inputs never launch MuseScore. In both cases the normalized score
removes only affirmative `new-system="yes"` and `new-page="yes"` attributes
from `<print>` elements. Other attributes and child content are preserved, so
imported paper layout cannot prevent responsive wrapping while musical content
remains unchanged. The normalizer is token-aware: print-like text in comments,
CDATA, processing instructions, DTDs, and attribute values is left alone.
The same lexical pass marks consecutive duplicate lyric elements with
`data-choir-repeated-lyric="true"`. The original lyric remains in the generated
score; the browser removes only marked copies when Changes mode is selected,
so playback and the source archive are unaffected.

MuseScore export has a 10-minute timeout, and score extraction has a two-minute
timeout, so a stuck dependency cannot hold a build indefinitely.

## Optional config

The config must be a JSON object. These inferred defaults are always present:

```json
{
  "schemaVersion": 1,
  "title": "Title read from MusicXML",
  "composer": "Composer read from MusicXML",
  "slug": "title-read-from-musicxml",
  "favicon": "🎶"
}
```

Any additional keys are preserved for the frontend. Nested objects are merged
recursively; arrays and scalar values replace their defaults. For example:

```json
{
  "favicon": "🌙",
  "theme": {
    "accent": "#4f6d5b"
  },
  "partColors": {
    "Soprano": "#c84f68",
    "Alto": "#b47b25",
    "Tenor": "#397da3",
    "Bass": "#6759a5"
  }
}
```

`demoVideo` is an optional `https://` address of a recording of the arrangement.
When present, a YouTube button opens it from the Practice group and the theme
toggle moves one cell to the right to make room. The address is applied at
runtime, so the built file still contains no external references.

`defaults` currently accepts `tempo`, `metronome`, `vertical`, `horizontal`,
`flow` (`"wrap"` or `"continuous"`), `practicePart` (zero-based
index, full name, short name, or source ID), `annotationLayouts`
(`{"desktop":"part","mobile":"shared"}` for the standard Compact Lyrics
defaults), `scoreView` (`"standard"` or `"bars"`), `volumes`, and `pans`.
The legacy `lyrics: "changes"` setting enables Compact Lyrics when no explicit
viewport choice exists; it no longer controls a separate feature.
Pitch detection uses a fixed confidence threshold plus temporal-consistency
filtering so ordinary singers do not need to tune an implementation parameter.
`partColors` keys are matched against extracted part names. Per-index overrides
can also be supplied through `parts` when a source score uses unusual labels.

The title override determines the default slug unless `slug` is also supplied.
The slug is normalized to lowercase ASCII kebab-case so output naming and
saved browser state remain deterministic.

## Generated project

```text
<project>/
  .choir-practice-builder-project.json  generated-project ownership marker
  index.html                    runnable development entrypoint
  styles.css
  app.js
  assets/
    score.musicxml              normalized responsive score
    playback.json               compact playback sequence
    score-metadata.json         extractor output
    trainer-config.json         effective configuration
    build-metadata.json         score metadata and provenance hashes
    source/<original filename>  untouched input archive
  vendor/                       copied local AlphaTab and Bravura assets
  dist/index.html               standalone output (default)
```

The builder refuses to overwrite a nonempty project directory unless that
ownership marker is present and valid. It also rejects the builder tree, its
ancestors, broad filesystem/home targets, and output paths that could overwrite
builder/input files. A project is assembled and validated in a sibling staging
directory, then swapped into place; extraction or bundling failure leaves the
previous project and standalone output unchanged.

The standalone output can be opened directly for offline use. The separate-file
development project may also be served by an existing local development server
or a static web host. No development server is required for conversion.

## Extractor contract

The sibling helper is called exactly as:

```text
node extract_score.mjs \
  --score <project>/assets/score.musicxml \
  --playback <project>/assets/playback.json \
  --metadata <project>/assets/score-metadata.json
```

Both outputs must be JSON objects. Extractor metadata is copied to the top
level of `build-metadata.json`; the builder adds or normalizes `title`,
`composer`, `slug`, `favicon`, `layoutBreaksRemoved`,
`repeatedLyricsMarked`, and a nested `build` object. The `build` object contains
the builder version, a 16-character content fingerprint, the original source
name/format/hash, and normalized score and playback hashes. No absolute local
path is embedded in the distributable.

## Literal template-marker contract

`template/index.html` must contain each of these exact strings once:

```html
<link rel="stylesheet" href="./styles.css" data-inline />
<script src="./vendor/alphatab/alphaTab.min.js" data-inline></script>
<script src="./vendor/pitchy/pitchy-browser.js" data-inline></script>
window.TRAINER_FONT_SOURCE = "./vendor/alphatab/font/Bravura.woff2";
<script id="score-data" type="application/vnd.recordare.musicxml+xml"></script>
<script id="playback-data" type="application/json"></script>
<script id="trainer-config" type="application/json"></script>
<script id="build-metadata" type="application/json"></script>
<script src="./app.js" data-inline></script>
<!-- THIRD_PARTY_NOTICES -->
```

The development entrypoint receives generated score/config JSON inside those
data elements and keeps CSS, application JavaScript, AlphaTab, and Bravura as
separate files. The small generated Pitchy/fft.js runtime is inline in both
development and standalone pages. The standalone page inlines everything else
as well. The builder fails if a marker
is absent or duplicated, if an inline source contains an unsafe closing tag,
if an actual standalone HTML or CSS asset reference is neither a fragment nor
a data URI, or if any marker remains after assembly. Inert MusicXML stored in
a script data element is not mistaken for document markup during this check.

The template must also contain exactly one `<title>` and one `</head>`. The
builder replaces the title and injects an emoji SVG favicon plus a deterministic
`standalone-build:<fingerprint>` comment.

## Required builder files

```text
choir-practice-builder/
  build_trainer.py
  extract_score.mjs
  README.md
  template/
    index.html
    styles.css
    app.js
    shared_notation.js
    system_annotations.js
  vendor/alphatab/
    alphaTab.min.js
    LICENSE
    font/
      Bravura.woff2
      Bravura-OFL.txt
  vendor/pitchy/
    index.js
    LICENSE
  vendor/fft/
    fft.js
    LICENSE
```

The build stops on missing files, invalid input/XML/JSON, MuseScore or helper
failure, unresolved markers, and external standalone assets. A successful run
prints one JSON summary containing destinations, score dimensions, byte size,
and fingerprint.
