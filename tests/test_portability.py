import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("portable_builder", ROOT / "build_trainer.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class PortabilityTests(unittest.TestCase):
    def test_large_pitch_fixture_uses_stdin_not_windows_command_line(self):
        with mock.patch.object(builder.shutil, "which", return_value="node"), \
                mock.patch.object(builder, "run_checked_command") as run:
            runtime = " " * 40000
            builder.verify_pitchy_runtime(runtime)
            self.assertEqual(run.call_args.args[1], ["node", "-"])
            self.assertIn(runtime, run.call_args.kwargs["input_text"])

    def test_musescore_cli_option(self):
        args = builder.parse_args(["song.mscz", "--musescore", "/custom/MuseScore"])
        self.assertEqual(args.musescore, "/custom/MuseScore")

    def test_explicit_path_wins_over_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "MuseScore with spaces"
            executable.touch()
            with mock.patch.dict(os.environ, {"MUSESCORE": "/missing/environment-app"}):
                self.assertEqual(builder.find_musescore(str(executable)), executable.resolve())

    def test_environment_command_is_resolved_on_path(self):
        with mock.patch.dict(os.environ, {"MUSESCORE": "custom-mscore"}), \
                mock.patch.object(builder.shutil, "which", return_value="/custom/bin/mscore") as which:
            self.assertEqual(builder.find_musescore(), Path("/custom/bin/mscore"))
            which.assert_called_once_with("custom-mscore")

    def test_invalid_explicit_path_does_not_silently_use_another_version(self):
        with mock.patch.object(builder.shutil, "which", return_value=None):
            with self.assertRaisesRegex(builder.BuildError, "MuseScore executable not found"):
                builder.find_musescore("/missing/my-musescore")

    def test_path_detection_prefers_version_four(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(Path, "home", return_value=ROOT / "synthetic-home"), \
                mock.patch.object(Path, "is_file", return_value=False), \
                mock.patch.object(builder.shutil, "which", side_effect=lambda name:
                    "/bin/musescore4" if name == "musescore4" else None):
            self.assertEqual(builder.find_musescore(), Path("/bin/musescore4"))

    def test_windows_standard_install_location(self):
        expected = Path("D:/Apps/MuseScore 4/bin/MuseScore4.exe")
        with mock.patch.dict(os.environ, {"ProgramFiles": "D:/Apps"}, clear=True), \
                mock.patch.object(Path, "home", return_value=ROOT / "synthetic-home"), \
                mock.patch.object(builder.sys, "platform", "win32"), \
                mock.patch.object(Path, "is_file", autospec=True, side_effect=lambda path: path == expected):
            self.assertEqual(builder.find_musescore(), expected.resolve())

    def test_missing_musescore_explains_musicxml_fallback(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(Path, "home", return_value=ROOT / "synthetic-home"), \
                mock.patch.object(Path, "is_file", return_value=False), \
                mock.patch.object(builder.shutil, "which", return_value=None):
            with self.assertRaisesRegex(builder.BuildError, "Alternatively export uncompressed MusicXML"):
                builder.find_musescore()

    def test_export_works_without_optional_supervisor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / "MuseScore with spaces"
            executable.touch()
            source = root / "score.mscx"
            source.write_text("<museScore/>")
            destination = root / "score.musicxml"

            def exported(label, command, *, timeout_seconds):
                self.assertEqual(command, [str(executable.resolve()), "-o", str(destination), str(source)])
                destination.write_text("<score-partwise/>")
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(builder, "HEAVY_RUN", root / "no-supervisor"), \
                    mock.patch.object(builder.shutil, "which", return_value=None), \
                    mock.patch.object(builder.sys, "platform", "linux"), \
                    mock.patch.object(builder, "run_checked_command", side_effect=exported):
                builder.export_with_musescore(source, destination, root / "project", musescore=str(executable))

    def test_installed_supervisor_failure_is_not_bypassed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable, supervisor = root / "mscore", root / "heavy-run"
            executable.touch()
            supervisor.touch()
            with mock.patch.object(builder, "HEAVY_RUN", supervisor), \
                    mock.patch.object(builder, "run_checked_command", side_effect=builder.BuildError("Not admitted")) as run:
                with self.assertRaisesRegex(builder.BuildError, "Not admitted"):
                    builder.export_with_musescore(root / "source.mscx", root / "out.musicxml",
                                                 root / "project", musescore=str(executable))
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[1][0], str(supervisor))

    def test_launch_error_is_actionable(self):
        with mock.patch.object(builder.subprocess, "run", side_effect=PermissionError("not executable")):
            with self.assertRaisesRegex(builder.BuildError, "Could not launch MuseScore"):
                builder.run_checked_command("MuseScore", ["bad-app"], timeout_seconds=10)
