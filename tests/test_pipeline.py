from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_trainer", ROOT / "build_trainer.py")
assert SPEC is not None and SPEC.loader is not None
build_trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_trainer)


class PipelineTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_build_preserves_project_and_third_party_licenses(self) -> None:
        own_license = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertEqual(json.loads((ROOT / "package.json").read_text())["license"], "MIT")
        lock = json.loads((ROOT / "package-lock.json").read_text())
        self.assertEqual(lock["packages"][""]["license"], "MIT")
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "player"
            subprocess.run(
                [sys.executable, str(ROOT / "build_trainer.py"),
                 str(ROOT / "tests/fixtures/shared-regressions.musicxml"),
                 "--project-dir", str(project)],
                check=True, capture_output=True, text=True, timeout=60,
            )
            self.assertEqual((project / "LICENSE").read_text(encoding="utf-8"), own_license)
            for relative in ("index.html", "dist/index.html"):
                with self.subTest(document=relative):
                    document = (project / relative).read_text(encoding="utf-8")
                    self.assertIn(own_license.strip(), document)
                    self.assertIn("Third-party components retain their respective licenses", document)
                    for vendor_license in (
                        "alphatab/LICENSE", "alphatab/font/Bravura-OFL.txt",
                        "lucide/LICENSE", "pitchy/LICENSE", "fft/LICENSE",
                    ):
                        text = (ROOT / "vendor" / vendor_license).read_text(encoding="utf-8")
                        self.assertIn(build_trainer.safe_script_text(text.strip()), document)

    def test_song_title_uses_melete_without_replacing_the_song_name(self) -> None:
        template = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        document = build_trainer.decorate_head(template, "Song & Choir", "M", "test")
        self.assertIn("<title>Song &amp; Choir | Melete</title>", document)
        self.assertIn('<meta name="application-name" content="Melete"', document)

    def test_browser_title_override_preserves_the_score_title(self) -> None:
        template = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        config = build_trainer.effective_config(
            {"title": "Golden Slumbers / Carry That Weight / The End", "composer": ""},
            {"browserTitle": "Golden Slumbers - Melete"},
        )
        document = build_trainer.decorate_head(
            template, config["title"], "G", "test", browser_title=config["browserTitle"]
        )
        self.assertIn("<title>Golden Slumbers - Melete</title>", document)
        self.assertIn("Interactive choir rehearsal score for " + config["title"], document)
        escaped = build_trainer.decorate_head(template, "Song", "G", "test", browser_title="Song <&> Melete")
        self.assertIn("<title>Song &lt;&amp;&gt; Melete</title>", escaped)
        for invalid in (None, 3, "", "  "):
            with self.subTest(value=invalid), self.assertRaises(build_trainer.BuildError):
                build_trainer.effective_config(
                    {"title": "Song", "composer": ""}, {"browserTitle": invalid}
                )

    def test_trainer_uses_only_build_embedded_score_data(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertNotIn('fetch("./assets/', app)
        self.assertNotIn("fetch('./assets/", app)
        self.assertIn('embeddedText("score-data")', app)
        self.assertIn('embeddedText("playback-data")', app)

    def test_standalone_download_embeds_portable_state_after_picker(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn('<script id="portable-state" type="application/json"></script>', document)
        self.assertIn('aria-label="Download standalone score with current settings and annotations"', document)
        self.assertIn("const PORTABLE_STATE_VERSION = 1", app)
        self.assertIn("function currentPortableState()", app)
        self.assertIn("preferences: currentPreferenceState()", app)
        self.assertIn("annotations: currentAnnotationState()", app)
        portable_snapshot = app.split("function currentPortableState()", 1)[1].split("function jsonForEmbeddedScript", 1)[0]
        self.assertNotIn("pitchTrace", portable_snapshot)
        self.assertNotIn("takeBuffer", portable_snapshot)
        self.assertNotIn("takeSession", portable_snapshot)
        self.assertIn("function documentWithPortableState(source, state)", app)
        self.assertIn('.replace(/</gu, "\\\\u003c")', app)
        self.assertIn("initialDocumentSource", app)
        self.assertIn("document.documentElement.outerHTML", app)
        self.assertIn('typeof window.showSaveFilePicker !== "function"', app)
        self.assertIn("window.showSaveFilePicker({", app)
        self.assertIn('suggestedName: filename', app)
        self.assertIn('accept: { "text/html": [".html", ".htm"] }', app)
        self.assertIn("await handle.createWritable()", app)
        self.assertIn('if (error?.name === "AbortError") return', app)
        download_function = app.split("async function downloadStandalone", 1)[1].split("async function init", 1)[0]
        self.assertLess(
            download_function.index("chooseStandaloneSaveHandle(filename)"),
            download_function.index("documentWithPortableState(source, currentPortableState())"),
        )
        self.assertIn("if (editingAnnotation) commitInlineNoteEdit()", download_function)
        self.assertIn("Score saved with settings and annotations", download_function)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_a_key_signature_without_a_mode_is_settled_by_the_music(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # An absent <mode> must not be read as a declaration of major.
        self.assertIn('.find((element) => element.localName === "mode")?.textContent || "").toLowerCase();', app)
        self.assertIn('const declared = mode.includes("minor") ? "minor" : mode.includes("major") ? "major" : null;', app)
        self.assertIn('const minor = declared ? declared === "minor" : soundsMinor(majorTonic);', app)

        start = app.index("  function soundsMinor")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
let sequence;
{app[start:end]}
// [track, startTick, endTick, key]; weight is how long each pitch class sounds
const note = (key, ticks) => [0, 0, ticks, key];
const run = (notes) => {{ sequence = {{ notes }}; return soundsMinor(0); }};   // C major vs A minor
console.log(JSON.stringify({{
  dwellsOnTheMinor: run([note(69, 1000), note(60, 200)]),
  dwellsOnTheMajor: run([note(60, 1000), note(69, 200)]),
  evenlySplit: run([note(60, 500), note(69, 500)]),
  justAheadIsNotEnough: run([note(69, 560), note(60, 500)]),
  clearlyAhead: run([note(69, 700), note(60, 500)]),
  octavesCountTogether: run([note(81, 600), note(57, 600), note(60, 500)]),
  silence: run([]),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertTrue(got["dwellsOnTheMinor"])
        self.assertFalse(got["dwellsOnTheMajor"])
        # Major keeps the benefit of the doubt when the two are close.
        self.assertFalse(got["evenlySplit"])
        self.assertFalse(got["justAheadIsNotEnough"])
        self.assertTrue(got["clearlyAhead"])
        self.assertTrue(got["octavesCountTogether"])
        self.assertFalse(got["silence"])

    def test_saved_practice_survives_a_rebuild_of_the_same_song(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Every key is named after the song, so a rebuild reads back what the
        # last one saved instead of starting over and orphaning it.
        for suffix in ("preferences", "settings-open", "pitch-trace", "notes"):
            self.assertIn(f'songKey("{suffix}")', app)
        self.assertIn('const songKey = (suffix) => `choir-practice:${config.slug || config.title || "score"}:${suffix}`;', app)
        keys = app.split("const songKey = (suffix)", 1)[1].split("setSettingsOpen(", 1)[0]
        for assigned in ("preferenceKey = ", "settingsPanelPreferenceKey = ", "pitchTraceKey = ", "annotationKey = "):
            line = keys.split(assigned, 1)[1].split("\n", 1)[0]
            self.assertIn("songKey(", line, f"{assigned} should be named after the song")
            self.assertNotIn("fingerprint", line, f"{assigned} must not depend on the build")
            self.assertNotRegex(line, r":v\d", f"{assigned} should carry no version suffix")
        # What is already stored under an older key moves across once.
        adopt = app.split("function storedValueFor(key, legacyKeys = []) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("localStorage.setItem(key, value);", adopt)
        self.assertIn("localStorage.removeItem(legacy);", adopt)
        # A contour belongs to the music it was sung against, not to the build.
        self.assertIn("buildMetadata.build?.playbackSha256", app)
        trace = app.split("function pitchTraceFingerprint()", 1)[1].split("\n  }", 1)[0]
        self.assertLess(trace.index("playbackSha256"), trace.index("fingerprint"))

    def test_portable_state_is_only_a_first_open_fallback(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        preferences = app.split("function loadPreferences()", 1)[1].split("function savePreferences()", 1)[0]
        self.assertLess(preferences.index("storedValueFor(preferenceKey, legacyPreferenceKeys)"),
                        preferences.index("portableStateForCurrentScore()?.preferences"))
        annotations = app.split("function loadAnnotations()", 1)[1].split("function currentAnnotationState()", 1)[0]
        self.assertLess(annotations.index("storedValueFor(annotationKey, legacyAnnotationKeys)"),
                        annotations.index("portableStateForCurrentScore()?.annotations"))
        self.assertIn('source = { key: "portable-state"', annotations)
        save_annotations = app.split("function saveAnnotations()", 1)[1].split("function annotationId", 1)[0]
        self.assertIn("localStorage.setItem(annotationKey", save_annotations)
        self.assertNotIn("localStorage.removeItem(annotationKey)", app)

    def test_template_supports_light_dark_and_light_print_themes(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('name="color-scheme" content="light dark"', document)
        self.assertIn('media="(prefers-color-scheme: dark)"', document)
        self.assertIn("@media (prefers-color-scheme: dark)", styles)
        self.assertIn(".at-surface-svg { filter: var(--score-filter); }", styles)
        self.assertIn(".at-surface-svg { filter: none; }", styles)
        self.assertIn("--group-top: var(--panel-solid)", styles)
        self.assertIn("--group-bottom: var(--panel-solid)", styles)
        self.assertIn(".settings-strip { background: var(--panel-solid); }", styles)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_demo_video_link_is_optional_and_set_at_runtime(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # The built file may carry no external reference, so the template ships an
        # inert, hidden link and the song config supplies the address later.
        self.assertRegex(
            document,
            r'<a class="icon-button display-demo" id="demoVideo" href="#" '
            r'target="_blank" rel="noopener noreferrer"[^>]* hidden>',
        )
        for address in ("youtu.be", "youtube.com", "https://"):
            self.assertNotIn(address, document.split('id="demoVideo"')[1].split("</a>")[0])
        utilities = document.split('class="control-group tools-group"', 1)[1]
        order = [utilities.index(f'id="{name}"') for name in
                 ("noteMode", "demoVideo", "printScore", "downloadScore", "download", "themeToggle", "settingsHelp")]
        self.assertEqual(order, sorted(order))
        self.assertIn(".display-demo[hidden] { display: none; }", styles)
        logo = document.split('id="demoVideo"', 1)[1].split("</a>", 1)[0]
        self.assertIn('viewBox="0 0 24 24"', logo)
        self.assertIn('fill="#ff0000"', logo)
        self.assertIn('fill="white"', logo)
        self.assertIn(".icon-button.display-demo svg { width: 24px; height: 24px; stroke: none; }", styles)
        self.assertIn('class="theme-sun"', document)
        self.assertIn('class="theme-moon"', document)
        self.assertIn('button.dataset.nextTheme = next;', document)
        self.assertIn("const demoVideo = demoVideoAddress(config.demoVideo);", app)
        self.assertIn("elements.demoVideo.hidden = false;", app)

        helper_start = app.index("  function demoVideoAddress")
        helper_end = app.index("  function preferenceDefaults", helper_start)
        script = f"""
{app[helper_start:helper_end]}
console.log(JSON.stringify([
  "https://youtu.be/_KEp0DETKEw", "http://example.org/a", "javascript:alert(1)",
  "data:text/html,x", "youtu.be/_KEp0DETKEw", "", undefined,
].map(demoVideoAddress)));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            json.loads(result.stdout),
            ["https://youtu.be/_KEp0DETKEw", "http://example.org/a", "", "", "", "", ""],
        )

    def test_settings_panel_is_always_collapsible_and_remembers_its_state(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('class="icon-button settings-toggle"', document)
        self.assertIn('class="settings-panel" id="settingsPanel" aria-hidden="true"', document)
        self.assertIn(".settings-toggle { position: relative; display: inline-grid; }", styles)
        self.assertIn(".settings-panel { display: none; border-top: 1px solid var(--line); }", styles)
        self.assertIn(".settings-panel.is-open { display: block; }", styles)
        self.assertIn("@media (max-width: 760px), (hover: none) and (pointer: coarse)", styles)
        self.assertIn('let settingsPanelPreferenceKey = "choir-practice:settings-open:v1"', app)
        self.assertIn("function isMobileSettingsDevice()", app)
        self.assertIn('window.matchMedia("(hover: none) and (pointer: coarse)").matches', app)
        self.assertIn("function loadSettingsOpenState()", app)
        self.assertIn("storedValueFor(settingsPanelPreferenceKey, legacySettingsPanelKeys)", app)
        self.assertIn('localStorage.setItem(settingsPanelPreferenceKey, expanded ? "open" : "closed")', app)
        self.assertIn("function setSettingsOpen(open, { persist = true } = {})", app)
        self.assertIn('settingsPanelPreferenceKey = songKey("settings-open");', app)
        self.assertIn("setSettingsOpen(loadSettingsOpenState(), { persist: false })", app)
        self.assertIn("if (isMobileSettingsDevice()) setSettingsOpen(false)", app)
        self.assertIn("--selection-highlight: color-mix(in srgb, var(--accent-bright) 14%, transparent)", styles)
        self.assertIn("--selection-highlight: color-mix(in srgb, var(--accent-bright) 19%, transparent)", styles)
        self.assertIn(".at-selection div {", styles)
        self.assertIn("background: var(--selection-highlight)", styles)

    def test_pitch_bar_view_and_microphone_feedback_are_offline_features(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn(build_trainer.PITCHY_MARKER, document)
        self.assertIn('id="scoreViewToggle"', document)
        self.assertIn('class="pill-toggle score-view-toggle"', document)
        self.assertIn('role="tablist" aria-label="Score view"', document)
        self.assertIn('>Pitchbar</button>', document)
        self.assertNotIn('data-score-view=', document)
        self.assertIn('id="pitchCapture"', document)
        self.assertNotIn('id="pitchConfidence"', document)
        self.assertNotIn('class="control-group pitch-group"', document)
        self.assertNotIn('id="pitchLabel">View', document)
        self.assertNotIn('id="erasePitchTrace"', document)
        self.assertIn('attachHoldReset(elements.pitchCapture, togglePitchCapture, clearPitchTrace', app)
        self.assertIn('id="barScore"', document)
        self.assertIn("function renderBarScore()", app)
        self.assertIn("function renderPitchTrace", app)
        self.assertIn("function evaluatePitchEvidence", app)
        self.assertIn("replacePitchTraceWindows", app)
        self.assertIn("const PITCH_CONFIDENCE_THRESHOLD = 0.7", app)
        self.assertIn("const threshold = PITCH_CONFIDENCE_THRESHOLD", app)
        self.assertNotIn("pitchConfidenceControl", app)
        self.assertIn("if (!pitchCaptureEnabled() || !playing) return", app)
        practice = document.split('class="control-group practice-group', 1)[1].split("</section>", 1)[0]
        display = document.split('class="control-group display-group', 1)[1].split("</section>", 1)[0]
        self.assertNotIn('id="scoreViewToggle"', practice)
        self.assertIn('id="pitchCapture"', practice)
        self.assertNotIn('<span>Erase</span>', practice)
        self.assertNotIn('<span>Trace</span>', practice)
        self.assertIn('id="noteMode"', document.split('class="control-group tools-group"', 1)[1])
        self.assertIn('aria-label="Add annotation at selected score position"', document)
        self.assertNotIn('<span>Note</span>', practice)
        self.assertIn('id="scoreViewToggle"', display)
        self.assertNotIn('id="pitchCapture"', display)
        self.assertIn('id="fullscreen"', display)
        self.assertIn('id="download"', document.split('class="control-group tools-group"', 1)[1])
        self.assertNotIn('class="control-group actions-group"', document)
        self.assertIn("pitchCaptureDetector.minVolumeAbsolute = 0", app)
        self.assertNotIn("adaptiveNoise", app)
        self.assertIn("rgb(${red} ${255 - red} 0)", app)
        self.assertIn('if (!Number.isFinite(errorCents)) return "rgb(255 0 0)"', app)
        self.assertNotIn("if (!traceColor) continue", app)
        self.assertNotIn("--pitch-trace-neutral", styles)
        self.assertIn(".bar-reattack-line", styles)
        self.assertIn(".bar-pitch-trace", styles)
        self.assertIn("--pitch-trace-halo", styles)
        self.assertIn("--bar-measure-font-size, 11px", styles)
        self.assertIn("--bar-lyric-font-size, 14px", styles)
        self.assertIn("const LYRIC_FONT_SIZE = 14", app)
        self.assertIn("function applyLyricFontSettings", app)
        self.assertIn("currentFont.withSize(LYRIC_FONT_SIZE)", app)
        self.assertIn("applyLyricFontSettings(settings)", app)
        self.assertIn('elements.barScore.style.setProperty("--bar-measure-font-size", `${measureFontSize}px`)', app)
        self.assertIn("const measureFontSize = 11 * typographyScale;", app)
        self.assertIn('elements.barScore.style.setProperty("--bar-lyric-font-size", `${lyricFontSize}px`)', app)
        self.assertIn("const lyricLineHeight = 17.5 * typographyScale", app)
        self.assertIn("function firstLyricLetterRange(text)", app)
        self.assertIn("function measuredSvgTextLength(element, start, length)", app)
        self.assertIn("function alignPitchBarLyricsToFirstLetter(systems)", app)
        self.assertIn('"data-onset-x": onsetX', app)
        self.assertIn("onsetX - (throughFirstLetterWidth - firstLetterWidth / 2)", app)
        self.assertIn("alignPitchBarLyricsToFirstLetter(nextSystems)", app)
        pitchbar_lyrics = app.split("function pitchBarLyrics()", 1)[1].split("function pitchStripe", 1)[0]
        self.assertIn("const track = practicePartIndex", pitchbar_lyrics)
        self.assertIn("practicePartIndex >= parts.length", pitchbar_lyrics)
        self.assertNotIn("visibleTracks.size", pitchbar_lyrics)
        practice_part_listener = app.split('elements.practicePart.addEventListener("input"', 1)[1].split("elements.mixLearn", 1)[0]
        self.assertIn('if (scoreView === "bars") scheduleBarRender()', practice_part_listener)
        self.assertIn('const unavailable = scoreView === "bars"', app)
        self.assertIn("elements.noteMode.disabled = unavailable", app)
        self.assertIn('"Annotate is available in standard notation"', app)

    def test_pitch_trace_uses_sixty_fourth_note_bins_and_incremental_svg_updates(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const PITCH_TRACE_STORAGE_VERSION = 3", app)
        self.assertIn("const PITCH_TRACE_BINS_PER_QUARTER = 16", app)
        # One contour per divisi line, each its own grid of bins.
        self.assertIn("const pitchTraceLanes = new Map()", app)
        self.assertIn("function pitchTraceBinTicks()", app)
        self.assertIn("(Number(sequence?.division) || 1) / PITCH_TRACE_BINS_PER_QUARTER", app)
        self.assertIn("function packedPitchTraceBreaks(breaks)", app)
        self.assertIn("function loadPitchTraceV3(stored)", app)
        self.assertIn("function loadPitchTraceV2(stored)", app)
        self.assertIn("pitches: bytesToBase64(new Uint8Array(", app)
        self.assertIn("breaks: bytesToBase64(packedPitchTraceBreaks(lane.breaks))", app)
        self.assertNotIn("PITCH_TRACE_MAX_SAMPLES", app)
        self.assertNotIn("pitchTraceSamples", app)
        self.assertNotIn("pitchTraceSegment", app)

        incremental = app.split("function updatePitchTraceIncrementally(changed)", 1)[1].split("function pitchBarRepeatSign", 1)[0]
        self.assertIn('scoreView === "bars" ? barSystems : staffTraceSystems', incremental)
        # Every step is scoped to the line that changed, so a take of one line
        # cannot redraw or erase another line's contour.
        self.assertIn("removePitchTraceEdgesAtBin(system, line, bin)", incremental)
        self.assertIn("previousOccupiedPitchBin(lane, bin)", incremental)
        self.assertIn("nextOccupiedPitchBin(lane, bin)", incremental)
        self.assertIn("appendPitchTraceEdge(system, line, lane,", incremental)
        self.assertNotIn("replaceChildren", incremental)
        self.assertNotIn("querySelectorAll", incremental)

        self.assertIn("traceEdges: new Map(), traceEdgesByBin: new Map()", app)

        replacement = app.split("function replacePitchTraceWindows(frames)", 1)[1].split("function beginPitchCapturePass()", 1)[0]
        self.assertIn("updatePitchTraceIncrementally(changed)", replacement)
        self.assertNotIn("renderPitchTrace()", replacement)
        self.assertNotIn("clarity", replacement)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pitch_trace_grades_rests_from_previous_note_over_one_semitone(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        helper_start = app.index("  function expectedPitchAt")
        helper_end = app.index("  function pitchTraceBinTicks", helper_start)
        helpers = app[helper_start:helper_end]
        script = f"""
const sequence = {{ notes: [[0, 120, 480, 60], [0, 960, 1440, 62], [1, 0, 720, 67]] }};
const visibleTracks = new Set([0]);
// No part chosen, so grading falls back to the nearest note on screen.
const practicePartIndex = null;
const practiceLines = [];
const partDivisi = [];
const divisiSpanAt = () => null;
const divisiLineFor = () => 0;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const PITCH_TRACE_GREEN_TOLERANCE_CENTS = 10;
const PITCH_TRACE_RED_CENTS = 50;
{helpers}
console.log(JSON.stringify({{
  beforeFirst: expectedPitchErrorCents(0, 6000),
  active: expectedPitchErrorCents(240, 6050),
  restExact: expectedPitchErrorCents(600, 6000),
  restSharp: expectedPitchErrorCents(600, 6050),
  colors: [
    pitchTraceColor(0),
    pitchTraceColor(10),
    pitchTraceColor(30),
    pitchTraceColor(50),
    pitchTraceColor(-100),
  ],
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        values = json.loads(result.stdout)
        self.assertIsNone(values["beforeFirst"])
        self.assertEqual(values["active"], 50)
        self.assertEqual(values["restExact"], 0)
        self.assertEqual(values["restSharp"], 50)
        self.assertEqual(
            values["colors"],
            [
                "rgb(0 255 0)",
                "rgb(0 255 0)",
                "rgb(128 127 0)",
                "rgb(255 0 0)",
                "rgb(255 0 0)",
            ],
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_dynamics_are_printed_per_staff_not_per_voice(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        helper_start = app.index("  function staffDynamicChangesAt")
        helper_end = app.index("  function preferenceDefaults", helper_start)
        helpers = app[helper_start:helper_end]
        self.assertIn("installStaffLevelDynamics();", app[helper_end:])

        def note(voice: int, duration: int, rest: bool = False) -> str:
            kind = {1: "quarter", 2: "half", 4: "whole"}[duration]
            body = "<rest/>" if rest else "<pitch><step>A</step><octave>4</octave></pitch>"
            return f"<note>{body}<duration>{duration}</duration><voice>{voice}</voice><type>{kind}</type></note>"

        def dynamic(mark: str) -> str:
            return f"<direction><direction-type><dynamics><{mark}/></dynamics></direction-type></direction>"

        backup = "<backup><duration>4</duration></backup>"
        measures = [
            # 1: the staff starts pp.
            "<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>"
            "<clef><sign>G</sign><line>2</line></clef></attributes>" + dynamic("pp") + note(1, 4),
            # 2: a second voice sounds for the first time. Nothing changed.
            note(1, 4) + backup + note(2, 1) * 4,
            # 3: p on beat 3 of voice 1. The importer leaks it onto voice 2's whole note.
            note(1, 1) * 2 + dynamic("p") + note(1, 1) * 2 + backup + note(2, 4),
            # 4: mf on beat 2 while voice 1 rests, so only voice 2 can show it.
            note(1, 1) + dynamic("mf") + note(1, 2, rest=True) + note(1, 1) + backup + note(2, 1) * 4,
        ]
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list>'
            '<score-part id="P1"><part-name>Alto</part-name></score-part></part-list><part id="P1">'
            + "".join(f'<measure number="{index + 1}">{body}</measure>' for index, body in enumerate(measures))
            + "</part></score-partwise>"
        )
        # Function scope matters: under `node -e` a top-level `window` is a real
        # global, and AlphaTab probes `typeof window` while it is still loading.
        script = f"""
(() => {{
const alphaTab = require({json.dumps(str(ROOT / "vendor" / "alphatab" / "alphaTab.min.js"))});
const window = {{ alphaTab }};
{helpers}
installStaffLevelDynamics();
let effect = null;
for (const factory of alphaTab.Environment.defaultRenderers) {{
  for (const band of factory.effectBands) {{
    if (band.effect.notationElement === alphaTab.NotationElement.EffectDynamics) effect = band.effect;
  }}
}}
const settings = new alphaTab.Settings();
const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode({json.dumps(xml)}), settings);
const printed = () => {{
  const marks = [];
  for (const bar of score.tracks[0].staves[0].bars) for (const voice of bar.voices) for (const beat of voice.beats) {{
    if (effect.shouldCreateGlyph(settings, beat)) {{
      marks.push([bar.index + 1, voice.index + 1, beat.playbackStart, alphaTab.model.DynamicValue[beat.dynamics]]);
    }}
  }}
  return marks;
}};
const shown = printed();
score.stylesheet.hideDynamics = true;
console.log(JSON.stringify({{ shown, hidden: printed() }}));
}})();
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        values = json.loads(result.stdout)
        self.assertEqual(values["shown"], [[1, 1, 0, "PP"], [3, 1, 1920, "P"], [4, 2, 960, "MF"]])
        self.assertEqual(values["hidden"], [])

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_inlined_pitchy_runtime_detects_a_synthetic_tone(self) -> None:
        runtime = build_trainer.pitchy_browser_runtime(
            (ROOT / "vendor" / "fft" / "fft.js").read_text(encoding="utf-8"),
            (ROOT / "vendor" / "pitchy" / "index.js").read_text(encoding="utf-8"),
        )
        self.assertNotIn("module.exports", runtime)
        self.assertNotIn('import FFT from "fft.js"', runtime)
        build_trainer.verify_pitchy_runtime(runtime)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pitch_view_reference_line_prioritizes_harmonic_anchors(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        helper_start = app.index("  function pitchesOfClassInRange")
        helper_end = app.index("  function configurePitchGuides", helper_start)
        helpers = app[helper_start:helper_end]
        script = f"""
let scoreKeyPitchClasses = {{ tonic: 7, dominant: 2, third: 11 }};
{helpers}
console.log(JSON.stringify([
  pitchGuideRange(55, 72),
  pitchGuideRange(60, 65),
  pitchGuideRange(68, 72),
  pitchGuideRange(63, 65),
  pitchGuideRange(64, 65)
]));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        tonic, dominant, third, expanded, tied = json.loads(result.stdout)
        self.assertEqual((tonic["referencePitch"], tonic["referenceKind"]), (67, "tonic"))
        self.assertEqual((dominant["referencePitch"], dominant["referenceKind"]), (62, "dominant"))
        self.assertEqual((third["referencePitch"], third["referenceKind"]), (71, "third"))
        self.assertEqual((expanded["minPitch"], expanded["referencePitch"]), (62, 62))
        self.assertEqual((tied["maxPitch"], tied["referencePitch"], tied["referenceKind"]), (67, 67, "tonic"))

    def test_playback_cursor_is_clipped_to_visible_staff_lines(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("function trimPlaybackCursor()", app)
        self.assertIn('cursor.style.setProperty("--cursor-clip-top"', app)
        self.assertIn('cursor.style.setProperty("--cursor-clip-bottom"', app)
        self.assertIn("clip-path: inset(var(--cursor-clip-top", styles)

    def test_vertical_follow_arrives_at_the_next_system_on_time(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const FOLLOW_CHECK_INTERVAL_MS = 60", app)
        self.assertIn("const FOLLOW_SCROLL_LEAD_BUFFER_MS = 80", app)
        self.assertIn("function followScrollDuration(distance)", app)
        self.assertIn("Math.sqrt(Math.max(0, distance)) * 8", app)
        self.assertIn("function animateVerticalFollow(destination, duration)", app)
        self.assertIn(
            'window.scrollTo({ top: start + distance * eased, behavior: "auto" })',
            app,
        )
        self.assertIn("function nextVerticalSystemTransition(cursor)", app)
        self.assertIn("barSystems[systemIndex + 1]", app)
        self.assertIn("masterBarLayoutBox(index)", app)
        self.assertIn(
            "engine.secondsAtTick(transition.tick) - engine.currentSeconds()", app
        )
        self.assertIn(
            "(duration + FOLLOW_SCROLL_LEAD_BUFFER_MS) / 1000", app
        )
        self.assertIn(
            "predictiveFollowRange = { startTick: transition.currentTick, targetTick: transition.tick }",
            app,
        )
        self.assertIn("const end = loopTickRange().end;", app)
        self.assertIn("transition.tick >= end", app)
        self.assertIn("else predictiveVerticalFollow(cursor)", app)
        self.assertIn(
            'window.addEventListener("pointerdown", interruptVerticalFollow', app
        )
        self.assertIn('window.addEventListener("wheel", interruptVerticalFollow', app)
        self.assertGreaterEqual(app.count("cancelVerticalFollowAnimation(true)"), 6)

    def test_rotated_pan_dials_cannot_create_vertical_mixer_scroll(self) -> None:
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        mixer_scroll = styles.split(".mixer-scroll {", 1)[1].split("}", 1)[0]
        pan_arc = styles.split(".pan-arc {", 1)[1].split("}", 1)[0]
        self.assertIn("overflow-x: auto", mixer_scroll)
        self.assertIn("overflow-y: hidden", mixer_scroll)
        self.assertIn("overflow: hidden", pan_arc)
        self.assertIn("contain: paint", pan_arc)

    def test_chapter_scrubber_keeps_markers_visible_and_snaps_during_drag(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("let chapterSeekMilliseconds = [];", app)
        self.assertIn("function snapSeekMilliseconds(milliseconds)", app)
        self.assertIn("function chapterSnapBoundsMilliseconds(chapterMilliseconds)", app)
        self.assertIn("const measureDurationTicks", app)
        self.assertIn("chapterTick - measureDurationTicks", app)
        self.assertIn("chapterTick + measureDurationTicks", app)
        self.assertIn("if (value < lower || value > upper) return best", app)
        self.assertIn("return nearest?.point ?? value", app)
        self.assertIn("function adjacentChapterMilliseconds(milliseconds, direction)", app)
        self.assertIn("function previewSeek(milliseconds, updateScore = false)", app)
        seek_input = app.split('elements.seek.addEventListener("input", () => {', 1)[1].split("});", 1)[0]
        self.assertIn("previewSeek(Number(elements.seek.value), true)", seek_input)
        self.assertLess(app.index("engine = new GuideEngine(sequence);"), app.index("buildTimelineSegments();", app.index("engine = new GuideEngine(sequence);")))
        self.assertIn('class="timeline-track"', document)
        self.assertIn("--seek-thumb-size: 16px", styles)
        self.assertIn(".timeline-track::after", styles)
        self.assertIn("right: calc(var(--seek-thumb-size) / 2)", styles)
        self.assertIn("left: calc(var(--seek-thumb-size) / 2)", styles)
        self.assertIn("width: var(--seek-progress, 0%)", styles)
        timeline_rule = styles.split(".timeline-segments {", 1)[1].split("}", 1)[0]
        self.assertIn("z-index: 3", timeline_rule)
        self.assertIn("background: transparent", timeline_rule)
        self.assertIn("background: var(--timeline-chapter-marker)", styles)

    def test_full_measure_rests_are_centered_in_the_post_signature_span(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function centerFullMeasureRests()", app)
        self.assertIn('rest.textContent !== "\\uE4E3"', app)
        self.assertIn("api.boundsLookup || api.renderer?.boundsLookup", app)
        self.assertIn("beat.beat.isFullBarRest", app)
        self.assertIn("const box = beat.realBounds", app)
        self.assertIn("x: box.x + box.w / 2", app)
        self.assertNotIn("const targetX = bar.x + bar.width / 2", app)
        self.assertIn('group.dataset.fullRestCentered = "true"', app)
        self.assertIn("function scheduleFullMeasureRestCentering()", app)
        self.assertIn("if (frame < 8) requestAnimationFrame(centerAfterPaint)", app)
        self.assertIn("scheduleFullMeasureRestCentering();", app)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_following_playback_parks_the_music_on_the_reading_line(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Both the catch-up scroll and the predictive one aim at the same line;
        # neither settles for the minimum that merely brings the system on screen.
        self.assertIn("window.scrollY + bounds.top - readingLine(bounds.height, topLimit, bottomLimit)", app)
        self.assertIn("transition.bounds.top - readingLine(targetHeight, topLimit, bottomLimit)", app)
        self.assertNotIn("window.scrollY + bounds.bottom - bottomLimit", app)

        start = app.index("  function readingLine")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
{app[start:end]}
const top = 100, bottom = 800;          // a 700px reading band
console.log(JSON.stringify({{
  shortSystem: readingLine(80, top, bottom),
  averageSystem: readingLine(200, top, bottom),
  justUnderTheLimit: readingLine(559, top, bottom),
  tallSystem: readingLine(560, top, bottom),
  tallerThanTheBand: readingLine(900, top, bottom),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # A fifth of the way down the band, leaving the rest as lookahead.
        self.assertEqual(got["shortSystem"], 240)
        self.assertEqual(got["averageSystem"], 240)
        self.assertEqual(got["justUnderTheLimit"], 240)
        # A system that would not fit below that line hangs from the top instead.
        self.assertEqual(got["tallSystem"], 100)
        self.assertEqual(got["tallerThanTheBand"], 100)

    def test_tapping_the_part_pager_moves_to_the_next_part(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # startY is moved as the wheel wraps, so the tap test needs a fixed origin.
        self.assertIn("startY: event.clientY, originY: event.clientY, originX: event.clientX, moved: false", app)
        self.assertIn("if (Math.hypot(event.clientX - this.drag.originX, event.clientY - this.drag.originY) > 4) this.drag.moved = true;", app)
        release = app.split("    release(event) {", 1)[1].split("\n    }", 1)[0]
        self.assertIn("if (!drag.moved) {", release)
        self.assertIn("this.step(1);", release)
        # The tap is decided before the drag branches, so neither runs for a tap.
        self.assertLess(release.index("if (!drag.moved) {"), release.index("if (drag.unset) {"))

    def test_practice_part_prompt_is_not_a_cyclic_pager_value(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn('{ value: null, label: "Choose part" }', app)
        self.assertIn('placeholder: "Choose part"', app)
        self.assertIn(".practice-part-pager.has-part", styles)
        self.assertIn('elements.practicePart.style.setProperty("--part-color"', app)
        self.assertIn("populateLayer(layer, option", app)
        self.assertIn("color: part.color", app)
        self.assertIn(".practice-part-layer.has-option-color", styles)
        self.assertIn("--pager-option-color", styles)
        self.assertIn("box-shadow: inset 0 -1px", styles)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_holding_a_part_leaves_only_that_part_on_its_own_row(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const MIXER_SOLO_HOLD_MS = 500;", app)
        # The row a press lands on supplies its own reader and writer, so a
        # solo in See can never reach Hear.
        self.assertIn('on: (part) => visibleTracks.has(part), set: setTrackVisibility', app)
        self.assertIn('on: (part) => audibleTracks.has(part), set: setTrackAudible', app)
        # See/Hear isolate, Vol cycles its mix, and Pan separates stereo:
        # none may also trigger the generic individual reset on a touch hold.
        mixer = app.split("  function buildMixer()", 1)[1].split("  function ", 1)[0]
        self.assertEqual(mixer.count("{ holdToReset: false }"), 4)

        pieces = []
        for name in ("aloneOnItsRow", "turnOnEveryPart", "soloRow", "pressRow"):
            start = app.index(f"  function {name}(")
            pieces.append(app[start:app.index("\n  }", start) + len("\n  }")])
        script = """
%s
// on() answers with a real boolean, as Set.has does, because the rule
// compares it strictly against part === row.index.
const row = (index) => ({ index, on: (part) => state[part] === true, set: (part, next) => {
  // the real setter refuses to empty a row, and the rule must not depend on that
  if (!next && state.filter(Boolean).length === 1 && state[part]) return;
  state[part] = next === true;
} });
let state;
const run = (start, index, action) => { state = start.map((v) => v === 1);
  action(row(index), start.length); return state.map((v) => (v ? 1 : 0)).join(""); };
console.log(JSON.stringify({
  pressTurnsOneOff: run([1,1,1,1], 1, pressRow),
  pressTurnsOneBackOn: run([1,0,1,1], 1, pressRow),
  holdLeavesOnlyThatPart: run([1,1,1,1], 2, soloRow),
  holdFromAPartThatIsOff: run([1,1,0,1], 2, soloRow),
  holdOnTheLastOneStanding: run([0,0,1,0], 2, soloRow),
  pressOnTheLastOneStanding: run([0,0,1,0], 2, pressRow),
  pressOnAnotherWhileSoloed: run([0,0,1,0], 0, pressRow),
  holdWhenTwoAreOn: run([1,0,1,0], 0, soloRow),
  soloOfOneSinglePart: run([1], 0, soloRow),
}));
""" % "\n".join(pieces)
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["pressTurnsOneOff"], "1011")
        self.assertEqual(got["pressTurnsOneBackOn"], "1111")
        self.assertEqual(got["holdLeavesOnlyThatPart"], "0010")
        # The kept part is switched on first, so the row never has to empty.
        self.assertEqual(got["holdFromAPartThatIsOff"], "0010")
        # Nothing on is never wanted, so the last one standing puts them back,
        # by hold or by a plain press.
        self.assertEqual(got["holdOnTheLastOneStanding"], "1111")
        self.assertEqual(got["pressOnTheLastOneStanding"], "1111")
        # A press on a different part while one is soloed is an ordinary toggle.
        self.assertEqual(got["pressOnAnotherWhileSoloed"], "1010")
        self.assertEqual(got["holdWhenTwoAreOn"], "1000")
        self.assertEqual(got["soloOfOneSinglePart"], "1")

    def test_practice_mix_presets_live_on_part_volume_holds(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn('<span>Part</span>', document)
        self.assertNotIn('id="mixLearn"', document)
        self.assertNotIn('id="mixCheck"', document)
        self.assertNotIn("renderPracticeMixIcon", app)
        # A hold both cycles the mix and records that the gesture is known,
        # so its once-only tip never appears after the singer has used it.
        self.assertIn('onHold: () => {\n          learnShortcut("vol-hold");\n          cyclePartVolumeMix(index);', app)
        self.assertIn('onHold: () => {\n          learnShortcut("pan-hold");\n          togglePartPanSeparation(index);', app)
        self.assertIn('button.dataset.volumeIndex = String(index)', app)
        self.assertIn('button.setAttribute("aria-keyshortcuts", "Shift+Enter")', app)
        self.assertIn("practiceMixPart: practiceMixPartIndex", app)
        active_preset_rule = styles.split('.drag-number.is-mix-target {', 1)[1].split("}", 1)[0]
        self.assertIn("background: var(--selection-highlight)", active_preset_rule)
        self.assertIn("border-color: color-mix(in srgb, var(--part-color)", active_preset_rule)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_volume_row_label_rides_every_part_together(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("attachGroupDrag(volumeLabel, volumeControls, VOLUME_VALUES, 4);", app)
        self.assertIn('volumeLabel.classList.add("is-group-drag");', app)
        self.assertIn('volumeLabel.setAttribute("aria-label", "All part volumes");', app)
        label_rule = styles.split(".mixer-row-label.is-group-drag {", 1)[1].split("}", 1)[0]
        self.assertIn("cursor: ns-resize", label_rule)
        self.assertIn("touch-action: none", label_rule)

        start = app.index("  function attachGroupDrag")
        end = app.index("\n  }", start) + len("\n  }")
        helper = app.index("  function nearestAllowed")
        helper_end = app.index("\n  }", helper) + len("\n  }")
        script = f"""
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
{app[helper:helper_end]}
{app[start:end]}
const VALUES = Array.from({{ length: 31 }}, (_, i) => i * 5);   // 0..150 by 5
const handlers = {{}};
const label = {{
  addEventListener: (type, fn) => {{ handlers[type] = fn; }},
  setPointerCapture: () => {{ label.captured = true; }},
  hasPointerCapture: () => label.captured === true,
  releasePointerCapture: () => {{ label.captured = false; }},
}};
const make = (start) => {{ let v = start; return {{ value: () => v, setValue: (next) => {{ v = next; }} }}; }};
const controls = [make(100), make(60), make(90), make(40)];
attachGroupDrag(label, controls, VALUES, 4);
const read = () => controls.map((c) => c.value());
const drag = (dy) => {{ handlers.pointermove({{ pointerId: 1, clientY: 200 - dy }}); return read(); }};
handlers.pointerdown({{ button: 0, pointerId: 1, clientY: 200, preventDefault() {{}} }});
const out = {{
  start: read(),
  upTwoSteps: drag(8),
  upTenSteps: drag(40),
  pinnedByTheLoudestPart: drag(400),
  backToStart: drag(0),
  pinnedByTheQuietestPart: drag(-400),
}};
handlers.pointerup({{ pointerId: 1 }});
handlers.keydown({{ key: "ArrowUp", preventDefault() {{}} }});
out.afterArrowUp = read();
handlers.keydown({{ key: "ArrowDown", preventDefault() {{}} }});
out.afterArrowDown = read();
handlers.keydown({{ key: "a", preventDefault() {{}} }});
out.afterUnrelatedKey = read();
console.log(JSON.stringify(out));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["start"], [100, 60, 90, 40])
        self.assertEqual(got["upTwoSteps"], [110, 70, 100, 50])
        self.assertEqual(got["upTenSteps"], [150, 110, 140, 90])
        # The loudest part reaches 150 first and the shift stops there, so the
        # spread between parts is never squashed.
        self.assertEqual(got["pinnedByTheLoudestPart"], [150, 110, 140, 90])
        self.assertEqual(got["pinnedByTheQuietestPart"], [60, 20, 50, 0])
        # Returning to where the drag began restores the mix exactly.
        self.assertEqual(got["backToStart"], [100, 60, 90, 40])
        for state in ("upTwoSteps", "upTenSteps", "pinnedByTheLoudestPart", "pinnedByTheQuietestPart"):
            self.assertEqual(
                [v - got[state][0] for v in got[state]],
                [0, -40, -10, -60],
                f"{state} changed the balance between parts",
            )
        self.assertEqual(got["afterArrowUp"], [65, 25, 55, 5])
        self.assertEqual(got["afterArrowDown"], [60, 20, 50, 0])
        self.assertEqual(got["afterUnrelatedKey"], [60, 20, 50, 0])

    def test_practice_choice_reset_retains_snapshot_but_volume_cycle_normalizes(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("let activePracticeMix = null;", app)
        self.assertIn("let practiceMixUndo = null;", app)
        self.assertIn("function snapshotPracticeMix()", app)
        self.assertIn("function restorePracticeMix()", app)
        self.assertIn("activePracticeMix === mode && practiceMixUndo && restorePracticeMix()", app)
        self.assertIn('showToast("Previous mix restored")', app)
        self.assertIn("practiceMixMode: activePracticeMix", app)
        self.assertIn('"set all voices to 100%"', app)
        self.assertIn('function nextPartVolumeMix(partIndex)', app)
        self.assertIn('showToast("All voices at 100%")', app)
        self.assertGreaterEqual(app.count("cancelPracticeMixSession();"), 4)

    def test_contextual_resets_are_hierarchical_accessible_and_undoable(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn('id="reset"', document)
        self.assertIn('id="toastUndo"', document)
        self.assertIn("function captureSettingsState()", app)
        self.assertIn("function performScopedReset(", app)
        self.assertIn("function registerResetTarget(", app)
        self.assertIn('addEventListener("contextmenu"', app)
        self.assertIn('event.key !== "ContextMenu"', app)
        self.assertIn('event.shiftKey && event.key === "F10"', app)
        self.assertIn("}, 600);", app)
        self.assertIn('registerResetTarget(document.getElementById("partsLabel")', app)
        self.assertIn('appendMixerLabel("Hear"', app)
        self.assertIn("showToast(`${label} reset`", app)
        self.assertIn("applySettingsState(before)", app)
        self.assertIn('[data-reset-label="true"]', styles)
        reset_label_rule = styles.split('[data-reset-label="true"] {', 1)[1].split("}", 1)[0]
        self.assertNotIn("cursor:", reset_label_rule)
        self.assertNotIn("context-menu", styles)
        self.assertIn(".toast.has-action", styles)

    def test_practice_speed_and_metronome_volume_labels_are_compact(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn(">Speed</span>", document)
        self.assertNotIn("<span>Tempo</span>", document)
        self.assertIn('class="control-stack tempo-column"', document)
        self.assertIn('class="metronome-label"', document)
        self.assertRegex(document, r'</svg>\s+Vol\s+</span>')
        self.assertIn('aria-label="Metronome volume"', document)
        self.assertIn(".metronome-label svg", styles)
        self.assertIn("User-selected metronome silhouette", document)
        self.assertIn('<svg viewBox="0 0 314 314" focusable="false">', document)
        self.assertIn('M281.853,46.631c-0.39-2.035', document)
        tempo_icon_rule = styles.split(".metronome-label svg {", 1)[1].split("}", 1)[0]
        self.assertIn("fill: currentColor", tempo_icon_rule)
        self.assertIn("stroke: none", tempo_icon_rule)
        self.assertNotIn('class="tempo-column-heading"', document)

    def test_practice_controls_have_a_reversible_four_row_layout(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('class="control-group practice-group"', document)
        self.assertIn('class="number-control practice-speed"', document)
        self.assertIn('class="number-control practice-metronome-volume"', document)
        self.assertNotIn('id="dynamics"', document)
        self.assertNotIn("dynamicsEnabled", app)
        self.assertNotIn("setDynamics", app)
        self.assertIn("clamp((n.velocity || 84) / 84, 0.45, 1.28)", app)
        self.assertIn('class="loop-pill"', document)
        self.assertIn('class="icon-button binary-icon-button sing-control"', document)
        self.assertIn('<span>Sing</span>', document)
        self.assertNotIn('<span>Mic</span>', document)
        self.assertNotIn("data-tooltip", document)
        rule = styles.split(".practice-group {", 1)[1].split("}", 1)[0]
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr))", rule)
        self.assertIn("grid-template-rows: repeat(4, var(--toolbar-row-height))", rule)
        self.assertIn("gap: var(--toolbar-row-gap)", rule)
        self.assertNotIn('id="loopClear"', document)
        self.assertIn('attachHoldReset(elements.loopStart', app)
        self.assertIn('attachHoldReset(elements.loopEnd', app)
        sing = styles.split(".sing-control.icon-button {", 1)[1].split("}", 1)[0]
        self.assertIn("grid-row: 2 / 4", sing)
        self.assertIn("grid-column: 3", sing)

    def test_touch_mixer_rows_grow_only_for_coarse_pointers(self) -> None:
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        touch = styles.split("@media (hover: none) and (pointer: coarse) {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn(".mixer { --toolbar-row-height: 36px; }", touch)
        # Only the mixer grows; the four-row groups keep the shared rhythm and a
        # narrow desktop window keeps the compact rows.
        self.assertNotIn(".settings-strip", touch)
        narrow = styles.split("@media (max-width: 760px), (hover: none) and (pointer: coarse) {", 1)[1].split("\n}\n", 1)[0]
        self.assertNotIn("--toolbar-row-height:", narrow)

    def test_first_visit_and_scrub_overlays_start_hidden(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        chooser = document.split('<aside class="part-chooser"', 1)[1].split(">", 1)[0]
        # Script decides whether to ask, so nothing flashes for a returning singer.
        self.assertIn('role="dialog" aria-modal="false"', chooser)
        self.assertTrue(chooser.rstrip().endswith("hidden"))
        self.assertIn('<div class="scrub-label" id="scrubLabel" aria-hidden="true" hidden></div>', document)
        printed = styles.split("@media print {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn(".part-chooser,", printed)
        self.assertIn(".scrub-label,", printed)

    def test_percentage_controls_have_one_fixed_width(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        rule = styles.split(".drag-number {", 1)[1].split("}", 1)[0]
        self.assertIn("width: var(--toolbar-unit-width)", rule)
        self.assertIn("min-width: var(--toolbar-unit-width)", rule)
        self.assertIn("max-width: var(--toolbar-unit-width)", rule)
        mixer_rule = styles.split(".mixer {", 1)[1].split("}", 1)[0]
        self.assertIn("grid-template-columns: var(--toolbar-unit-width)", mixer_rule)
        self.assertIn("repeat(var(--part-count), var(--toolbar-unit-width))", mixer_rule)
        self.assertNotIn("grid-template-columns: 30px", mixer_rule)
        mixer_label_rule = styles.split(".mixer-row-label {", 1)[1].split("}", 1)[0]
        self.assertIn("width: var(--toolbar-unit-width)", mixer_label_rule)
        self.assertIn("height: var(--toolbar-row-height)", mixer_label_rule)
        self.assertIn("display: grid", mixer_label_rule)
        self.assertIn("place-items: center", mixer_label_rule)
        self.assertIn("padding: 0", mixer_label_rule)
        self.assertIn("text-align: center", mixer_label_rule)
        self.assertNotIn("padding-right", mixer_label_rule)
        drag_number = app.split("function createDragNumber", 1)[1].split("function createPanRing", 1)[0]
        self.assertIn("const delta = startY - event.clientY", drag_number)
        self.assertIn("if (indexDelta !== 0 || Math.hypot(event.clientX - startX, delta) > 8) clearHold()", drag_number)
        self.assertIn("update(dragValues[clamp(startIndex + indexDelta, 0, dragValues.length - 1)])", drag_number)
        self.assertIn("const changed = nextValue !== value", drag_number)
        self.assertIn('if (changed && emit) button.dispatchEvent(new Event("input", { bubbles: true }))', drag_number)
        self.assertIn('typeof options.stepValues === "function"', drag_number)
        self.assertIn("dragValues = interactionValues()", drag_number)
        self.assertIn("cursor: ns-resize", rule)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_crowded_pitchbar_syllables_step_down_a_line(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertNotIn("PITCH_BAR_LYRIC_LANES", app)
        self.assertIn("packPitchBarLyrics(nextSystems);", app)
        # Lanes are decided after the syllables have been measured and aligned,
        # so the widths are the real ones.
        self.assertLess(app.index("alignPitchBarLyricsToFirstLetter(nextSystems);"),
                        app.index("packPitchBarLyrics(nextSystems);"))

        start = app.index("  function assignLyricLanes")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
{app[start:end]}
const run = (syllables) => assignLyricLanes(syllables, 2);
const word = (left, width) => ({{ left, width }});
console.log(JSON.stringify({{
  roomForEveryone: run([word(0, 20), word(30, 20), word(60, 20)]),
  oneCollision: run([word(0, 20), word(10, 20), word(60, 20)]),
  runOfThree: run([word(0, 30), word(10, 30), word(20, 30)]),
  backToTheTopAfterAGap: run([word(0, 30), word(10, 30), word(100, 10)]),
  denserThanTheLinesAllow: run([word(0, 40), word(5, 40), word(10, 40), word(15, 10)]),
  single: run([word(0, 20)]),
  none: run([]),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["roomForEveryone"], {"lanes": [0, 0, 0], "lineCount": 1})
        self.assertEqual(got["oneCollision"], {"lanes": [0, 1, 0], "lineCount": 2})
        self.assertEqual(got["runOfThree"], {"lanes": [0, 1, 2], "lineCount": 3})
        self.assertEqual(got["backToTheTopAfterAGap"], {"lanes": [0, 1, 0], "lineCount": 2})
        # Dense runs get another line rather than knowingly overlapping words.
        self.assertEqual(got["denserThanTheLinesAllow"], {"lanes": [0, 1, 2, 3], "lineCount": 4})
        self.assertEqual(got["single"], {"lanes": [0], "lineCount": 1})
        # An empty verse still claims the one line the layout reserved for it.
        self.assertEqual(got["none"], {"lanes": [], "lineCount": 1})

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_hyphens_give_way_before_a_word_is_split_across_lines(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const PITCH_BAR_HYPHEN_LEEWAY = 2;", app)
        # The hyphens have to be settled before the lanes are handed out, or the
        # packing would be measuring widths it is about to lose.
        self.assertLess(app.index("        relaxLyricHyphens(syllables);"),
                        app.index("        const { lanes, lineCount } = assignLyricLanes(syllables, gap);"))
        self.assertLess(app.index("        const { lanes, lineCount } = assignLyricLanes(syllables, gap);"),
                        app.index("        restoreSplitWordHyphens(syllables, lanes, gap);"))

        def extract(name: str) -> str:
            start = app.index(f"  function {name}")
            return app[start:app.index("\n  }", start) + len("\n  }")]

        script = f"""
const PITCH_BAR_HYPHEN_LEEWAY = 2;
{extract("assignLyricLanes")}
{extract("relaxLyricHyphens")}
{extract("restoreSplitWordHyphens")}
const gap = 2;
const run = (syllables) => {{
  relaxLyricHyphens(syllables);
  const {{ lanes, lineCount }} = assignLyricLanes(syllables, gap);
  restoreSplitWordHyphens(syllables, lanes, gap);
  return {{ lanes, lineCount, hyphens: syllables.map((s) => !s.trimmed && s.hyphenWidth > 0) }};
}};
const part = (left, width, hyphenWidth = 4) => ({{ left, width, hyphenWidth }});
const plain = (left, width) => ({{ left, width, hyphenWidth: 0 }});
console.log(JSON.stringify({{
  roomForTheHyphen: run([part(0, 20), plain(40, 15)]),
  hyphenDroppedToStayOnOneLine: run([part(0, 20), plain(21, 15)]),
  wholeWordFitsOnceUnhyphenated: run([part(0, 20), part(21, 20), plain(43, 15)]),
  splitAnywayKeepsItsHyphen: run([part(0, 20), plain(17, 15), plain(60, 15)]),
  splitWithNoRoomLosesIt: run([part(0, 20), plain(17, 15), plain(19, 15)]),
  lastSyllableIsLeftAlone: run([plain(0, 15), part(40, 20)]),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # The dash needs its own width and as much again, measured from the last
        # letter; twenty pixels is room to spare, so nothing changes.
        self.assertEqual(got["roomForTheHyphen"], {"lanes": [0, 0], "lineCount": 1, "hyphens": [True, False]})
        # Five pixels is not, and dropping the dash saves the line break.
        self.assertEqual(got["hyphenDroppedToStayOnOneLine"],
                         {"lanes": [0, 0], "lineCount": 1, "hyphens": [False, False]})
        # "Fa- mil- iar" reads better as "Fa mil iar" on one line.
        self.assertEqual(got["wholeWordFitsOnceUnhyphenated"],
                         {"lanes": [0, 0, 0], "lineCount": 1, "hyphens": [False, False, False]})
        # When the syllables collide even unhyphenated the word does break, so
        # the dash comes back to show it is one word.
        self.assertEqual(got["splitAnywayKeepsItsHyphen"],
                         {"lanes": [0, 1, 0], "lineCount": 2, "hyphens": [True, False, False]})
        # Unless its own line has no room left for it; an overlap reads worse.
        self.assertEqual(got["splitWithNoRoomLosesIt"],
                         {"lanes": [0, 1, 0], "lineCount": 2, "hyphens": [False, False, False]})
        # A hyphen with nothing after it on this system ends the line, and stays.
        self.assertEqual(got["lastSyllableIsLeftAlone"],
                         {"lanes": [0, 0], "lineCount": 1, "hyphens": [False, True]})

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_loop_shows_repeat_signs_instead_of_a_band(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        # The band over the whole looped span is gone; the signs replace it.
        self.assertNotIn("bar-loop-region", app)
        self.assertNotIn("bar-loop-region", styles)
        # The signs take the practice part's colour, like every other accent.
        self.assertIn(".bar-repeat-sign { fill: var(--accent); }", styles)
        # A closing repeat alone means "from the top", so the opening sign is
        # drawn only when the repeat starts somewhere else.
        self.assertIn("if (hasOpening && first + offset === loopStartMeasure) {", app)
        self.assertIn("const hasLoop = Number.isInteger(loopEndMeasure);", app)
        self.assertIn("const hasOpening = hasLoop && Number.isInteger(loopStartMeasure);", app)
        self.assertIn("if (hasLoop && first + offset === loopEndMeasure) {", app)
        # The closing sign closes the measure, so it stands on that measure's
        # far barline rather than beside its number.
        self.assertIn("svg.append(pitchBarRepeatSign(xAtTick(loopRange.end) - 1, 11, repeatSignHeight, -1).group);", app)

        start = app.index("  function pitchBarRepeatSign")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
const createSvgElement = (name, attributes = {{}}) => ({{
  name, attributes, children: [], append(...kids) {{ this.children.push(...kids); }},
}});
{app[start:end]}
const extent = (sign) => {{
  const edges = sign.group.children.flatMap((child) => child.name === "rect"
    ? [child.attributes.x, child.attributes.x + child.attributes.width]
    : [child.attributes.cx - child.attributes.r, child.attributes.cx + child.attributes.r]);
  return {{ left: Math.min(...edges), right: Math.max(...edges), width: sign.width }};
}};
const describe = (facing) => {{
  const sign = pitchBarRepeatSign(100, 11, 8.6, facing);
  const rects = sign.group.children.filter((child) => child.name === "rect");
  const dots = sign.group.children.filter((child) => child.name === "circle");
  return {{
    ...extent(sign),
    pieces: sign.group.children.length,
    thickFirst: rects[0].attributes.width > rects[1].attributes.width,
    onTheBarline: facing > 0 ? rects[0].attributes.x : rects[0].attributes.x + rects[0].attributes.width,
    dotsStraddleTheMiddle: dots.length === 2 && dots[0].attributes.cy < 11 - 8.6 / 2 && dots[1].attributes.cy > 11 - 8.6 / 2,
    dotsOutermost: facing > 0
      ? dots.every((dot) => dot.attributes.cx > rects[1].attributes.x)
      : dots.every((dot) => dot.attributes.cx < rects[1].attributes.x),
    baseline: rects[0].attributes.y + rects[0].attributes.height,
    className: sign.group.attributes.class,
  }};
}};
console.log(JSON.stringify({{ opening: describe(1), closing: describe(-1) }}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        for facing, sign in got.items():
            self.assertEqual(sign["pieces"], 4, facing)           # thick bar, thin bar, two dots
            self.assertTrue(sign["thickFirst"], facing)
            self.assertEqual(sign["onTheBarline"], 100, facing)
            self.assertTrue(sign["dotsStraddleTheMiddle"], facing)
            self.assertTrue(sign["dotsOutermost"], facing)        # the dots face the music
            self.assertEqual(sign["baseline"], 11, facing)        # sits on the measure number's baseline
            self.assertEqual(sign["className"], "bar-repeat-sign", facing)
            # The reported width is what the caller shifts the measure number by,
            # so it has to be the whole drawn extent.
            self.assertAlmostEqual(sign["right"] - sign["left"], sign["width"], places=6)
        # Opening signs are drawn rightward from the barline, closing ones leftward.
        self.assertEqual(got["opening"]["left"], 100)
        self.assertEqual(got["closing"]["right"], 100)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_superseded_storage_entries_are_swept_on_open(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Sweeping before the adoptions would throw away data this build wants.
        self.assertLess(app.index("      loadAnnotations();"),
                        app.index("      sweepSupersededStorage(config.slug"))
        # A trace recorded under a build that no longer exists is rescued by its
        # own fingerprint before the sweep can take it.
        self.assertLess(app.index("      loadPitchTrace();"),
                        app.index("      sweepSupersededStorage(config.slug"))
        self.assertIn("const stored = JSON.parse(adoptedPitchTrace() || \"null\");", app)
        self.assertIn('if (!value?.includes(wanted) || JSON.parse(value)?.fingerprint !== wanted) continue;', app)

        start = app.index("  function sweepSupersededStorage")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
const store = new Map(Object.entries({{
  "choir-practice:autumn:preferences": "keep",
  "choir-practice:autumn:pitch-trace": "keep",
  "choir-practice:autumn:settings-open": "keep",
  "choir-practice:autumn:notes": "keep",
  "choir-practice:autumn:notes:v3": "stale, already adopted",
  "choir-practice:autumn:settings-open:v1": "stale, already adopted",
  "choir-practice:0f098c7ac091a9ee:v2": "dead build",
  "choir-practice:0f098c7ac091a9ee:v2:notes": "dead build",
  "choir-practice:1a2b3c4d5e6f7890:pitch-trace:v2": "dead build",
  "choir-practice:birds-lullaby:preferences": "another song",
  "choir-practice:birds-lullaby:notes:v2": "another song's, left for it to clear",
  "ear-training:progress": "another app on the same origin",
  "theme": "somebody else's",
}}));
globalThis.localStorage = {{
  get length() {{ return store.size; }},
  key: (index) => [...store.keys()][index] ?? null,
  getItem: (key) => store.has(key) ? store.get(key) : null,
  removeItem: (key) => store.delete(key),
}};
{app[start:end]}
const removed = sweepSupersededStorage("autumn");
console.log(JSON.stringify({{ removed, left: [...store.keys()].sort() }}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["removed"], 5)
        self.assertEqual(got["left"], [
            "choir-practice:autumn:notes",
            "choir-practice:autumn:pitch-trace",
            "choir-practice:autumn:preferences",
            "choir-practice:autumn:settings-open",
            "choir-practice:birds-lullaby:notes:v2",
            "choir-practice:birds-lullaby:preferences",
            "ear-training:progress",
            "theme",
        ])

        # A browser that refuses storage must not take the page down with it.
        blocked = f"""
globalThis.localStorage = new Proxy({{}}, {{ get() {{ throw new Error("denied"); }} }});
{app[start:end]}
console.log(JSON.stringify(sweepSupersededStorage("autumn")));
"""
        denied = subprocess.run(
            [shutil.which("node") or "node", "-e", blocked],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(denied.stdout), 0)

    def test_part_colours_come_from_the_stylesheet_and_match_chordus(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        light = dict(re.findall(r"--part-(\d): (#[0-9a-f]{6});", styles[:styles.index("@media (prefers-color-scheme: dark)")]))
        dark_block = styles[styles.index(':root[data-theme="dark"]'):]
        dark = dict(re.findall(r"--part-(\d): (#[0-9a-f]{6});", dark_block))
        # The four voices carry Chordus's colours: tenor teal, alto gold.
        self.assertEqual([light[str(n)] for n in range(1, 5)], ["#ac345e", "#855418", "#086b7c", "#64499b"])
        self.assertEqual([dark[str(n)] for n in range(1, 5)], ["#f292b2", "#e9bc79", "#7ec7d6", "#b9a4eb"])
        self.assertEqual(sorted(light), sorted(dark))          # every part is themed, not just the first four

        # The JS list is only what the var() calls fall back to, so it has to
        # agree with the light theme or a missing stylesheet would recolour the
        # parts instead of reproducing them.
        palette = re.search(r"const PALETTE = Object\.freeze\(\[(.*?)\]\);", app, re.S).group(1)
        fallbacks = re.findall(r'"(#[0-9a-f]{6})"', palette)
        self.assertEqual(fallbacks, [light[str(n)] for n in range(1, len(fallbacks) + 1)])
        self.assertIn("const partPaint = (index) => `var(--part-${(index % PALETTE.length) + 1}, ${PALETTE[index % PALETTE.length]})`;", app)

        # A var() resolves as a property but not as a presentation attribute, so
        # a part colour must never be handed to one.
        self.assertNotIn("fill: parts[", app)
        self.assertNotIn("fill: pitchStripe(", app)
        self.assertIn("note.style.fill = pitchStripe(", app)
        self.assertIn("stripe.style.fill = parts[track]?.color || partPaint(track);", app)

    def test_accent_follows_the_practice_part(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        # Nothing in the UI keeps a hue of its own: the accent is the practice
        # part, and the rest of the accent family derives from it.
        self.assertIn("--accent: var(--practice-color, #235d99);", styles)
        self.assertIn("--accent: var(--practice-color, #87baf5);", styles)
        self.assertIn("--accent-bright: color-mix(in srgb, var(--accent) 80%, #fff);", styles)
        self.assertIn("--accent-soft: color-mix(in srgb, var(--accent) 15%, var(--field));", styles)
        # The dark themes must not pin bright/soft, or they would stop following.
        self.assertNotIn("--accent-bright: #87cabe;", styles)
        self.assertNotIn("--accent-soft: #263f3a;", styles)
        # Loop amber was gold, and gold is the alto now.
        self.assertNotIn("#c48633", styles)
        self.assertNotIn("#d9a65f", styles)
        self.assertIn("--loop-border: var(--accent);", styles)
        self.assertIn('document.documentElement.style.setProperty("--practice-color", selectedPart.color);', app)
        self.assertIn('document.documentElement.style.removeProperty("--practice-color");', app)

    def test_loop_endpoints_outlive_a_refresh(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("      loopStart: loopStartMeasure,\n      loopEnd: loopEndMeasure,\n", app)
        # Setting or clearing a loop has to write it, or it only lives in memory.
        self.assertNotIn("    updateLoopState();\n    if (Number.isInteger(loopStartMeasure)", app)
        self.assertEqual(app.count("updateLoopState({ persist: true });"), 3)
        # A rebuilt, shorter score must not restore a loop past its last measure.
        self.assertIn("restoreLoopState(stored);", app)
        self.assertIn("index >= 0 && index < sequence.measures.length", app)
        self.assertIn("range.start >= range.end || range.end > sequence.endTick", app)
        self.assertIn("      loopStartTick,\n      loopEndTick,", app)

    def test_singing_and_the_line_break_marks_survive_a_refresh(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        # The microphone is remembered as a wish, and restored once the engine
        # exists, without scolding when the browser will not hand it back.
        self.assertIn("      sing: pitchCaptureEnabled(),\n", app)
        self.assertIn("wantsPitchCapture = stored.sing === true;", app)
        self.assertIn("if (wantsPitchCapture && !window.frameElement?.inert) void startPitchCapture({ quiet: true });", app)
        self.assertLess(app.index("engine = new GuideEngine(sequence);"),
                        app.index("if (wantsPitchCapture && !window.frameElement?.inert) void startPitchCapture({ quiet: true });"))
        self.assertIn("async function startPitchCapture({ quiet = false } = {}) {", app)
        # New and cached microphone acquisition share the same error path.
        self.assertEqual(app.count("if (!quiet) showToast("), 2)
        # Turning it on or off writes it; the appearance pass would also fire
        # mid-request, when the answer is not known yet.
        self.assertIn("""    updatePitchCaptureAppearance();
    savePreferences();
    showToast(playing ?""", app)
        self.assertIn("""    updatePitchCaptureAppearance();
    savePreferences();
    if (announce) showToast("Microphone off");""", app)

        # Where each part goes next is drawn on the closing barline, at the same
        # height as a note, and counts towards the line's pitch range so a leap
        # is never drawn off the top.
        # A triangle rather than a bar, standing on the closing barline and
        # pointing into the gutter, which the viewBox leaves room for.
        # As tall as a bar note and as wide across.
        self.assertIn("${edge},${middle - pitchStep} ${edge + pitchStep * 2},${middle} ${edge},${middle + pitchStep}", app)
        self.assertIn('const cue = createSvgElement("polygon", {', app)
        # The gutter is cut to the cue at whatever height the rows are, so no
        # fixed value can be outgrown and clip it.
        self.assertIn("const rightPad = pitchStep * 2 + 2;", app)
        self.assertIn("const middle = topPad + (maxPitch - pitch + 1) * pitchStep;", app)
        self.assertIn("const baseMinPitch = (rowPitches.length ? Math.min(...rowPitches, ...reachPitches) : 60) - 1;", app)
        self.assertIn("const baseMaxPitch = (rowPitches.length ? Math.max(...rowPitches, ...reachPitches) : 60) + 1;", app)
        # Only parts singing on this line are marked, and only where they sing
        # again on the next one.
        self.assertIn("const continuations = [...new Set(rowSegments.flatMap((segment) => segment.tracks))].flatMap((track) => {", app)
        self.assertIn("&& segment.endTick > endTick && segment.startTick < nextEndTick", app)
        self.assertIn(".bar-next-pitch { opacity: 0.85; }", styles)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_beat_ticks_carry_metric_weight(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const BEAT_TICK_HEIGHTS = Object.freeze([0.7, 0.55, 0.4]);", app)
        # The tallest stays clear of a reattack, which cuts the whole height.
        self.assertIn(".bar-reattack-line { stroke: var(--pitch-reattack); stroke-width: 1.5;",
                      (ROOT / "template" / "styles.css").read_text(encoding="utf-8"))
        self.assertIn("y1: top + pitchStep * 2 * (1 - BEAT_TICK_HEIGHTS[level]), y2: top + pitchStep * 2,", app)

        start = app.index("  function beatTicksWithin")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
const sequence = {{ division: 960, measures: [] }};
const measureIndexAtTick = (tick) => {{
  let index = 0;
  sequence.measures.forEach((measure, at) => {{ if (measure[0] <= tick) index = at; }});
  return index;
}};
{app[start:end]}
const run = (beats, beatType, bars) => {{
  const unit = (960 * 4) / beatType;
  const length = unit * beats;
  sequence.measures = Array.from({{ length: bars }}, (_, i) => [i * length, length, beats, beatType]);
  return {{ ticks: beatTicksWithin(0, length * bars), length }};
}};
const shape = (beats, beatType, bars) => {{
  const {{ ticks }} = run(beats, beatType, bars);
  return ticks.map((t) => t.level).join("");
}};
console.log(JSON.stringify({{
  fourFour: shape(4, 4, 2),
  threeFour: shape(3, 4, 2),
  sixEight: shape(6, 8, 2),
  twoFour: shape(2, 4, 2),
  // A note shorter than a beat has nothing inside it.
  insideOneBeat: beatTicksWithin(0, 959).length,
  // Boundaries are strictly interior: neither end counts.
  wholeBar: (() => {{ run(4, 4, 1); return beatTicksWithin(0, 3840).map((t) => t.tick).join(","); }})(),
  // A note starting an eighth late still ticks on the bar's pulse, not a beat
  // after its own onset, and keeps the weight of the beats it lands on.
  syncopated: (() => {{
    run(4, 4, 1);
    return beatTicksWithin(480, 3360).map((t) => `${{t.tick}}:${{t.level}}`).join(",");
  }})(),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # 4/4: downbeat, beat 2, the middle, beat 4 — the third beat stands up.
        self.assertEqual(got["fourFour"], "2120212")
        # 3/4 has no middle, so every interior beat weighs the same.
        self.assertEqual(got["threeFour"], "22022")
        # 6/8 is counted in two dotted beats, the second of which is the middle.
        self.assertEqual(got["sixEight"], "101")
        self.assertEqual(got["twoFour"], "101")
        self.assertEqual(got["insideOneBeat"], 0)
        self.assertEqual(got["wholeBar"], "960,1920,2880")
        # Note-relative counting would have put these at 1440 and 2400.
        self.assertEqual(got["syncopated"], "960:2,1920:1,2880:2")

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pan_row_label_rides_every_part_sideways(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("attachGroupDrag(panLabel, panControls, PAN_VALUES, 4, { horizontal: true, clampIndividually: true });", app)
        self.assertIn('panLabel.classList.add("is-group-drag", "is-horizontal");', app)
        self.assertIn('panLabel.setAttribute("aria-label", "All part pans");', app)
        # Wired after the ring controls exist, or it would ride an empty row.
        self.assertLess(app.index("panControls.push(control);"),
                        app.index("attachGroupDrag(panLabel,"))
        self.assertIn(".mixer-row-label.is-group-drag.is-horizontal { cursor: ew-resize; }", styles)

        start = app.index("  function attachGroupDrag")
        end = app.index("\n  }", start) + len("\n  }")
        helper = app.index("  function nearestAllowed")
        helper_end = app.index("\n  }", helper) + len("\n  }")
        script = f"""
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
{app[helper:helper_end]}
{app[start:end]}
const VALUES = Array.from({{ length: 41 }}, (_, i) => i * 5 - 100);   // -100..100 by 5
const handlers = {{}};
const label = {{
  addEventListener: (type, fn) => {{ handlers[type] = fn; }},
  setPointerCapture: () => {{ label.captured = true; }},
  hasPointerCapture: () => label.captured === true,
  releasePointerCapture: () => {{ label.captured = false; }},
}};
const make = (start) => {{ let v = start; return {{ value: () => v, setValue: (next) => {{ v = next; }} }}; }};
const controls = [make(-50), make(0), make(25), make(50)];
attachGroupDrag(label, controls, VALUES, 4, {{ horizontal: true, clampIndividually: true }});
const read = () => controls.map((c) => c.value());
const drag = (dx) => {{ handlers.pointermove({{ pointerId: 1, clientX: 200 + dx }}); return read(); }};
handlers.pointerdown({{ button: 0, pointerId: 1, clientX: 200, preventDefault() {{}} }});
const out = {{
  start: read(),
  rightTwoSteps: drag(8),
  rightmostSaturated: drag(48),
  othersKeepMovingRight: drag(64),
  allHardRight: drag(400),
  backToStart: drag(0),
  leftmostSaturated: drag(-64),
  allHardLeft: drag(-400),
  // Vertical movement is not this row's axis and must do nothing.
  ignoresVertical: (() => {{ handlers.pointermove({{ pointerId: 1, clientX: 200, clientY: -400 }}); return read(); }})(),
}};
handlers.pointerup({{ pointerId: 1 }});
handlers.keydown({{ key: "ArrowRight", preventDefault() {{}} }});
out.afterArrowRight = read();
handlers.keydown({{ key: "ArrowLeft", preventDefault() {{}} }});
out.afterArrowLeft = read();
controls.forEach((control, i) => control.setValue([100, -100, 95, -95][i]));
handlers.keydown({{ key: "ArrowRight", preventDefault() {{}} }});
out.arrowPastRightLimit = read();
handlers.keydown({{ key: "ArrowLeft", preventDefault() {{}} }});
out.arrowPastLeftLimit = read();
console.log(JSON.stringify(out));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["start"], [-50, 0, 25, 50])
        self.assertEqual(got["rightTwoSteps"], [-40, 10, 35, 60])
        # An edge stops only that pan; every other part can keep moving.
        self.assertEqual(got["rightmostSaturated"], [10, 60, 85, 100])
        self.assertEqual(got["othersKeepMovingRight"], [30, 80, 100, 100])
        self.assertEqual(got["allHardRight"], [100, 100, 100, 100])
        self.assertEqual(got["leftmostSaturated"], [-100, -80, -55, -30])
        self.assertEqual(got["allHardLeft"], [-100, -100, -100, -100])
        self.assertEqual(got["backToStart"], [-50, 0, 25, 50])
        self.assertEqual(got["ignoresVertical"], [-50, 0, 25, 50])
        self.assertEqual(got["afterArrowRight"], [-45, 5, 30, 55])
        self.assertEqual(got["afterArrowLeft"], [-50, 0, 25, 50])
        self.assertEqual(got["arrowPastRightLimit"], [100, -95, 100, -90])
        self.assertEqual(got["arrowPastLeftLimit"], [95, -100, 95, -95])

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_help_mode_tells_everyone_how_to_reset_a_setting(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Row and section labels have no line of their own, so the help targets
        # cannot be found by data-help alone.
        self.assertIn('const SETTING_HELP_SELECTOR = "[data-help], [data-reset-scope]";', app)
        self.assertNotIn('closest?.("[data-help]")', app)
        self.assertIn('element.dataset.resetScope = label;', app)
        self.assertIn('element.dataset.resetHold = String(holdToReset);', app)

        start = app.index("  function settingHelpMessage")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
{app[start:end]}
const at = (dataset) => ({{ dataset }});
console.log(JSON.stringify({{
  label: settingHelpMessage(at({{ resetScope: "Speed", resetHold: "true" }})),
  labelNoHold: settingHelpMessage(at({{ resetScope: "Soprano", resetHold: "false" }})),
  control: settingHelpMessage(at({{ help: "Drag vertically to change speed.", resetScope: "Speed", resetHold: "true" }})),
  controlNoHold: settingHelpMessage(at({{ help: "Hide Soprano notation.", resetScope: "Soprano notation", resetHold: "false" }})),
  notResettable: settingHelpMessage(at({{ help: "Toggle full screen." }})),
  nothingAtAll: settingHelpMessage(at({{}})),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # A bare label says what it resets, since nothing else on it does.
        self.assertEqual(got["label"], "Right-click or hold to reset Speed.")
        # Holding is the solo gesture on the See and Hear buttons, so those are
        # never told to hold.
        self.assertEqual(got["labelNoHold"], "Right-click to reset Soprano.")
        # Elsewhere the tooltip already sits on the thing, so it does not repeat
        # the name.
        self.assertEqual(got["control"], "Drag vertically to change speed. Right-click or hold to reset.")
        self.assertEqual(got["controlNoHold"], "Hide Soprano notation. Right-click to reset.")
        self.assertEqual(got["notResettable"], "Toggle full screen.")
        self.assertEqual(got["nothingAtAll"], "")

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_divisi_is_found_in_the_music_without_notation_filtering(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Hearing one division must not hide notation or restrict pitch traces.
        for gone in ("practiceLine", "is-other-line", "divisiNoteIsMine"):
            self.assertNotIn(gone, app)
            self.assertNotIn(gone, (ROOT / "template" / "index.html").read_text(encoding="utf-8"))
            self.assertNotIn(gone, (ROOT / "template" / "styles.css").read_text(encoding="utf-8"))

        def extract(name: str) -> str:
            start = app.index(f"  function {name}")
            return app[start:app.index("\n  }", start) + len("\n  }")]

        script = f"""
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
let parts = [{{}}];
let practiceLines = [0];
let partDivisi = [];
let sequence = {{ notes: [] }};
{extract("analysePartDivisi")}
{extract("divisiLineFor")}
// Two pitches at once, then one alone, then two again: a part that divides in
// patches, which is how divisi actually appears.
sequence.notes = [
  [0, 0, 960, 60], [0, 0, 960, 55],
  [0, 960, 1920, 62],
  [0, 1920, 2880, 64], [0, 1920, 2880, 57],
];
partDivisi = analysePartDivisi();
console.log(JSON.stringify({{
  maxLines: partDivisi[0].maxLines,
  spans: partDivisi[0].spans.map((s) => `${{s.start}}-${{s.end}}:${{s.pitches.join("/")}}`),
  // Five lines collapsing to three, and to two.
  fiveToThree: [0, 1, 2, 3, 4].map((k) => divisiLineFor(k, 5, 3)),
  fiveToTwo: [0, 1, 2, 3, 4].map((k) => divisiLineFor(k, 5, 2)),
  fiveToOne: [0, 1, 2, 3, 4].map((k) => divisiLineFor(k, 5, 1)),
  threeToThree: [0, 1, 2].map((k) => divisiLineFor(k, 3, 3)),
  // A part can also divide further than the singer's own maximum.
  twoToThree: [0, 1].map((k) => divisiLineFor(k, 2, 3)),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["maxLines"], 2)
        # Stacks are listed top first and a held stack is one span, not many.
        self.assertEqual(got["spans"], ["0-960:60/55", "960-1920:62", "1920-2880:64/57"])
        # Proportional, so the middle voice stays in the middle and no line of
        # the music goes unsung; a singer exactly between two lines takes the
        # lower one, which is the side that wants the extra body.
        self.assertEqual(got["fiveToThree"], [0, 1, 1, 2, 2])
        # Two lines: the top takes two singers and the bottom three, so the
        # lower line is reinforced without any line being left empty.
        self.assertEqual(got["fiveToTwo"], [0, 0, 1, 1, 1])
        self.assertEqual(got["fiveToOne"], [0, 0, 0, 0, 0])
        self.assertEqual(got["threeToThree"], [0, 1, 2])
        self.assertEqual(got["twoToThree"], [0, 2])

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pitch_trace_grades_against_your_own_part(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        start = app.index("  function expectedPitchAt")
        end = app.index("  function pitchTraceColor", start)

        def extract(name: str) -> str:
            at = app.index(f"  function {name}")
            return app[at:app.index("\n  }", at) + len("\n  }")]

        script = f"""
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// Bass divided into two lines, then singing alone; Tenor sounding throughout.
const sequence = {{ notes: [
  [3, 0, 960, 48], [3, 0, 960, 43],
  [3, 960, 1920, 45],
  [2, 0, 1920, 55],
] }};
let parts = [{{}}, {{}}, {{}}, {{}}];
let practiceLines = [0, 0, 0, 0];
let partDivisi = [];
let practicePartIndex = null;
const visibleTracks = new Set([0, 1, 2, 3]);
{extract("analysePartDivisi")}
{extract("divisiLineFor")}
{extract("divisiSpanAt")}
{app[start:end]}
partDivisi = analysePartDivisi();
const cents = (key) => key * 100;
const grade = (tick, key) => expectedPitchErrorCents(tick, cents(key));
const out = {{}};
// No part chosen: any visible note will do, which is the old behaviour.
out.anyPartWhenUnchosen = [grade(480, 48), grade(480, 43), grade(480, 55)];
practicePartIndex = 3;
// Either line of the singer's own part is accepted for now; which one they are
// actually on is settled by what they sang, not by a setting.
out.bothLinesOfMyPart = [grade(480, 48), grade(480, 43)];
// Another part's note is not: a bass on the tenor's note is out by the
// interval between them.
out.tenorNoteAsBass = grade(480, 55);
out.undivided = grade(1440, 45);
console.log(JSON.stringify(out));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # Before a part is chosen there is no "mine", so anything on screen scores.
        self.assertEqual(got["anyPartWhenUnchosen"], [0, 0, 0])
        # Once it is, the other line is wrong by exactly its interval — a fifth
        # here — instead of scoring perfect.
        self.assertEqual(got["bothLinesOfMyPart"], [0, 0])
        self.assertEqual(got["tenorNoteAsBass"], 700)
        self.assertEqual(got["undivided"], 0)

    def test_help_mode_only_takes_the_tap_on_touch(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # A pointer that can hover has already been shown the tooltip, so its
        # click is left alone; only a touch spends its tap on reading.
        self.assertIn('if (event.type === "pointerdown") inspectByTouch = event.pointerType === "touch";', app)
        self.assertIn("      if (!inspectByTouch) {", app)
        # A keyboard-driven click carries no pointer, so it must not inherit the
        # last tap's verdict.
        self.assertIn("else if (!event.detail) inspectByTouch = false;", app)
        # Swallowing still happens, but only past that gate.
        gate = app.index("      if (!inspectByTouch) {")
        self.assertLess(gate, app.index("event.stopImmediatePropagation()", gate))
        # Operating a control changes what its tooltip says, so the one already
        # on screen is refreshed rather than left stale.
        self.assertIn('if (event.type === "click" && target === settingsTooltipTarget) {', app)
        self.assertIn("requestAnimationFrame(() => showSettingsTooltip(target, { delay: 0 }));", app)
        self.assertIn('elements.settingsPanel.addEventListener("pointerdown", inspectSetting, true)', app)
        self.assertIn('elements.settingsPanel.addEventListener("click", inspectSetting, true)', app)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_a_closing_repeat_alone_loops_from_the_top(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # An End on its own is a whole loop, the way a closing repeat with no
        # opening one repeats from the beginning in print. An opening one alone
        # is not, because there is nothing to come back from.
        self.assertIn('elements.loopControls.classList.toggle("has-complete-loop", hasEnd);', app)
        self.assertIn('elements.loopControls.classList.toggle("has-partial-loop", hasStart && !hasEnd);', app)
        self.assertIn("    if (hasEnd) {\n      const { start, end } = loopTickRange();", app)
        self.assertIn("start: startMeasure ? loopStartTick ?? startMeasure[0] : 0,", app)

        start = app.index("  function currentMeasureIndex")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
let position = 0;
const sequence = {{ measures: [[0, 960], [960, 960], [1920, 960]] }};
const engine = {{ tickAtSeconds: (seconds) => seconds, currentSeconds: () => position }};
const measureIndexAtTick = (tick) => {{
  let index = 0;
  sequence.measures.forEach((measure, at) => {{ if (measure[0] <= tick) index = at; }});
  return index;
}};
{app[start:end]}
const at = (tick) => {{ position = tick; return currentMeasureIndex(); }};
console.log(JSON.stringify({{
  insideFirst: at(480),
  onSecondBarline: at(960),
  insideSecond: at(1440),
  onThirdBarline: at(1920),
  atTheVeryStart: at(0),
  roundoffAtBarline: at(1920 - 1e-8),
  beforeBarline: at(1919.5),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["insideFirst"], 0)
        self.assertEqual(got["onSecondBarline"], 1)
        self.assertEqual(got["insideSecond"], 1)
        self.assertEqual(got["onThirdBarline"], 2)
        self.assertEqual(got["atTheVeryStart"], 0)
        self.assertEqual(got["roundoffAtBarline"], 2)
        self.assertEqual(got["beforeBarline"], 1)
        self.assertIn('const current = currentMeasureIndex();', app)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_a_singer_can_change_divisi_line_mid_note(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Nothing remembers which line a passage "belongs" to; both lines are
        # real music and the singer moves between them freely.
        self.assertNotIn("pitchTraceSpanLane", app)

        def extract(name: str) -> str:
            at = app.index(f"  function {name}")
            return app[at:app.index("\n  }", at) + len("\n  }")]

        script = f"""
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
let parts = [{{}}];
let practicePartIndex = 0;
let partDivisi = [];
let sequence = {{ notes: [
  [0, 0, 1920, 60], [0, 0, 1920, 55],     // one long divided note, a fifth apart
  [0, 1920, 2880, 62],                    // then undivided
] }};
{extract("analysePartDivisi")}
{extract("divisiSpanAt")}
{extract("pitchTraceLaneAt")}
partDivisi = analysePartDivisi();
console.log(JSON.stringify({{
  // Within the same held note: upper, upper, then lower, then upper again.
  midNote: [
    pitchTraceLaneAt(100, 6000),
    pitchTraceLaneAt(600, 5990),
    pitchTraceLaneAt(900, 5510),
    pitchTraceLaneAt(1500, 6010),
  ],
  // Off pitch, but nearer the line being sung, stays on that line.
  flatButStillUpper: pitchTraceLaneAt(600, 5850),
  // Undivided music has only one line to be on.
  undivided: pitchTraceLaneAt(2000, 6200),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["midNote"], [0, 0, 1, 0])
        self.assertEqual(got["flatButStillUpper"], 0)
        self.assertEqual(got["undivided"], 0)

    def test_storage_key_names_never_carry_a_version(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        block = app.split("const songKey = (suffix)", 1)[1].split("setSettingsOpen(", 1)[0]
        current = re.findall(r'^\s*(\w+Key) = songKey\("([^"]+)"\);', block, re.M)
        self.assertEqual(
            sorted(current),
            [("annotationKey", "notes"), ("partChooserKey", "part-chooser"), ("pitchTraceKey", "pitch-trace"),
             ("preferenceKey", "preferences"), ("settingsPanelPreferenceKey", "settings-open")],
        )
        # A version in the key name is what stranded everyone's data before: the
        # next build asks for a name nothing wrote. Versions belong inside the
        # payload, where the pitch trace keeps its own, so a format change
        # rewrites the same key instead of abandoning it.
        for _, suffix in current:
            self.assertNotRegex(suffix, r":?v\d+$")
        self.assertIn("const PITCH_TRACE_STORAGE_VERSION = 3;", app)
        self.assertIn("version: PITCH_TRACE_STORAGE_VERSION,", app)
        # Versioned names may only be read, once, on the way out.
        for versioned in re.findall(r'`\$\{songKey\("[^"]+"\)\}:v\d+`', block):
            line = next(l for l in block.splitlines() if versioned in l)
            self.assertRegex(line.strip(), r"^legacy\w+ = \[|^\s*`")

    def test_pitchbar_stretch_uses_uniform_five_percent_steps(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn(
            "const HORIZONTAL_VALUES = Object.freeze(Array.from({ length: 80 }, (_, index) => (index + 1) * 5))",
            app,
        )
        self.assertIn(
            'stepValues: () => scoreView === "bars" ? HORIZONTAL_VALUES : STANDARD_HORIZONTAL_VALUES',
            app,
        )
        self.assertIn("if (configured.includes(value)) return configured", app)

    def test_audio_only_changes_do_not_rerender_the_score(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        volume_handler = app.split('button.addEventListener("input", () => {', 1)[1].split("      });", 1)[0]
        self.assertIn("engine?.updateMix", volume_handler)
        self.assertIn("savePreferences()", volume_handler)
        self.assertNotIn("scheduleRender", volume_handler)
        apply_state = app.split("  function applySettingsState(state) {", 1)[1].split(
            "  function performScopedReset", 1
        )[0]
        self.assertIn("const renderRelevantChanged =", apply_state)
        self.assertIn("if (renderRelevantChanged) scheduleRender()", apply_state)
        self.assertNotIn("else scheduleRender();", apply_state)
        mix_appearance = app.split("  function updatePracticeMixAppearance()", 1)[1].split("  function cyclePartVolumeMix", 1)[0]
        self.assertNotIn("replaceChildren", mix_appearance)
        self.assertNotIn("scheduleRender", mix_appearance)
        observer = app.split('if ("ResizeObserver" in window) {', 1)[1].split(
            "scoreResizeObserver.observe", 1
        )[0]
        self.assertIn("lastScoreShellWidth = Math.round", observer)

    def test_score_rerenders_keep_the_previous_frame_until_ready(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("function retainCurrentScoreFrame()", app)
        self.assertIn('snapshot.className = "score-render-snapshot"', app)
        self.assertIn('elements.score.classList.add("is-rendering-score")', app)
        self.assertIn("let notationRenderInFlight = false", app)
        self.assertIn("let notationRenderQueued = false", app)
        self.assertIn("renderTimer = window.setTimeout(performNotationRender, 80)", app)
        self.assertIn("const renderIsCurrent = finishScheduledNotationRender()", app)
        self.assertIn("requestAnimationFrame(() => requestAnimationFrame(releaseScoreRenderSnapshot))", app)
        self.assertIn(".score.is-rendering-score { opacity: 0; }", styles)
        self.assertIn(".score-render-snapshot.is-revealing { opacity: 0; }", styles)

    def test_the_retained_frame_drops_its_highlights_before_fading(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        # The retained frame is a deep clone laid over the live score while it
        # fades, so any translucent overlay would be painted twice and its tint
        # would darken for the length of the fade.
        self.assertIn("const frame = elements.score.cloneNode(true);", app)
        self.assertIn("transition: opacity 110ms ease-out", styles)
        release = app.split("  function releaseScoreRenderSnapshot()", 1)[1].split("\n  }", 1)[0]
        self.assertIn('.at-cursor-bar, .at-cursor-beat, .at-selection, .score-selected-part', release)
        self.assertLess(release.index("overlay.remove()"), release.index('classList.add("is-revealing")'))

    def test_pitchbar_view_never_shows_notation_loading_and_stalled_engraving_relaxes_stretch(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="scoreLoadingText"', document)
        self.assertIn("const NOTATION_RENDER_TIMEOUT_MS = 6000", app)
        loading_sync = app.split("  function syncScoreLoadingVisibility() {", 1)[1].split("  }", 1)[0]
        self.assertIn('scoreView === "standard"', loading_sync)
        self.assertIn("!notationHasRendered && !notationRenderFailed", loading_sync)
        timeout = app.split("  function handleNotationRenderTimeout() {", 1)[1].split(
            "  function performNotationRender()", 1
        )[0]
        self.assertIn("STANDARD_HORIZONTAL_VALUES.find((value) => value > current)", timeout)
        self.assertIn("horizontalControl.setValue(next, false)", timeout)
        self.assertIn("savePreferences()", timeout)
        self.assertIn("notationRenderFailed = true", timeout)
        self.assertIn("beginNotationRenderTimeout()", app)
        render_finished = app.split("api.renderFinished.on(() => {", 1)[1].split("api.playerReady.on", 1)[0]
        self.assertIn('if (scoreView === "standard")', render_finished)
        self.assertIn("notationHasRendered = true", render_finished)

    def test_both_score_surfaces_drag_scrub_without_native_selection(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("function applyScoreScrubTarget(target)", app)
        self.assertIn("function snapTickToEighth(rawTick, originTick = 0)", app)
        self.assertIn("(Number(sequence?.division) || 1) / 2", app)
        # A tick that came from a real beat is used as-is; the eighth-note snap
        # stays for clicks the renderer could not attribute to a beat.
        self.assertIn("const requestedTick = target.exactTick ? rawTick : clamp(snapTickToEighth(", app)
        self.assertIn("function beginScoreScrub(event, targetAtPointer)", app)
        self.assertIn("function cancelScoreScrub(pointer = null)", app)
        self.assertIn("api.tickPosition = requestedTick", app)
        self.assertNotIn("engine.seek(engine.secondsAtTick(requestedTick))", app)
        self.assertIn("updateBarPlayhead(requestedTick)", app)
        self.assertIn('elements.score.addEventListener("pointerdown"', app)
        self.assertIn("standardScoreTargetAtClientPoint(", app)
        self.assertIn("snapStartTick: Number(measureStart) || 0", app)
        self.assertNotIn("Number(measure?.[0])", app)
        self.assertIn("beginScoreScrub(event, scrubTarget);", app)
        self.assertIn('window.addEventListener("pointermove", move', app)
        self.assertIn("Math.hypot(deltaX, deltaY) < 8", app)
        self.assertIn("Math.abs(deltaX) > Math.abs(deltaY) * 1.25", app)
        self.assertIn('pointerType === "touch" && (flow === "continuous" || surface.classList.contains("has-horizontal-overflow") || !clearlyHorizontal)', app)
        self.assertIn("applyScoreScrubTarget(scrubbing ? targetAtPointer(finishEvent) : initialTarget)", app)
        pointer_down = app.split("function beginScoreScrub(event, targetAtPointer)", 1)[1].split("const move =", 1)[0]
        self.assertNotIn("applyScoreScrubTarget(initialTarget)", pointer_down)
        self.assertNotIn("event.preventDefault()", pointer_down)
        self.assertIn("document.getSelection()?.removeAllRanges()", app)
        self.assertIn("settings.player.enableUserInteraction = false", app)
        self.assertNotIn("api.beatMouseUp.on", app)
        surface_rule = styles.split(".score,\n.bar-score {", 1)[1].split("}", 1)[0]
        self.assertIn("user-select: none", surface_rule)
        self.assertIn("-webkit-user-select: none", surface_rule)
        self.assertIn(".bar-system svg { cursor: ew-resize; }", styles)
        self.assertIn(".is-scrubbing-score", styles)
        self.assertIn(".score:not(.is-continuous),\n.bar-score:not(.is-continuous) { touch-action: pan-y; }", styles)
        self.assertIn("if (!engine?.playing || pendingNotationReload || scoreScrub) return;", app)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_score_clicks_seek_to_the_renderer_s_own_beat(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # Engraving is not proportional to time, so the bar-fraction estimate is
        # only a fallback; the beat under the pointer decides.
        self.assertIn("const beatTick = beatTickAtScoreX(target.masterBounds, partIndex, scoreX);", app)
        self.assertIn("tick: beatTick === null ? tick : beatTick,", app)
        self.assertIn("exactTick: beatTick !== null,", app)
        self.assertIn("measureIndex, x, width, masterBounds,", app)

        helper_start = app.index("  function beatTickAtScoreX")
        helper_end = app.index("\n  }", helper_start) + len("\n  }")
        beat = lambda x, tick: {"realBounds": {"x": x}, "beat": {"absolutePlaybackStart": tick}}
        # Two parts in one bar, the lower one with a different rhythm, so a wrong
        # part would return a tick that the right part never plays.
        bars = {
            0: [beat(100, 0), beat(140, 480), beat(180, 960), beat(260, 2400)],
            1: [beat(100, 0), beat(200, 1440)],
        }
        script = f"""
const bars = {json.dumps(bars)};
const barBoundsForPart = (masterBounds, partIndex) => masterBounds
  ? (partIndex in bars ? {{ beats: bars[partIndex] }} : null)
  : null;
{app[helper_start:helper_end]}
const at = (x, part = 0) => beatTickAtScoreX({{}}, part, x);
console.log(JSON.stringify({{
  beforeFirstBeat: at(10),
  onFirstBeat: at(100),
  insideFirstBeat: at(139),
  onSecondBeat: at(140),
  inTheGapBeforeTheLast: at(259),
  onLastBeat: at(260),
  pastLastBeat: at(400),
  lowerPart: at(259, 1),
  unknownPart: at(140, 7),
  noBounds: beatTickAtScoreX(null, 0, 140),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            json.loads(result.stdout),
            {
                "beforeFirstBeat": 0,      # the clef and key signature belong to beat one
                "onFirstBeat": 0,
                "insideFirstBeat": 0,      # anywhere in a beat's strip is that beat
                "onSecondBeat": 480,
                "inTheGapBeforeTheLast": 960,
                "onLastBeat": 2400,
                "pastLastBeat": 2400,      # the padding before the barline, too
                "lowerPart": 1440,         # the part under the pointer decides
                "unknownPart": None,       # no bounds: fall back to interpolation
                "noBounds": None,
            },
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pitch_bar_hit_test_matches_the_drawn_bar(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # The bar is drawn two semitones tall and centred on its pitch
        # (height: pitchStep * 2), so the hit test has to allow a semitone
        # either side of the centre rather than a single row.
        self.assertIn("height: pitchStep * 2", app)
        self.assertIn("Math.abs(key - pitch) <= 1", app)

        start = app.index("  function barNoteAt")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
let selected = 1;
const currentScorePartIndex = () => selected;
const visibleTracks = new Set([0, 1, 2]);
const sequence = {{ notes: [
  [0, 0, 960, 72, 80],      // soprano, high
  [1, 0, 960, 64, 80],      // alto
  [2, 0, 960, 52, 80],      // tenor, far below
  [1, 960, 1920, 65, 80],   // alto, later in time
  [3, 0, 960, 64, 80],      // a part that is not shown
] }};
{app[start:end]}
const at = (tick, pitch) => barNoteAt(tick, pitch);
console.log(JSON.stringify({{
  onTheCentre: at(0, 64),
  oneSemitoneAbove: at(0, 65),
  oneSemitoneBelow: at(0, 63),
  justOutsideTheBar: at(0, 66.01),
  betweenTwoBars: at(0, 58),
  beforeTheNoteStarts: at(-1, 64),
  whereTheNextNoteTakesOver: at(960, 64),
  afterEverythingEnds: at(1920, 64),
  theNextNoteInTime: at(1000, 65),
  hiddenPartIsNotHeard: at(0, 64).track,
  tieGoesToTheFollowedPart: at(0, 63.5),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        self.assertEqual(got["onTheCentre"], {"key": 64, "track": 1})
        self.assertEqual(got["oneSemitoneAbove"], {"key": 64, "track": 1})
        self.assertEqual(got["oneSemitoneBelow"], {"key": 64, "track": 1})
        self.assertIsNone(got["justOutsideTheBar"])
        self.assertIsNone(got["betweenTwoBars"])
        self.assertIsNone(got["beforeTheNoteStarts"])
        # At 960 the alto's first note has ended and the next one has begun;
        # its bar still covers this point, so that is what sounds.
        self.assertEqual(got["whereTheNextNoteTakesOver"], {"key": 65, "track": 1})
        self.assertIsNone(got["afterEverythingEnds"])
        self.assertEqual(got["theNextNoteInTime"], {"key": 65, "track": 1})
        # Track 3 shares the alto's pitch but is not shown, so it never sounds.
        self.assertEqual(got["hiddenPartIsNotHeard"], 1)
        self.assertEqual(got["tieGoesToTheFollowedPart"]["track"], 1)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_pressing_a_pitch_bar_sounds_it_and_holding_stops_the_seek(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("beginPitchAudition(event, preview, follow, scrubTarget)", app)
        self.assertIn("holdNote(key, track, { fullChord = false } = {}) {", app)
        # The audition is its own voice, so pausing or seeking playback does not
        # cut it off and stopVoices() does not sweep it up.
        self.assertIn("this.held = new Set();", app)

        self.assertIn("const PITCH_AUDITION_HOLD_MS = 250;", app)
        result = subprocess.run(
            [shutil.which("node") or "node", "--test", str(ROOT / "tests/score_audition.test.cjs")],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_starting_mid_phrase_plays_pickups_but_not_the_held_chord(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("resetScheduler(minimumLead = SCHEDULER_LEAD_SECONDS, { carryHeldNotes = false } = {})", app)
        body = app.split("resetScheduler(minimumLead = SCHEDULER_LEAD_SECONDS, { carryHeldNotes = false } = {}) {", 1)[1]
        body = body.split("\n    }", 1)[0]
        # Earlier standalone notes stay silent; slurred notes at a seek must sound.
        self.assertIn("(carryHeldNotes || note.segments) && note.end > position", body)
        self.assertLess(body.index("notes.slice(0, this.nextNoteIndex)"),
                        body.index("this.scheduleAhead(minimumLead)"))
        self.assertIn("const notes = this.playbackNotes || this.notes", body)
        # Tempo and divisi changes continue a phrase instead of starting over.
        self.assertEqual(app.count("carryHeldNotes: true"), 2)  # Tempo and divisi changes, never a seek.
        rate = app.split("    setRate(nextRate) {", 1)[1].split("\n    }", 1)[0]
        self.assertIn("this.resetScheduler(0.045, { carryHeldNotes: true });", rate)
        # Starting, seeking while played, and looping round are all fresh starts.
        for caller in ("play()", "seek(seconds)"):
            method = app.split(f"    {caller} {{", 1)[1].split("\n    }", 1)[0]
            self.assertNotIn("carryHeldNotes", method)

    def test_seeking_to_the_end_parks_there_instead_of_rewinding(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        # One limit, used by everything that sends playback somewhere: the seek
        # bar, its keys, and a click or drag on either score surface.
        self.assertEqual(app.count("latestSeekTick()"), 4)   # its own definition, then three callers
        self.assertIn("return clamp(Math.round(engine.tickAtSeconds(Number(milliseconds) / 1000)), 0, latestSeekTick());", app)
        self.assertIn("), 0, latestSeekTick());", app)
        self.assertNotIn("api.tickPosition = engine.tickAtSeconds(value / 1000)", app)
        # The end of the piece stops attracting seeks, or its snap window would
        # swallow the whole closing bar.
        self.assertIn(".filter((point) => point < maximum);", app)

        start = app.index("  function latestSeekTick")
        end = app.index("\n  }", start) + len("\n  }")
        script = f"""
let sequence;
{app[start:end]}
const at = (next) => {{ sequence = next; return latestSeekTick(); }};
console.log(JSON.stringify({{
  autumn: at({{ endTick: 110400, division: 960 }}),
  halfDivision: at({{ endTick: 110400, division: 480 }}),
  oddDivision: at({{ endTick: 1000, division: 7 }}),
  shorterThanASixtyFourth: at({{ endTick: 10, division: 960 }}),
  noDivision: at({{ endTick: 110400 }}),
  noSequence: at(undefined),
}}));
"""
        result = subprocess.run(
            [shutil.which("node") or "node", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        got = json.loads(result.stdout)
        # A sixty-fourth short of the end: inaudible, and clear of wherever the
        # player decides a seek has run off the end (measured: two ticks short).
        self.assertEqual(got["autumn"], 110400 - 60)
        self.assertEqual(got["halfDivision"], 110400 - 30)
        self.assertEqual(got["oddDivision"], 1000 - 1)
        self.assertEqual(got["shorterThanASixtyFourth"], 0)
        self.assertEqual(got["noDivision"], 110400 - 60)
        self.assertEqual(got["noSequence"], 0)

    def test_up_and_down_step_between_section_breaks(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        handler = app.split('if (["ArrowUp", "ArrowDown"].includes(event.key)', 1)[1].split("\n    }", 1)[0]
        # An editor's convention: up goes back a section, down goes on to the next.
        self.assertIn('event.key === "ArrowDown"', handler)
        self.assertIn("stops.find((point) => point > here + 1)", handler)
        self.assertIn("[...stops].reverse().find((point) => point < here - 1)", handler)
        # The end of the piece is a snap point too, and seeking onto it sends the
        # transport back to the start, so stepping stops at the last section.
        self.assertIn("point < engine.duration * 1000 - 1", handler)
        self.assertIn("if (step === undefined)", handler)
        # Section starts can fall mid-bar on a pickup, so the tick is used as-is.
        self.assertIn("applyScoreScrubTarget({ tick: engine.tickAtSeconds(step / 1000), exactTick: true });", handler)
        # The score has to come along, and the place it left must be read before
        # the seek or the move can never be detected.
        self.assertLess(handler.index("const from = playbackCursorPlace();"),
                        handler.index("applyScoreScrubTarget("))
        self.assertIn("followCursorFrom(from);", handler)
        # Arrow keys belong to a focused control first; this only runs otherwise.
        guard = app.split("document.addEventListener(\"keydown\", (event) => {\n    const target = event.target;", 1)[1][:400]
        self.assertIn("if (event.defaultPrevented) return;", guard)

    def test_loop_and_notes_share_a_location_first_workflow(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('class="loop-pill"', document)
        self.assertNotIn('class="loop-route"', document)
        self.assertNotIn('id="loopClear"', document)
        self.assertIn('attachHoldReset(elements.loopStart', app)
        self.assertIn('Lucide Pencil, ISC license', document)
        self.assertIn('d="M21.174 6.812a1 1 0 0 0-3.986-3.987', document)
        self.assertNotIn('<dialog class="note-dialog"', document)
        self.assertIn('elements.noteMode.addEventListener("click", () => {', app)
        self.assertIn("startInlineNoteEdit(currentScoreTick(), currentScorePartIndex())", app)
        self.assertIn("function startInlineNoteEdit(scoreTick, scorePartIndex)", app)
        self.assertIn("function commitInlineNoteEdit(cancel = false)", app)
        self.assertNotIn("annotationMode", app)
        self.assertNotIn("setAnnotationMode", app)
        self.assertIn("let selectedScoreTick = null;", app)
        self.assertIn("let selectedScorePartIndex = null;", app)
        self.assertIn("let scoreScrub = null;", app)
        self.assertNotIn("pendingScorePointer", app)
        self.assertIn("function nearestPartIndexAtScoreY(measureIndex, scoreY, fallbackPartIndex)", app)
        self.assertIn("masterBounds?.bars", app)
        self.assertIn("left.distance - right.distance || left.centerDistance - right.centerDistance", app)
        self.assertIn("elements.score.dataset.selectedPart", app)
        self.assertIn("function scoreLocationAtTick(value)", app)
        self.assertIn("const [start, duration, rawBeats = 4, rawBeatType = 4]", app)
        self.assertIn("const nominalBeatDuration = division * 4 / beatType", app)
        self.assertIn('return `${measureIndex + 1}.${beatZeroIndex + 1}.${fractionDigits}`', app)
        self.assertIn("function standardScoreTargetAtClientPoint(clientX, clientY, fallbackPartIndex)", app)
        self.assertIn("lookup.findBeat?.(beat)", app)
        self.assertIn("const anchorX = Number.isFinite(beatX) ? beatX : x + width * fraction", app)
        self.assertIn('address.className = "score-note-location"', app)
        self.assertIn('deleteButton.className = "score-note-delete"', app)
        self.assertIn("noteBox.append(deleteButton, address, editor)", app)
        self.assertIn("noteBox.append(deleteButton, address, editButton)", app)
        self.assertNotIn("editor.placeholder", app)
        self.assertIn("if (editingAnnotation?.id === noteBox.dataset.annotationId) editingAnnotation = null", app)
        self.assertIn("if (annotations.has(noteBox.dataset.annotationId)) deleteAnnotation(tick, partIndex)", app)
        self.assertIn('function deleteAnnotation(tick, partIndex)', app)
        self.assertIn('deleteIcon.append(createSvgElement("path", { d: "M18 6 6 18M6 6l12 12" }))', app)
        self.assertIn('editor.className = "score-note-editor"', app)
        self.assertIn('editor.wrap = "off"', app)
        self.assertIn('split(/\\r\\n?|\\n/u).length', app)
        self.assertIn('context.measureText(line || " ").width', app)
        self.assertIn("editor.addEventListener(\"blur\"", app)
        self.assertIn('event.key === "Escape"', app)
        self.assertIn("event.metaKey || event.ctrlKey", app)
        self.assertIn("version: 3", app)
        self.assertIn("stored.version === 2", app)
        self.assertIn("Migrate the original measure-indexed note format", app)
        self.assertIn('annotationKey = songKey("notes");', app)
        self.assertIn("legacyAnnotationKeys", app)
        self.assertIn('`${songKey("notes")}:v3`', app)
        self.assertNotIn('annotationKey = `${preferenceKey}:notes`', app)
        self.assertNotIn("openNoteDialog", app)
        self.assertNotIn("noteDialog", app)
        self.assertIn(".score-note-box.is-editing", styles)
        self.assertIn(".score-note-editor", styles)
        self.assertIn(".score-note-pin", styles)
        self.assertIn(".score-note-delete", styles)
        self.assertIn("function standardScoreTargetAtClientPoint(clientX, clientY, fallbackPartIndex)", app)
        self.assertIn("function moveAnnotationRecord(currentId, tick, partIndex)", app)
        self.assertIn("function beginAnnotationDrag(event, noteBox, tick, partIndex)", app)
        self.assertIn('address.addEventListener("pointerdown"', app)
        self.assertIn('window.addEventListener("pointermove", move', app)
        self.assertIn("nearestPartIndexAtScoreY(target.measureIndex, scoreY, fallbackPartIndex)", app)
        self.assertIn("saveAnnotations()", app)
        self.assertIn('white-space: pre;', styles)
        self.assertNotIn('white-space: pre-wrap;', styles)
        box_rule = styles.split(".score-note-box {", 1)[1].split("}", 1)[0]
        self.assertIn("max-width: none", box_rule)
        self.assertIn("transform-origin: left bottom", box_rule)
        editor_rule = styles.split(".score-note-editor {", 1)[1].split("}", 1)[0]
        self.assertIn("max-height: none", editor_rule)
        self.assertIn("overflow: hidden", editor_rule)
        location_rule = styles.split(".score-note-location {", 1)[1].split("}", 1)[0]
        self.assertIn("cursor: grab", location_rule)
        self.assertIn("touch-action: none", location_rule)
        self.assertIn("function renderSelectedPartHighlight()", app)
        self.assertIn('highlight.className = "score-selected-part"', app)
        self.assertIn('const geometry = [x, y, width, height]', app)
        self.assertIn("if (existing.dataset.geometry === geometry) return", app)
        self.assertIn("existing.style.width = `${width}px`", app)
        self.assertIn("highlight.dataset.geometry = geometry", app)
        self.assertIn(".score-selected-part", styles)
        render_finished = app.split("api.renderFinished.on(() => {", 1)[1].split("api.playerReady.on", 1)[0]
        self.assertIn("engine?.pushPosition()", render_finished)
        self.assertIn("scheduleCursorTrimBurst()", render_finished)
        self.assertIn('loopStartMeasure = current;', app)
        self.assertIn('loopEndMeasure = current;', app)
        self.assertIn('hasStart ? (loopStartTick === null ? String(loopStartMeasure + 1) : scoreLocationAtTick(loopStartTick)) : "Start"', app)
        self.assertIn('hasEnd ? (loopEndTick === null ? String(loopEndMeasure + 1) : scoreLocationAtTick(loopEndTick)) : "End"', app)
        self.assertNotIn('`Start ${loopStartMeasure + 1}`', app)
        self.assertNotIn('`End ${loopEndMeasure + 1}`', app)
        loop_point_rule = styles.split(".loop-point {", 1)[1].split("}", 1)[0]
        self.assertIn("width: 100%", loop_point_rule)
        self.assertIn("min-width: 0", loop_point_rule)
        self.assertIn(".loop-point + .loop-point { border-left: 1px solid var(--line); }", styles)
        self.assertIn("@keyframes hold-reset-progress", styles)

    def test_compact_lyrics_control_is_shared_even_without_repeated_syllables(self) -> None:
        template = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        app, template, styles = build_trainer.install_compact_lyrics(app, template, "")
        self.assertEqual(template.count('id="annotationLayout"'), 1)
        self.assertNotIn('id="lyricsToggle"', template)
        self.assertNotIn("Unique lyrics", template)
        self.assertIn("function prepareSharedNotation()", app)
        self.assertIn("installSharedNotation();", app)
        self.assertIn("shared-notation-layer", styles)
        build = (ROOT / "build_trainer.py").read_text(encoding="utf-8")
        self.assertNotIn("remove_unique_lyrics_toggle", build)
        self.assertIn('atomic_write(staged_project / "app.js", app)', build)
        self.assertIn('atomic_write(staged_project / "styles.css", styles)', build)

    def test_display_controls_use_explicit_labels(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('class="control-stack display-controls"', document)
        self.assertEqual(document.count('class="display-control-row'), 3)
        self.assertIn('>Scroll</span>', document)
        self.assertIn('>Scale</span>', document)
        self.assertNotIn('>Stretch</span>', document)
        self.assertIn('role="group" aria-labelledby="scaleLabel"', document)
        self.assertIn('aria-label="Vertical scale"', document)
        self.assertIn('aria-label="Horizontal scale"', document)
        self.assertNotIn('class="display-control-row display-mode-row"', document)
        self.assertNotIn('class="display-control-row display-mic-row"', document)
        self.assertIn('class="binary-feature-button display-lyrics-toggle"', document)
        self.assertIn('id="annotationLayout" type="button" aria-pressed="false"', document)
        self.assertIn('>Compact Lyrics</button>', document)
        lyrics_button_rule = styles.split(
            ".display-feature-row .display-lyrics-toggle {", 1
        )[1].split("}", 1)[0]
        self.assertIn("width: 100%", lyrics_button_rule)
        self.assertIn("justify-self: stretch", lyrics_button_rule)
        self.assertIn("text-align: center", lyrics_button_rule)
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("captureNotationReloadAnchor()", app)
        self.assertIn("restoreNotationReloadScrollOffset(pending.anchor)", app)
        self.assertIn("restoreNotationReloadAnchor(pending.anchor)", app)
        self.assertIn("bounds.bottom < headerBottom + 2", app)
        self.assertIn("if (frame === 2)", app)
        self.assertIn("engine.seek(engine.secondsAtTick(pending.tick))", app)
        self.assertIn("pendingNotationReload.renderReady = true", app)
        self.assertIn("pendingNotationReload.playerReady = true", app)
        player_ready_body = app.split("api.playerReady.on(() => {", 1)[1].split("initializeMediaSession();", 1)[0]
        self.assertIn("engine.attach(api);", player_ready_body)
        self.assertIn("scheduleCursorTrimBurst()", app)
        self.assertNotIn("api.tickPosition = tick", app)
        pause_body = app.split("    pause() {", 1)[1].split("    }", 1)[0]
        self.assertNotIn("pushPosition", pause_body)
        self.assertNotIn('data-lyrics=', document)
        self.assertIn('aria-label="Score scroll direction"', document)
        self.assertIn('aria-label="Vertical scrolling"', document)
        self.assertIn('aria-label="Horizontal scrolling"', document)
        self.assertIn('d="M12 2v20"', document)
        self.assertIn('d="M2 12h20"', document)
        self.assertIn("Lucide move-vertical / move-horizontal", document)
        self.assertNotIn('>Direction</span>', document)
        self.assertNotIn('<span>Staff size</span>', document)
        self.assertNotIn('<span>Note spacing</span>', document)
        self.assertNotIn('<span>Height</span>', document)
        self.assertNotIn('<span>Spacing</span>', document)
        display_controls_rule = styles.split(".display-controls {", 1)[1].split("}", 1)[0]
        self.assertIn("min-width: 0", display_controls_rule)
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr))", display_controls_rule)
        self.assertIn("column-gap: var(--toolbar-row-gap)", display_controls_rule)
        self.assertIn("row-gap: var(--toolbar-row-gap)", display_controls_rule)
        self.assertIn(".display-fullscreen { grid-row: 4; grid-column: 3; }", styles)
        self.assertIn('class="control-group tools-group"', document)
        self.assertIn('id="toolsLabel">Tools</span>', document)
        self.assertIn(".display-feature-row { grid-column: 1 / 3; }", styles)
        display_row_rule = styles.split(".display-control-row {", 1)[1].split("}", 1)[0]
        self.assertIn("min-height: var(--toolbar-row-height)", display_row_rule)
        self.assertIn("grid-template-columns: subgrid", display_row_rule)
        self.assertIn("justify-content: start", display_row_rule)
        self.assertIn("gap: 0 var(--toolbar-row-gap)", display_row_rule)
        self.assertNotIn("justify-content: space-between", display_row_rule)
        self.assertIn(".display-control-row > :first-child { min-width: 0; justify-self: end; text-align: right; }", styles)
        self.assertIn(".display-control-row > :last-child { justify-self: start; }", styles)
        direction_rule = styles.split(".display-direction-row .pill-toggle {", 1)[1].split("}", 1)[0]
        self.assertIn("width: 100%", direction_rule)
        self.assertIn("grid-column: 2 / 4", direction_rule)
        self.assertIn("justify-self: stretch", direction_rule)
        direction_option_rule = styles.split(".display-controls .pill-option {", 1)[1].split("}", 1)[0]
        self.assertIn("flex: 1 1 50%", direction_option_rule)
        self.assertNotIn(".display-mode-row", styles)
        self.assertNotIn(".display-mic-row", styles)
        settings_rule = styles.split(".settings-strip {", 1)[1].split("}", 1)[0]
        self.assertIn("--toolbar-row-height: 24px", settings_rule)
        self.assertIn("--toolbar-row-gap: 3px", settings_rule)
        self.assertIn("--toolbar-unit-width: 48px", settings_rule)
        self.assertIn("--toolbar-double-unit: 99px", settings_rule)
        mixer_rule = styles.split(".mixer {", 1)[1].split("}", 1)[0]
        self.assertIn("row-gap: var(--toolbar-row-gap)", mixer_rule)

    def test_setting_help_is_explicit_opt_in_and_covers_dynamic_controls(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('id="settingsHelp" type="button" aria-pressed="false"', document)
        self.assertIn('aria-label="Show setting help"', document)
        self.assertIn('<circle cx="12" cy="12" r="10"></circle>', document)
        self.assertIn('id="settingsTooltip" role="tooltip" aria-hidden="true" hidden', document)
        self.assertIn('data-help="Tap to advance; drag to browse."', document)
        self.assertIn('data-help="Tap: trace pitch. Hold: clear trace."', document)
        self.assertNotIn('title="Unique lyrics', document)
        self.assertIn("let settingsHelpEnabled = false", app)
        self.assertIn("function setupSettingsHelp()", app)
        self.assertIn("setSettingsHelp(false)", app)
        self.assertIn('elements.settingsPanel.addEventListener("pointerdown", inspectSetting, true)', app)
        self.assertIn("event.stopImmediatePropagation()", app)
        self.assertIn('Hold to ${next}. Shift+Enter does the same.', app)
        self.assertIn('button.dataset.help = `${part.name} volume: drag vertically.`', app)
        self.assertIn("setupSettingsHelp();", app)
        self.assertIn(".settings-panel.is-help-mode [data-help] { cursor: help; }", styles)
        self.assertIn(".settings-tooltip.is-visible", styles)
        static_tooltips = re.findall(r'data-help="([^"]+)"', document)
        self.assertGreater(len(static_tooltips), 15)
        self.assertEqual([], [text for text in static_tooltips if len(text.split()) >= 10])
        self.assertNotIn('data-help="Hold to reset', document)
        self.assertNotIn("element.dataset.help = `Hold to reset", app)

    def test_space_is_global_transport_and_pointer_controls_release_focus(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn('event.code !== "Space" || isTextEntryTarget(event.target)', app)
        self.assertIn("event.stopImmediatePropagation()", app)
        self.assertIn("if (!event.repeat) {", app)
        self.assertIn("} else engine?.toggleTransport();", app)
        self.assertIn("!elements.takePanel.hidden && takePreviewUrl", app)
        self.assertIn('elements.playPause.addEventListener("click", () => engine?.toggleTransport())', app)
        self.assertIn('navigator.mediaSession.setActionHandler("play", () => { void engine?.startTransport(); })', app)
        self.assertIn('elements.playPause.setAttribute("aria-busy", String(preparing))', app)
        self.assertIn("}, { capture: true });", app)
        self.assertIn('elements.transport.addEventListener("pointerup"', app)
        self.assertIn("document.activeElement === control", app)
        self.assertIn("control.blur()", app)
        self.assertIn("target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable", app)

    def test_normalization_only_edits_real_print_start_tags(self) -> None:
        raw = b'''<?xml version="1.0" encoding="ISO-8859-1"?>
<score-partwise version="4.0">
  <credit><credit-words><![CDATA[Literal <print new-system="yes"> text]]></credit-words></credit>
  <part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <m:print xmlns:m="urn:test" new-system="yes" new-page='YES' blank-page="2">
      <system-layout><system-distance>99</system-distance></system-layout>
    </m:print>
    <attributes><divisions>1</divisions></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
  </measure></part>
</score-partwise>'''
        text, removed = build_trainer.normalize_musicxml(raw, Path("fixture.musicxml"))
        self.assertEqual(removed, 2)
        self.assertIn('CDATA[Literal <print new-system="yes"> text]', text)
        self.assertIn('blank-page="2"', text)
        self.assertIn("<system-distance>99</system-distance>", text)
        self.assertNotIn("new-page=", text)
        self.assertIn('encoding="UTF-8"', text)

    def test_continuing_lyric_syllables_gain_hyphens(self) -> None:
        raw = '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <note><lyric number="1"><syllabic>begin</syllabic><text>em</text></lyric></note>
    <note><lyric number="1"><syllabic>middle</syllabic><text>brac</text></lyric></note>
    <note><lyric number="1"><syllabic>end</syllabic><text>ing;</text></lyric></note>
    <note><lyric number="1"><syllabic>single</syllabic><text>But</text></lyric></note>
    <note><lyric number="1"><syllabic>begin</syllabic><text>al-</text></lyric></note>
    <note><lyric number="1"><text>bare</text></lyric></note>
  </measure></part>
</score-partwise>'''
        hyphenated, count = build_trainer.hyphenate_lyric_syllables(raw)
        texts = re.findall(r"<text>([^<]*)</text>", hyphenated)
        # begin/middle continue a word; end/single finish one; an existing
        # hyphen is not doubled; a lyric with no <syllabic> is left alone.
        self.assertEqual(texts, ["em-", "brac-", "ing;", "But", "al-", "bare"])
        self.assertEqual(count, 2)
        # idempotent: a second pass adds nothing
        again, second = build_trainer.hyphenate_lyric_syllables(hyphenated)
        self.assertEqual(again, hyphenated)
        self.assertEqual(second, 0)

    def test_short_repeated_lyrics_keep_only_syllable_changes(self) -> None:
        raw = '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <note><lyric number="1"><text>doo</text></lyric><lyric number="2"><text>doo</text></lyric></note>
    <note><rest/></note>
    <note><lyric number="1"><text>doo</text></lyric><lyric number="2"><text>verse</text></lyric></note>
    <note><lyric number="1"><text>words</text></lyric><lyric number="2"><text>doo</text></lyric></note>
    <note><lyric number="1"><text>doo</text></lyric><lyric number="2"><text>doo</text></lyric></note>
  </measure></part>
</score-partwise>'''
        marked, count = build_trainer.annotate_repeated_lyrics(raw)
        self.assertEqual(count, 2)
        root = build_trainer.ET.fromstring(marked)
        lyrics = [element for element in root.iter() if build_trainer.local_name(element.tag) == "lyric"]
        self.assertEqual(
            [lyric.attrib.get(build_trainer.REPEATED_LYRIC_ATTRIBUTE) for lyric in lyrics],
            [None, None, "true", None, None, None, None, "true"],
        )
        marked_again, count_again = build_trainer.annotate_repeated_lyrics(marked)
        self.assertEqual(count_again, 2)
        self.assertEqual(marked_again, marked)

    def test_long_repeats_are_isolated_by_part_and_verse_and_keep_transitions(self) -> None:
        lyrics = [(1, "doo")] * 4 + [(1, "word")] + [(1, "doo")] * 3
        notes = "".join(f'<note><lyric number="{verse}"><text>{text}</text></lyric>'
                        '<lyric number="2"><text>hm</text></lyric></note>' for verse, text in lyrics)
        raw = '<?xml version="1.0"?>\n<score-partwise><!-- keep this -->'
        raw += f'<part id="P1"><measure number="1">{notes}</measure></part>'
        raw += '<part id="P2"><measure number="1"><note><lyric><text>doo</text></lyric></note></measure></part></score-partwise>'
        marked, count = build_trainer.annotate_repeated_lyrics(raw)
        self.assertEqual(count, 3 + 2 + 7)
        self.assertIn("<!-- keep this -->", marked)
        root = build_trainer.ET.fromstring(marked)
        first = root.findall('part[@id="P1"]/measure/note/lyric[@number="1"]')
        self.assertEqual([i for i, lyric in enumerate(first) if lyric.get(build_trainer.REPEATED_LYRIC_ATTRIBUTE)], [1, 2, 3, 6, 7])
        self.assertIsNone(root.find('part[@id="P2"]/measure/note/lyric').get(build_trainer.REPEATED_LYRIC_ATTRIBUTE))
        self.assertEqual(build_trainer.annotate_repeated_lyrics(marked), (marked, count))

    def test_frontend_can_toggle_repeated_lyrics_without_affecting_playback_data(self) -> None:
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function scoreWithoutRepeatedLyrics(xml)", app)
        self.assertIn('[data-choir-repeated-lyric="true"]', app)
        self.assertIn("function setLyricsMode(next", app)
        shared = (ROOT / "template" / "shared_notation.js").read_text(encoding="utf-8")
        self.assertIn('setAttribute("aria-pressed", String(annotationLayout === "shared"))', shared)
        self.assertIn('setLyricsMode(annotationLayout === "shared" ? "changes" : "full"', shared)
        self.assertIn("scoreXmlForDisplayMode()", app)
        self.assertIn("lyrics: lyricsMode", app)

    def test_measure_numbers_and_chapter_emphasis_are_always_on(self) -> None:
        document = (ROOT / "template" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "template" / "styles.css").read_text(encoding="utf-8")
        self.assertNotIn('id="guidesButton"', document)
        self.assertNotIn('id="guidesPopover"', document)
        self.assertNotIn('id="measureNumbersToggle"', document)
        self.assertNotIn('data-measures=', document)
        self.assertNotIn('id="sectionsToggle"', document)
        self.assertNotIn('data-sections=', document)
        self.assertNotIn('id="notesVisibilityToggle"', document)
        self.assertNotIn('class="mini-switch', document)
        self.assertNotIn('data-notes=', document)
        self.assertNotIn("updateDynamicsButton", app)
        self.assertNotIn("dynamicsEnabled", app)
        self.assertIn("function applyMeasureNumberSettings", app)
        self.assertIn("settings.notation.elements.set(notationElement, true)", app)
        self.assertIn("BarNumberDisplay", app)
        self.assertIn("const value = display?.AllBars", app)
        self.assertIn("function renderSectionGuides", app)
        self.assertIn("function scheduleSectionGuides", app)
        self.assertIn("if (frame < 8) requestAnimationFrame(markAfterPaint)", app)
        self.assertIn('label.setAttribute("data-section-measure", "true")', app)
        self.assertIn('.at-surface-svg text[data-section-measure="true"]', styles)
        self.assertIn("font-weight: 900 !important", styles)
        self.assertIn("stroke: #c80000 !important", styles)
        self.assertIn("stroke-width: 0.4px", styles)
        self.assertNotIn("score-section-line", app)
        self.assertNotIn(".score-section-line", styles)
        self.assertIn('element.localName === "rehearsal"', app)
        self.assertIn("if ((!annotations.size && !editingAnnotation) || !api) return", app)
        self.assertNotIn("measureNumberMode", app)
        self.assertNotIn("sectionMode", app)
        self.assertNotIn("notesVisible", app)
        self.assertIn("settings.player.enableCursor = true", app)
        self.assertIn("settings.player.enableElementHighlighting = true", app)

    def test_standalone_inspection_ignores_inert_score_markup(self) -> None:
        document = '''<html><body>
<script type="application/xml"><link xlink:href="https://example.test/reference"/></script>
data:font/woff2;base64,AA
</body></html>'''
        build_trainer.verify_standalone(document)

    def test_standalone_inspection_rejects_external_css(self) -> None:
        document = '''<html><body>
<style>.x { background: url("https://example.test/image.png") }</style>
data:font/woff2;base64,AA
</body></html>'''
        with self.assertRaises(build_trainer.BuildError):
            build_trainer.verify_standalone(document)

    def test_nonempty_unowned_project_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            project.mkdir()
            (project / "sentinel.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(build_trainer.BuildError):
                build_trainer.validate_project_ownership(project)
            self.assertEqual((project / "sentinel.txt").read_text(encoding="utf-8"), "keep")

    def test_builder_ancestor_is_rejected(self) -> None:
        with self.assertRaises(build_trainer.BuildError):
            build_trainer.validate_project_path(ROOT.parent)

    def test_mscz_export_preserves_internal_score_basename(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "weekly-score.mscz"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("scores/Fancy Weekly Score.mscx", b"<museScore/>")

            fake_heavy = root / "heavy-run"
            fake_musescore = root / "mscore"
            fake_heavy.write_text("", encoding="utf-8")
            fake_musescore.write_text("", encoding="utf-8")
            destination = root / "export" / "score.musicxml"
            captured: list[str] = []

            def fake_run(
                _label: str, command: list[str], *, timeout_seconds: int
            ) -> subprocess.CompletedProcess[str]:
                self.assertGreater(timeout_seconds, 0)
                captured.extend(command)
                destination.write_text("<score-partwise/>", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                mock.patch.object(build_trainer, "HEAVY_RUN", fake_heavy),
                mock.patch.object(build_trainer, "MUSESCORE", fake_musescore),
                mock.patch.object(build_trainer, "run_checked_command", fake_run),
            ):
                build_trainer.export_with_musescore(
                    archive_path, destination, root / "project"
                )

            imported = destination.parent / "Fancy Weekly Score.mscx"
            self.assertTrue(imported.is_file())
            self.assertEqual(imported.read_bytes(), b"<museScore/>")
            self.assertIn(str(imported), captured)

    def test_macos_musescore_startup_abort_is_bounded_and_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "Weekly Score.mscx"
            source.write_text("<museScore/>", encoding="utf-8")
            destination = root / "score.musicxml"
            fake_heavy = root / "heavy-run"
            fake_musescore = root / "mscore"
            fake_heavy.write_text("", encoding="utf-8")
            fake_musescore.write_text("", encoding="utf-8")
            attempts = 0

            def flaky_run(
                _label: str, command: list[str], *, timeout_seconds: int
            ) -> subprocess.CompletedProcess[str]:
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    raise build_trainer.BuildError(
                        "MuseScore export failed with exit code 134."
                    )
                destination.write_text("<score-partwise/>", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                mock.patch.object(build_trainer, "HEAVY_RUN", fake_heavy),
                mock.patch.object(build_trainer, "MUSESCORE", fake_musescore),
                mock.patch.object(build_trainer, "run_checked_command", flaky_run),
                mock.patch.object(build_trainer.sys, "platform", "darwin"),
            ):
                build_trainer.export_with_musescore(
                    source, destination, root / "project"
                )

            self.assertEqual(attempts, 3)
            self.assertTrue(destination.is_file())

    def test_cached_musicxml_requires_matching_source_and_export_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            assets = project / "assets"
            assets.mkdir(parents=True)
            score = '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>
  <part id="P1"><measure number="1"/></part>
</score-partwise>
'''
            (assets / "score.musicxml").write_bytes(score.encode("utf-8"))
            source_hash = build_trainer.sha256(b"source archive")
            metadata = {
                "layoutBreaksRemoved": 7,
                "build": {
                    "source": {"sha256": source_hash},
                    "normalizedScoreSha256": build_trainer.sha256(
                        score.encode("utf-8")
                    ),
                },
            }
            (assets / "build-metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )

            self.assertEqual(
                build_trainer.load_cached_musicxml(project, source_hash),
                (score, 7),
            )
            self.assertIsNone(
                build_trainer.load_cached_musicxml(project, "different-source")
            )
            (assets / "score.musicxml").write_text(
                score.replace("<measure", "<measure implicit=\"yes\""),
                encoding="utf-8",
            )
            self.assertIsNone(
                build_trainer.load_cached_musicxml(project, source_hash)
            )

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_repeat_markup_in_xml_comment_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            playback = Path(temporary) / "playback.json"
            metadata = Path(temporary) / "metadata.json"
            process = subprocess.run(
                [
                    shutil.which("node") or "node",
                    str(ROOT / "extract_score.mjs"),
                    "--score",
                    str(ROOT / "tests" / "fixtures" / "comment-repeat.musicxml"),
                    "--playback",
                    str(playback),
                    "--metadata",
                    str(metadata),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(playback.read_text(encoding="utf-8"))["endTick"], 3840)


if __name__ == "__main__":
    unittest.main()
