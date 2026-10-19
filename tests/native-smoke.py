"""Optional installed-MuseScore round trip; never reads a user's score."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_builder", ROOT / "build_trainer.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--musescore")
    args = parser.parse_args()
    executable = str(builder.find_musescore(args.musescore))
    parent = "/private/tmp" if sys.platform == "darwin" else None
    with tempfile.TemporaryDirectory(prefix="melete-native-smoke-", dir=parent) as name:
        temporary = Path(name)
        source = temporary / "Shared regression score.mscz"
        project = temporary / "player"
        builder.export_with_musescore(
            ROOT / "tests/fixtures/shared-regressions.musicxml", source, project,
            musescore=executable,
        )
        original = source.read_bytes()
        first = builder.build(builder.parse_args([
            str(source), "--project-dir", str(project), "--musescore", executable,
        ]))
        assert first["scoreConversion"] == "musescore-export", first
        assert first["measures"] == 4 and len(first["parts"]) == 3, first
        standalone = Path(first["output"]).read_bytes()
        builder.verify_standalone(standalone.decode("utf-8"))
        # A verified cache must not need to launch even a deliberately missing app.
        second = builder.build(builder.parse_args([
            str(source), "--project-dir", str(project), "--musescore", str(temporary / "missing-app"),
        ]))
        assert second["scoreConversion"] == "verified-cache", second
        assert second["fingerprint"] == first["fingerprint"]
        assert source.read_bytes() == original
        assert Path(second["output"]).read_bytes() == standalone
        assert (project / "assets/source" / source.name).read_bytes() == original
        print(json.dumps({"passed": True, "nativeExport": True, "verifiedCache": True,
                          "sourceUnchanged": True, "parts": 3, "measures": 4,
                          "standaloneBytes": len(standalone)}, indent=2))


if __name__ == "__main__":
    main()
