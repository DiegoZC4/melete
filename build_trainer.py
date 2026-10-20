#!/usr/bin/env python3
"""Build a reusable choir-practice project and a standalone offline HTML file.

The frontend template deliberately contains literal embedding markers.  This
script keeps those markers in one place, verifies that each appears exactly
once, and fails rather than emitting a partially bundled page.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Iterable


BUILDER_VERSION = "1"
PROJECT_MARKER_NAME = ".choir-practice-builder-project.json"
PROJECT_MARKER_SCHEMA_VERSION = 1
MUSESCORE_EXPORT_TIMEOUT_SECONDS = 600
EXTRACTOR_TIMEOUT_SECONDS = 120
ROOT = Path(__file__).resolve().parent
TEMPLATE_DIR = ROOT / "template"
VENDOR_DIR = ROOT / "vendor"
EXTRACTOR = ROOT / "extract_score.mjs"
HEAVY_RUN = Path.home() / ".local" / "bin" / "heavy-run"
MUSESCORE = Path("/Applications/MuseScore 4.app/Contents/MacOS/mscore")

SUPPORTED_SUFFIXES = {".mscz", ".mscx", ".musicxml", ".xml"}
MUSESCORE_SUFFIXES = {".mscz", ".mscx"}

STYLE_MARKER = '<link rel="stylesheet" href="./styles.css" data-inline />'
ALPHATAB_MARKER = (
    '<script src="./vendor/alphatab/alphaTab.min.js" data-inline></script>'
)
PITCHY_MARKER = '<script src="./vendor/pitchy/pitchy-browser.js" data-inline></script>'
FONT_MARKER = (
    'window.TRAINER_FONT_SOURCE = "./vendor/alphatab/font/Bravura.woff2";'
)
SCORE_MARKER = (
    '<script id="score-data" '
    'type="application/vnd.recordare.musicxml+xml"></script>'
)
PLAYBACK_MARKER = '<script id="playback-data" type="application/json"></script>'
CONFIG_MARKER = '<script id="trainer-config" type="application/json"></script>'
METADATA_MARKER = '<script id="build-metadata" type="application/json"></script>'
APP_MARKER = '<script src="./app.js" data-inline></script>'
LICENSE_MARKER = "<!-- THIRD_PARTY_NOTICES -->"
REPEATED_LYRIC_ATTRIBUTE = "data-choir-repeated-lyric"
REPEATED_LYRIC_MINIMUM = 2

REQUIRED_TEMPLATE_MARKERS = (
    STYLE_MARKER,
    ALPHATAB_MARKER,
    PITCHY_MARKER,
    FONT_MARKER,
    SCORE_MARKER,
    PLAYBACK_MARKER,
    CONFIG_MARKER,
    METADATA_MARKER,
    APP_MARKER,
    LICENSE_MARKER,
)


class BuildError(RuntimeError):
    """A concise, user-actionable build failure."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Turn a MuseScore or MusicXML score into a reusable development "
            "project and one downloadable, offline rehearsal HTML file."
        )
    )
    parser.add_argument(
        "score",
        type=Path,
        help="input .mscz, .mscx, .musicxml, or .xml score",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="standalone HTML destination (default: PROJECT/dist/index.html)",
    )
    parser.add_argument(
        "--project-dir",
        type=Path,
        help="generated source project (default: SCORE_DIR/SLUG-practice-web)",
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="optional JSON object merged over inferred trainer defaults",
    )
    parser.add_argument(
        "--musescore",
        help=(
            "MuseScore 4 executable path or command (also MUSESCORE environment "
            "variable; otherwise detected automatically)"
        ),
    )
    parser.add_argument(
        "--refresh-score",
        action="store_true",
        help=(
            "re-export MuseScore input even when the owned project contains "
            "a verified MusicXML export of the same source bytes"
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"choir-practice-builder {BUILDER_VERSION}",
    )
    return parser.parse_args(argv)


def read_required(path: Path, *, binary: bool = False) -> str | bytes:
    if not path.is_file():
        raise BuildError(f"Required builder file is missing: {path}")
    try:
        return path.read_bytes() if binary else path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BuildError(f"Could not read {path}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise BuildError(f"Expected UTF-8 text in {path}: {exc}") from exc


def atomic_write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        mode = "wb" if isinstance(data, bytes) else "w"
        kwargs: dict[str, Any] = {}
        if isinstance(data, str):
            kwargs = {"encoding": "utf-8", "newline": "\n"}
        with os.fdopen(descriptor, mode, **kwargs) as handle:
            handle.write(data)
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_json(value: Any, *, pretty: bool = False) -> str:
    if pretty:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ) + "\n"
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def safe_script_text(value: str) -> str:
    # Script elements are raw-text elements even when their type is JSON/XML.
    return re.sub(r"</script", r"<\\/script", value, flags=re.IGNORECASE)


def normalized_words(value: str | None) -> str:
    return " ".join((value or "").split())


def slugify(value: str, fallback: str = "choir-score") -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode(
        "ascii", "ignore"
    ).decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    return slug or fallback


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def first_local_text(root: ET.Element, names: Iterable[str]) -> str:
    wanted = set(names)
    for element in root.iter():
        if local_name(element.tag) in wanted:
            value = normalized_words("".join(element.itertext()))
            if value:
                return value
    return ""


def score_metadata(xml_text: str, fallback_title: str) -> dict[str, Any]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise BuildError(f"The normalized MusicXML is invalid: {exc}") from exc

    if local_name(root.tag) != "score-partwise":
        raise BuildError(
            "The score must be partwise MusicXML (root element score-partwise)."
        )

    title = first_local_text(root, ("work-title", "movement-title"))
    if not title:
        for credit in root.iter():
            if local_name(credit.tag) != "credit":
                continue
            credit_types = {
                normalized_words(child.text).lower()
                for child in credit
                if local_name(child.tag) == "credit-type"
            }
            if "title" in credit_types:
                title = first_local_text(credit, ("credit-words",))
                if title:
                    break
    placeholder_titles = {"untitled", "untitled score", "title"}
    if not title or normalized_words(title).casefold() in placeholder_titles:
        title = fallback_title

    composers: list[str] = []
    for element in root.iter():
        if local_name(element.tag) != "creator":
            continue
        if element.attrib.get("type", "").strip().lower() != "composer":
            continue
        creator = normalized_words("".join(element.itertext()))
        if creator.casefold() in {
            "composer",
            "composer / arranger",
            "composer/arranger",
            "music by",
        }:
            continue
        if creator and creator not in composers:
            composers.append(creator)

    part_names: list[str] = []
    for score_part in root.iter():
        if local_name(score_part.tag) != "score-part":
            continue
        name = first_local_text(score_part, ("part-name", "part-abbreviation"))
        if name:
            part_names.append(name)

    measure_count = 0
    first_part_seen = False
    for part in root.iter():
        if local_name(part.tag) != "part":
            continue
        if not first_part_seen:
            measure_count = sum(
                1 for child in part if local_name(child.tag) == "measure"
            )
            first_part_seen = True

    if not part_names or not first_part_seen or measure_count < 1:
        raise BuildError("The MusicXML does not contain any playable score parts.")

    return {
        "title": title,
        "composer": "; ".join(composers),
        "partNames": part_names,
        "measureCount": measure_count,
    }


def decode_xml(raw: bytes, source: Path) -> str:
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    elif raw.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    else:
        declaration = re.match(
            rb"\s*<\?xml[^>]*\bencoding\s*=\s*['\"]([^'\"]+)['\"]",
            raw[:512],
            flags=re.IGNORECASE,
        )
        encoding = declaration.group(1).decode("ascii") if declaration else "utf-8"
    try:
        return raw.decode(encoding)
    except (LookupError, UnicodeDecodeError) as exc:
        raise BuildError(f"Could not decode MusicXML {source} as {encoding}: {exc}") from exc


def xml_markup_end(text: str, start: int) -> int:
    """Return the exclusive end of one XML markup token.

    This deliberately recognizes comments, CDATA, processing instructions,
    declarations/DOCTYPE internal subsets, and ordinary quoted tags.  It is a
    lexical edit helper rather than an XML serializer, so unrelated source
    spelling, whitespace, comments, and metadata stay intact.
    """

    if text.startswith("<!--", start):
        end = text.find("-->", start + 4)
        return len(text) if end < 0 else end + 3
    if text.startswith("<![CDATA[", start):
        end = text.find("]]>", start + 9)
        return len(text) if end < 0 else end + 3
    if text.startswith("<?", start):
        end = text.find("?>", start + 2)
        return len(text) if end < 0 else end + 2

    quote = ""
    subset_depth = 0
    index = start + 1
    declaration = text.startswith("<!", start)
    while index < len(text):
        character = text[index]
        if quote:
            if character == quote:
                quote = ""
        elif character in "\"'":
            quote = character
        elif declaration and character == "[":
            subset_depth += 1
        elif declaration and character == "]" and subset_depth:
            subset_depth -= 1
        elif character == ">" and subset_depth == 0:
            return index + 1
        index += 1
    return len(text)


def strip_print_break_attributes(tag: str) -> tuple[str, int]:
    name_match = re.match(r"<\s*([A-Za-z_][\w:.-]*)", tag)
    if not name_match or name_match.group(1).rsplit(":", 1)[-1].casefold() != "print":
        return tag, 0

    removals: list[tuple[int, int]] = []
    index = name_match.end()
    tag_end = len(tag)
    while index < tag_end:
        whitespace_start = index
        while index < tag_end and tag[index].isspace():
            index += 1
        if index >= tag_end or tag[index] in "/>":
            break

        attribute_start = index
        while index < tag_end and not tag[index].isspace() and tag[index] not in "=/>":
            index += 1
        attribute_name = tag[attribute_start:index]
        while index < tag_end and tag[index].isspace():
            index += 1
        if index >= tag_end or tag[index] != "=":
            # Invalid XML is reported by ElementTree after this lexical pass.
            while index < tag_end and tag[index] not in "/>":
                index += 1
            continue
        index += 1
        while index < tag_end and tag[index].isspace():
            index += 1
        if index >= tag_end or tag[index] not in "\"'":
            while index < tag_end and tag[index] not in "/>":
                index += 1
            continue
        quote = tag[index]
        value_start = index + 1
        value_end = tag.find(quote, value_start)
        if value_end < 0:
            break
        index = value_end + 1
        if (
            attribute_name.casefold() in {"new-system", "new-page"}
            and tag[value_start:value_end].strip().casefold() == "yes"
        ):
            removals.append((whitespace_start, index))

    if not removals:
        return tag, 0
    result = tag
    for start, end in reversed(removals):
        result = result[:start] + result[end:]
    return result, len(removals)


def normalize_xml_declaration(text: str) -> str:
    declaration = re.match(r"\A\s*<\?xml\b[\s\S]*?\?>", text, re.IGNORECASE)
    if not declaration:
        return text
    token = declaration.group(0)
    updated, count = re.subn(
        r"(\bencoding\s*=\s*)(['\"])[^'\"]+\2",
        r'\1"UTF-8"',
        token,
        count=1,
        flags=re.IGNORECASE,
    )
    if not count:
        return text
    return updated + text[declaration.end() :]


def normalize_musicxml(raw: bytes, source: Path) -> tuple[str, int]:
    text = decode_xml(raw, source).replace("\r\n", "\n").replace("\r", "\n")
    # Preserve source text rather than serializing an ElementTree. Only actual
    # print start tags are edited; print-like text in comments, CDATA, DTDs,
    # processing instructions, or attribute values is never touched.
    removed = 0
    pieces: list[str] = []
    cursor = 0
    while True:
        start = text.find("<", cursor)
        if start < 0:
            pieces.append(text[cursor:])
            break
        pieces.append(text[cursor:start])
        end = xml_markup_end(text, start)
        token = text[start:end]
        if not token.startswith(("</", "<!", "<?")):
            token, count = strip_print_break_attributes(token)
            removed += count
        pieces.append(token)
        cursor = end
        if end >= len(text):
            break
    text = normalize_xml_declaration("".join(pieces))
    try:
        ET.fromstring(text)
    except ET.ParseError as exc:
        raise BuildError(f"MusicXML normalization produced invalid XML: {exc}") from exc
    return text.rstrip() + "\n", removed


def xml_start_tag_local_name(token: str) -> str:
    if token.startswith(("</", "<!", "<?")):
        return ""
    match = re.match(r"<\s*([A-Za-z_][\w:.-]*)", token)
    return match.group(1).rsplit(":", 1)[-1] if match else ""


def hyphenate_lyric_syllables(xml_text: str) -> tuple[str, int]:
    """Append a hyphen to every syllable a word continues past.

    MuseScore draws a hyphen between the syllables of a divided word, but
    AlphaTab's MusicXML importer keeps only <text> and drops <syllabic>, so the
    trainer rendered "be com ing" where the score reads "be-com-ing". Blake
    asked for the hyphens back. Doing it here means notation, the pitch view,
    and the compact-lyrics pass all see the same strings.

    Only <syllabic>begin</syllabic> and <syllabic>middle</syllabic> take one;
    "end" and "single" finish a word and are left alone.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise BuildError(f"Could not read MusicXML lyrics for hyphenation: {exc}") from exc

    wanted: set[str] = set()
    for lyric in (e for e in root.iter() if local_name(e.tag) == "lyric"):
        syllabic = next((c for c in lyric if local_name(c.tag) == "syllabic"), None)
        if syllabic is None or (syllabic.text or "").strip().casefold() not in {"begin", "middle"}:
            continue
        for text_element in (c for c in lyric if local_name(c.tag) == "text"):
            value = "".join(text_element.itertext())
            if value and not value.endswith("-"):
                wanted.add(value)

    if not wanted:
        return xml_text, 0

    # Lexical edit, same discipline as annotate_repeated_lyrics: only the text
    # inside a <text> element that belongs to a continuing syllable is touched.
    pieces: list[str] = []
    cursor = 0
    added = 0
    in_lyric = False
    continuing = False
    pending_text = False
    while True:
        start = xml_text.find("<", cursor)
        if start < 0:
            pieces.append(xml_text[cursor:])
            break
        if pending_text:
            body = xml_text[cursor:start]
            if continuing and body.strip() and not body.rstrip().endswith("-"):
                pieces.append(body.rstrip() + "-")
                added += 1
            else:
                pieces.append(body)
            pending_text = False
        else:
            pieces.append(xml_text[cursor:start])
        end = xml_markup_end(xml_text, start)
        token = xml_text[start:end]
        name = xml_start_tag_local_name(token).casefold()
        lowered = token.casefold()
        if name == "lyric":
            in_lyric, continuing = True, False
        elif lowered.startswith("</") and lowered.lstrip("</").startswith("lyric"):
            in_lyric, continuing = False, False
        elif in_lyric and name == "syllabic":
            after = xml_text[end : xml_text.find("<", end)] if xml_text.find("<", end) > 0 else ""
            continuing = after.strip().casefold() in {"begin", "middle"}
        elif in_lyric and name == "text":
            pending_text = True
        pieces.append(token)
        cursor = end
        if end >= len(xml_text):
            break

    result = "".join(pieces)
    try:
        ET.fromstring(result)
    except ET.ParseError as exc:
        raise BuildError(f"Lyric hyphenation produced invalid XML: {exc}") from exc
    return result, added


def annotate_repeated_lyrics(xml_text: str) -> tuple[str, int]:
    """Mark unchanged syllables without rewriting MusicXML.

    Runs are tracked independently for each score part and lyric verse. Notes
    without lyrics do not interrupt a run, while a different lyric does, so a
    later return to the same syllable remains a useful visible transition.
    Only the first syllable in each run stays visible in Compact Lyrics mode.
    The lexical edit preserves the score's declaration, doctype, comments,
    whitespace, and unrelated source spelling.
    """

    attribute_pattern = re.compile(
        rf"\s+{re.escape(REPEATED_LYRIC_ATTRIBUTE)}\s*=\s*(['\"])[^'\"]*\1",
        flags=re.IGNORECASE,
    )
    pieces: list[str] = []
    cursor = 0
    while True:
        start = xml_text.find("<", cursor)
        if start < 0:
            pieces.append(xml_text[cursor:])
            break
        pieces.append(xml_text[cursor:start])
        end = xml_markup_end(xml_text, start)
        token = xml_text[start:end]
        if xml_start_tag_local_name(token).casefold() == "lyric":
            token = attribute_pattern.sub("", token)
        pieces.append(token)
        cursor = end
        if end >= len(xml_text):
            break
    clean_text = "".join(pieces)

    try:
        root = ET.fromstring(clean_text)
    except ET.ParseError as exc:
        raise BuildError(f"Could not label repeated MusicXML lyrics: {exc}") from exc

    duplicate_ordinals: set[int] = set()
    lyric_ordinal = 0

    def finish_run(run: list[int]) -> None:
        if len(run) >= REPEATED_LYRIC_MINIMUM:
            duplicate_ordinals.update(run[1:])

    for part in (element for element in root.iter() if local_name(element.tag) == "part"):
        previous_by_verse: dict[tuple[str, str], str] = {}
        runs: dict[tuple[str, str], list[int]] = {}
        for note in (element for element in part.iter() if local_name(element.tag) == "note"):
            for lyric in (child for child in note if local_name(child.tag) == "lyric"):
                text = normalized_words(
                    "".join(
                        "".join(child.itertext())
                        for child in lyric
                        if local_name(child.tag) == "text"
                    )
                )
                if text:
                    verse = (
                        lyric.attrib.get("number", "1").strip(),
                        lyric.attrib.get("name", "").strip(),
                    )
                    if previous_by_verse.get(verse) != text:
                        finish_run(runs.get(verse, []))
                        runs[verse] = []
                        previous_by_verse[verse] = text
                    runs[verse].append(lyric_ordinal)
                lyric_ordinal += 1
        for run in runs.values():
            finish_run(run)

    annotated: list[str] = []
    cursor = 0
    lexical_ordinal = 0
    while True:
        start = clean_text.find("<", cursor)
        if start < 0:
            annotated.append(clean_text[cursor:])
            break
        annotated.append(clean_text[cursor:start])
        end = xml_markup_end(clean_text, start)
        token = clean_text[start:end]
        if xml_start_tag_local_name(token).casefold() == "lyric":
            if lexical_ordinal in duplicate_ordinals:
                token = re.sub(
                    r"(\s*/?>)$",
                    rf' {REPEATED_LYRIC_ATTRIBUTE}="true"\1',
                    token,
                    count=1,
                )
            lexical_ordinal += 1
        annotated.append(token)
        cursor = end
        if end >= len(clean_text):
            break

    if lexical_ordinal != lyric_ordinal:
        raise BuildError(
            "Could not safely map repeated lyrics back to the MusicXML source "
            f"({lyric_ordinal} parsed, {lexical_ordinal} found)."
        )
    result = "".join(annotated)
    try:
        ET.fromstring(result)
    except ET.ParseError as exc:
        raise BuildError(f"Repeated-lyric labeling produced invalid XML: {exc}") from exc
    return result.rstrip() + "\n", len(duplicate_ordinals)


def command_failure(label: str, process: subprocess.CompletedProcess[str]) -> BuildError:
    details = "\n".join(
        chunk.strip()
        for chunk in (process.stdout or "", process.stderr or "")
        if chunk.strip()
    )
    suffix = f"\n{details}" if details else ""
    return BuildError(f"{label} failed with exit code {process.returncode}.{suffix}")


def run_checked_command(
    label: str, command: list[str], *, timeout_seconds: int, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            input=input_text,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        output = "\n".join(
            str(chunk).strip()
            for chunk in (exc.stdout or "", exc.stderr or "")
            if str(chunk).strip()
        )
        details = f"\n{output}" if output else ""
        raise BuildError(
            f"{label} timed out after {timeout_seconds} seconds.{details}"
        ) from exc
    except OSError as exc:
        raise BuildError(f"Could not launch {label}: {exc}") from exc
    if process.returncode:
        raise command_failure(label, process)
    return process


def find_musescore(explicit: str | None = None) -> Path:
    requested = explicit or os.environ.get("MUSESCORE")
    if requested:
        candidate = Path(requested).expanduser()
        if candidate.is_file():
            return candidate.resolve()
        command = shutil.which(requested)
        if command:
            return Path(command)
        raise BuildError(f"MuseScore executable not found: {requested}")

    candidates = [MUSESCORE, Path.home() / "Applications/MuseScore 4.app/Contents/MacOS/mscore"]
    if sys.platform == "win32":
        candidates.extend(
            Path(os.environ.get(key, default)) / "MuseScore 4/bin/MuseScore4.exe"
            for key, default in (("ProgramFiles", "C:/Program Files"),
                                 ("ProgramFiles(x86)", "C:/Program Files (x86)"))
        )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    for name in ("musescore4", "mscore4", "MuseScore4", "mscore", "musescore"):
        command = shutil.which(name)
        if command:
            return Path(command)
    raise BuildError(
        "MuseScore 4 was not found. Install it and pass --musescore PATH "
        "(or set MUSESCORE). Alternatively export uncompressed MusicXML "
        "from MuseScore and pass that .musicxml file instead."
    )


def export_with_musescore(
    source: Path, destination: Path, project_dir: Path, *, musescore: str | None = None
) -> None:
    executable = find_musescore(musescore)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    import_source = source
    if source.suffix.lower() == ".mscz":
        try:
            with zipfile.ZipFile(source) as archive:
                score_entries = [
                    info
                    for info in archive.infolist()
                    if not info.is_dir()
                    and Path(info.filename).suffix.lower() == ".mscx"
                ]
                if len(score_entries) != 1:
                    raise BuildError(
                        "MuseScore archive must contain exactly one .mscx score; "
                        f"found {len(score_entries)}."
                    )
                score_entry = score_entries[0]
                score_bytes = archive.read(score_entry)
        except (OSError, zipfile.BadZipFile, KeyError) as exc:
            raise BuildError(f"Could not read MuseScore archive {source}: {exc}") from exc
        # Keep the score document's original basename. MuseScore 4.7 on macOS
        # can abort during noninteractive import when the same valid document
        # is renamed to a generic `source.mscx` temporary filename.
        import_source = destination.parent / Path(score_entry.filename).name
        atomic_write(import_source, score_bytes)
    collision_key = f"choir-practice-export:{project_dir.resolve()}"
    musescore_invocation = [str(executable)]
    native_arch = Path("/usr/bin/arch")
    if (
        sys.platform == "darwin"
        and platform.machine() == "arm64"
        and native_arch.is_file()
    ):
        # MuseScore's universal macOS bundle can occasionally start its Intel
        # slice from a noninteractive process, then abort in Rosetta before it
        # opens the score. Pin the native slice on Apple-silicon Macs.
        musescore_invocation = [str(native_arch), "-arm64", str(executable)]
    command = [
        *musescore_invocation,
        "-o",
        str(destination),
        str(import_source),
    ]
    # Use the local process supervisor when installed, without making another
    # user's machine depend on it. Never silently bypass an installed wrapper.
    supervisor = str(HEAVY_RUN) if HEAVY_RUN.is_file() else shutil.which("heavy-run")
    if supervisor:
        command = [supervisor, "--label", "choir-score-export", "--key", collision_key,
                   "--", *command]
    attempts = 3 if sys.platform == "darwin" else 1
    for attempt in range(1, attempts + 1):
        try:
            run_checked_command(
                "MuseScore export",
                command,
                timeout_seconds=MUSESCORE_EXPORT_TIMEOUT_SECONDS,
            )
            break
        except BuildError as exc:
            # MuseScore 4.7's noninteractive macOS converter can abort during
            # startup with exit 134 before it reads the score. A bounded retry
            # is safe because the destination lives in build staging and is
            # removed between attempts.
            if attempt == attempts or "exit code 134" not in str(exc):
                raise
            destination.unlink(missing_ok=True)
    if not destination.is_file() or destination.stat().st_size == 0:
        raise BuildError("MuseScore reported success but did not create MusicXML.")


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    if not path.is_file():
        raise BuildError(f"Config file does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"Could not read config JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BuildError("The config file must contain one JSON object.")
    return value


def effective_config(
    inferred: dict[str, Any], override: dict[str, Any]
) -> dict[str, Any]:
    override_title = override.get("title", inferred["title"])
    if not isinstance(override_title, str) or not normalized_words(override_title):
        raise BuildError("Config field 'title' must be a non-empty string.")
    title = normalized_words(override_title)
    defaults: dict[str, Any] = {
        "schemaVersion": 1,
        "title": title,
        "composer": inferred["composer"],
        "slug": slugify(title),
        "favicon": "🎶",
    }
    config = deep_merge(defaults, override)
    for field in ("title", "composer", "slug", "favicon"):
        if not isinstance(config.get(field), str):
            raise BuildError(f"Config field '{field}' must be a string.")
    config["title"] = normalized_words(config["title"])
    config["composer"] = normalized_words(config["composer"])
    config["slug"] = slugify(config["slug"], fallback=slugify(config["title"]))
    config["favicon"] = config["favicon"].strip()
    if not config["title"] or not config["favicon"]:
        raise BuildError("Config title and favicon may not be empty.")
    if "browserTitle" in config:
        if not isinstance(config["browserTitle"], str) or not normalized_words(config["browserTitle"]):
            raise BuildError("Config field 'browserTitle' must be a non-empty string.")
        config["browserTitle"] = normalized_words(config["browserTitle"])
    return config


def path_is_within(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
    except ValueError:
        return False
    return True


def validate_project_path(project_dir: Path) -> None:
    filesystem_root = Path(project_dir.anchor).resolve()
    home = Path.home().resolve()
    if project_dir in {filesystem_root, home}:
        raise BuildError(f"Refusing unsafe project directory: {project_dir}")
    if path_is_within(project_dir, ROOT) or path_is_within(ROOT, project_dir):
        raise BuildError(
            "The generated project may not be inside, contain, or overwrite "
            f"the builder tree: {project_dir}"
        )
    if project_dir.exists() and not project_dir.is_dir():
        raise BuildError(f"Project destination is not a directory: {project_dir}")


def validate_project_ownership(project_dir: Path) -> None:
    validate_project_path(project_dir)
    if not project_dir.exists():
        return
    try:
        nonempty = next(project_dir.iterdir(), None) is not None
    except OSError as exc:
        raise BuildError(f"Could not inspect project directory {project_dir}: {exc}") from exc
    if not nonempty:
        return

    marker = project_dir / PROJECT_MARKER_NAME
    if not marker.is_file():
        raise BuildError(
            "Refusing to overwrite a nonempty directory that is not owned by "
            f"choir-practice-builder: {project_dir}. Choose a new/empty directory."
        )
    marker_value = read_json_object(marker, "project ownership marker")
    if (
        marker_value.get("builder") != "choir-practice-builder"
        or marker_value.get("schemaVersion") != PROJECT_MARKER_SCHEMA_VERSION
    ):
        raise BuildError(
            f"Project ownership marker is invalid or unsupported: {marker}"
        )


def validate_output_path(
    output: Path,
    *,
    project_dir: Path,
    source: Path,
    config_path: Path | None,
) -> None:
    if output.suffix.lower() not in {".html", ".htm"}:
        raise BuildError("--output must name an .html or .htm file.")
    if output == source or (config_path is not None and output == config_path):
        raise BuildError("The standalone output may not overwrite an input file.")
    if path_is_within(output, ROOT):
        raise BuildError(f"The standalone output may not overwrite builder files: {output}")
    if output.exists() and output.is_dir():
        raise BuildError(f"Standalone output is a directory, not a file: {output}")
    if path_is_within(output, project_dir) and not path_is_within(
        output, project_dir / "dist"
    ):
        raise BuildError(
            "An output inside the generated project must be under its dist/ directory."
        )


def project_marker(fingerprint: str) -> str:
    return stable_json(
        {
            "builder": "choir-practice-builder",
            "fingerprint": fingerprint,
            "schemaVersion": PROJECT_MARKER_SCHEMA_VERSION,
        },
        pretty=True,
    )


def vacant_sibling(parent: Path, prefix: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=prefix, dir=parent)
    os.close(descriptor)
    path = Path(name)
    path.unlink()
    return path


def stage_external_output(output: Path, document: str) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".stage", dir=output.parent
    )
    staged = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(document)
    except Exception:
        staged.unlink(missing_ok=True)
        raise
    return staged


def commit_generated_outputs(
    *,
    staged_project: Path,
    project_dir: Path,
    staged_external: Path | None,
    external_output: Path | None,
) -> None:
    project_backup: Path | None = None
    output_backup: Path | None = None
    installed_project = False
    installed_output = False
    try:
        if project_dir.exists():
            project_backup = vacant_sibling(
                project_dir.parent, f".{project_dir.name}.backup-"
            )
            os.replace(project_dir, project_backup)
        if external_output is not None and external_output.exists():
            output_backup = vacant_sibling(
                external_output.parent, f".{external_output.name}.backup-"
            )
            os.replace(external_output, output_backup)

        os.replace(staged_project, project_dir)
        installed_project = True
        if staged_external is not None and external_output is not None:
            os.replace(staged_external, external_output)
            installed_output = True
    except Exception as exc:
        try:
            if installed_output and external_output is not None:
                external_output.unlink(missing_ok=True)
            if output_backup is not None and output_backup.exists():
                os.replace(output_backup, external_output)
            if installed_project and project_dir.exists():
                shutil.rmtree(project_dir)
            if project_backup is not None and project_backup.exists():
                os.replace(project_backup, project_dir)
        except OSError as rollback_exc:
            raise BuildError(
                f"Could not commit generated outputs ({exc}); rollback also failed: "
                f"{rollback_exc}"
            ) from exc
        raise BuildError(f"Could not commit generated outputs: {exc}") from exc
    else:
        if project_backup is not None and project_backup.exists():
            shutil.rmtree(project_backup, ignore_errors=True)
        if output_backup is not None and output_backup.exists():
            output_backup.unlink(missing_ok=True)


def copy_builder_sources(project_dir: Path) -> None:
    for filename in ("index.html", "styles.css", "app.js"):
        source = TEMPLATE_DIR / filename
        if not source.is_file():
            raise BuildError(f"Required template file is missing: {source}")
    if not VENDOR_DIR.is_dir():
        raise BuildError(f"Required vendor directory is missing: {VENDOR_DIR}")
    project_dir.mkdir(parents=True, exist_ok=True)
    for filename in ("index.html", "styles.css", "app.js"):
        shutil.copy2(TEMPLATE_DIR / filename, project_dir / filename)
    shutil.copy2(ROOT / "LICENSE", project_dir / "LICENSE")
    shutil.copytree(VENDOR_DIR, project_dir / "vendor", dirs_exist_ok=True)


def run_extractor(score: Path, playback: Path, metadata: Path) -> None:
    if not EXTRACTOR.is_file():
        raise BuildError(f"Score extractor is missing: {EXTRACTOR}")
    node = shutil.which("node")
    if not node:
        raise BuildError("Node.js is required to run extract_score.mjs.")
    playback.unlink(missing_ok=True)
    metadata.unlink(missing_ok=True)
    command = [
        node,
        str(EXTRACTOR),
        "--score",
        str(score),
        "--playback",
        str(playback),
        "--metadata",
        str(metadata),
    ]
    run_checked_command(
        "Score extraction",
        command,
        timeout_seconds=EXTRACTOR_TIMEOUT_SECONDS,
    )
    for path in (playback, metadata):
        if not path.is_file() or path.stat().st_size == 0:
            raise BuildError(f"Score extractor did not create {path.name}.")


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"Invalid {label} JSON at {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BuildError(f"{label} must be a JSON object.")
    return value


def load_cached_musicxml(
    project_dir: Path, source_sha256: str
) -> tuple[str, int] | None:
    """Reuse a verified normalized export for byte-identical MuseScore input.

    MSCZ is straightforward to unzip, but its contained MSCX is MuseScore's
    native model rather than MusicXML. The initial fidelity-preserving export
    still belongs to MuseScore; subsequent frontend/config builds should not
    pay that cost when both the original source hash and cached export hash
    prove that the notation input is unchanged.
    """

    score_path = project_dir / "assets" / "score.musicxml"
    metadata_path = project_dir / "assets" / "build-metadata.json"
    if not score_path.is_file() or not metadata_path.is_file():
        return None
    try:
        metadata = read_json_object(metadata_path, "cached build metadata")
        build = metadata.get("build")
        if not isinstance(build, dict):
            return None
        source = build.get("source")
        if not isinstance(source, dict) or source.get("sha256") != source_sha256:
            return None
        expected_score_sha256 = build.get("normalizedScoreSha256")
        if not isinstance(expected_score_sha256, str):
            return None
        score_bytes = score_path.read_bytes()
        if sha256(score_bytes) != expected_score_sha256:
            return None
        score_xml = score_bytes.decode("utf-8")
        root = ET.fromstring(score_xml)
        if local_name(root.tag) != "score-partwise":
            return None
    except (BuildError, OSError, UnicodeDecodeError, ET.ParseError):
        return None
    breaks_removed = metadata.get("layoutBreaksRemoved", 0)
    if not isinstance(breaks_removed, int) or isinstance(breaks_removed, bool):
        breaks_removed = 0
    return score_xml, max(0, breaks_removed)


def require_markers(template: str) -> None:
    errors = []
    for marker in REQUIRED_TEMPLATE_MARKERS:
        count = template.count(marker)
        if count != 1:
            errors.append(f"{marker!r}: found {count}, expected 1")
    if errors:
        raise BuildError("Template marker contract failed:\n  " + "\n  ".join(errors))


def replace_once(document: str, marker: str, replacement: str) -> str:
    count = document.count(marker)
    if count != 1:
        raise BuildError(f"Expected one template marker {marker!r}; found {count}.")
    return document.replace(marker, replacement, 1)


def pitchy_browser_runtime(fft_source: str, pitchy_source: str) -> str:
    """Turn Pitchy's small ESM source and fft.js CommonJS source into one browser script."""
    fft_runtime = re.sub(r"^'use strict';\s*", "", fft_source)
    fft_runtime = re.sub(r"^module\.exports = FFT;\s*$", "", fft_runtime, flags=re.MULTILINE)
    pitchy_runtime = re.sub(
        r'^import FFT from ["\']fft\.js["\'];\s*', "", pitchy_source
    )
    pitchy_runtime = re.sub(r"\bexport class\b", "class", pitchy_runtime)
    return (
        '(() => {\n  "use strict";\n'
        f"{fft_runtime}\n{pitchy_runtime}\n"
        "  window.Pitchy = Object.freeze({ Autocorrelator, PitchDetector });\n"
        "})();"
    )


def verify_pitchy_runtime(runtime: str) -> None:
    node = shutil.which("node")
    if not node:
        raise BuildError("Node.js is required to verify the pitch detector.")
    fixture = (
        "globalThis.window=globalThis;\n"
        f"{runtime}\n"
        "const n=4096,sr=48000,f=220,b=new Float32Array(n);"
        "for(let i=0;i<n;i++)b[i]=0.08*Math.sin(2*Math.PI*f*i/sr);"
        "const d=Pitchy.PitchDetector.forFloat32Array(n);d.minVolumeAbsolute=0;"
        "const [p,c]=d.findPitch(b,sr);"
        "if(!Number.isFinite(p)||Math.abs(p-f)>2||c<0.9)"
        "throw new Error(`pitch fixture failed: ${p}Hz clarity ${c}`);"
    )
    run_checked_command(
        "Pitch detector verification",
        [node, "-"],
        timeout_seconds=15,
        input_text=fixture,
    )


def third_party_notices(
    melete_license: str,
    alpha_license: str,
    font_license: str,
    lucide_license: str,
    pitchy_license: str,
    fft_license: str,
) -> str:
    return (
        "Melete (original code and documentation)\n"
        "https://github.com/DiegoZC4/melete\n\n"
        f"{melete_license.strip()}\n\n"
        "Third-party components retain their respective licenses below.\n\n"
        "alphaTab\n"
        "https://github.com/CoderLine/alphaTab\n\n"
        "Corresponding source (1.8.4, build 34):\n"
        "https://github.com/CoderLine/alphaTab/tree/022a45c8e42370f9e12e68949d11eada370da83d\n\n"
        f"{alpha_license.strip()}\n\n"
        "Bravura music font\n"
        "https://github.com/steinbergmedia/bravura\n\n"
        f"{font_license.strip()}\n\n"
        "Lucide File Pen Line icon\n"
        "https://lucide.dev/icons/file-pen-line\n\n"
        f"{lucide_license.strip()}\n\n"
        "YouTube brand icon\n"
        "https://github.com/simple-icons/simple-icons/blob/develop/icons/youtube.svg\n\n"
        "Released under CC0 1.0 Universal:\n"
        "https://creativecommons.org/publicdomain/zero/1.0/\n"
        "CC0 does not waive trademark rights. YouTube is a trademark of Google LLC;\n"
        "the icon identifies a link to YouTube and does not imply endorsement.\n\n"
        "Pitchy\n"
        "https://github.com/ianprime0509/pitchy\n\n"
        f"{pitchy_license.strip()}\n\n"
        "fft.js\n"
        "https://github.com/indutny/fft.js\n\n"
        f"{fft_license.strip()}\n"
    )


def favicon_data_uri(favicon: str) -> str:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<text x="50%" y=".9em" text-anchor="middle" font-size="90">'
        f"{html.escape(favicon)}"
        "</text></svg>"
    )
    return "data:image/svg+xml," + urllib.parse.quote(svg, safe="")


def decorate_head(
    document: str, title: str, favicon: str, fingerprint: str, *, browser_title: str | None = None
) -> str:
    title_tag = f"<title>{html.escape(browser_title if browser_title is not None else title + ' | Melete')}</title>"
    document, title_count = re.subn(
        r"<title\b[^>]*>.*?</title>",
        title_tag,
        document,
        count=1,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if title_count != 1:
        raise BuildError("Template must contain exactly one replaceable <title> element.")

    def remove_icon(match: re.Match[str]) -> str:
        tag = match.group(0)
        rel = re.search(r"\brel\s*=\s*(['\"])(.*?)\1", tag, re.IGNORECASE)
        if rel and "icon" in rel.group(2).lower().split():
            return ""
        return tag

    document = re.sub(
        r"<link\b[^>]*>", remove_icon, document, flags=re.IGNORECASE | re.DOTALL
    )
    # Other visible/accessibility template slots use the same escaped title.
    document = document.replace("{{TITLE}}", html.escape(title))
    description = f"Interactive choir rehearsal score for {title}."
    document = document.replace("{{DESCRIPTION}}", html.escape(description))

    insertion = (
        f'    <link rel="icon" href="{favicon_data_uri(favicon)}" />\n'
        f"    <!-- standalone-build:{fingerprint} -->\n"
    )
    if document.count("</head>") != 1:
        raise BuildError("Template must contain exactly one </head> element.")
    return document.replace("</head>", insertion + "  </head>", 1)


def install_system_annotations(app: str) -> str:
    app = replace_once(app, "  function createSvgElement(name, attributes = {}) {",
                       (TEMPLATE_DIR / "system_annotations.js").read_text()
                       + "\n  function createSvgElement(name, attributes = {}) {")
    if app.count("prepareSharedNotation();") != 2:
        raise BuildError("System-annotation render hooks changed")
    return app.replace("prepareSharedNotation();", "prepareSystemAnnotations();\n        prepareSharedNotation();")


def install_compact_lyrics(app: str, template: str, styles: str) -> tuple[str, str, str]:
    """One display preference for shared annotations and syllable changes."""
    app = replace_once(app, "  function createSvgElement(name, attributes = {}) {",
                       (TEMPLATE_DIR / "shared_notation.js").read_text()
                       + "\n  function createSvgElement(name, attributes = {}) {")
    for old, new in [
        ('      lyrics: defaults.lyrics === "changes" ? "changes" : "full",',
         '      lyrics: "full",\n      annotationLayouts: sharedNotationTools.annotationPreferences(defaults),'),
        ('    const previousLyrics = lyricsMode;',
         '    const previousLyrics = lyricsMode;\n    const previousAnnotationLayout = annotationLayout;'),
        ('    setLyricsMode(state.lyrics, { reload: false, persist: false });',
         '    restoreAnnotationLayouts(state, { render: false, persist: false });'),
        ('        || scoreView !== previousScoreView',
         '        || scoreView !== previousScoreView\n        || annotationLayout !== previousAnnotationLayout'),
        ('      state.lyrics = defaults.lyrics;',
         '      state.lyrics = defaults.lyrics;\n      state.annotationLayouts = { ...defaults.annotationLayouts };'),
        ('    setLyricsMode(defaults.lyrics, { reload: false, persist: false });',
         '    restoreAnnotationLayouts(defaults, { render: false, persist: false });'),
        ('  function applyPreferenceState(stored) {\n    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;',
         '  function applyPreferenceState(stored) {\n    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;\n    restoreAnnotationLayouts(stored, { render: false, persist: false });'),
        ('  function cloneSettingsState(state) {\n    return {\n      ...state,',
         '  function cloneSettingsState(state) {\n    return {\n      ...state,\n      annotationLayouts: { ...state.annotationLayouts },'),
        ('      installStaffLevelDynamics();', '      installStaffLevelDynamics();\n      installSharedNotation();'),
        ('        applyMeasureNumberSettings(api.settings, score);',
         '        applyMeasureNumberSettings(api.settings, score);\n        prepareSharedNotation();'),
        ('      api.updateSettings();\n      beginNotationRenderTimeout();',
         '      prepareSharedNotation();\n      api.updateSettings();\n      beginNotationRenderTimeout();'),
        ('          scheduleFullMeasureRestCentering();',
         '          scheduleFullMeasureRestCentering();\n          scheduleSharedNotation();'),
    ]:
        app = replace_once(app, old, new)
    if app.count("      lyrics: lyricsMode,") != 2:
        raise BuildError("Compact lyrics preference anchors changed")
    app = app.replace("      lyrics: lyricsMode,", "      lyrics: lyricsMode,\n      annotationLayouts: { ...annotationLayouts },")
    template = replace_once(template, 'data-help="Drag vertically to change spacing."',
        'data-help="Change horizontal spacing. In notation, 5% keeps minimum readable note and lyric gaps."')
    styles += """
      .display-annotation-row { min-width: 0; }
      #annotationLayout { width: 100%; grid-column: 1 / -1; justify-self: stretch; }
      .shared-anchor { opacity: 0; pointer-events: none; }
      .shared-notation-layer { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
      .shared-notation-layer text { fill: var(--ink); font-family: Georgia, serif; }
      .shared-notation-layer .shared-syllable { font-style: italic; }
      .shared-notation-layer .shared-owners { font-family: system-ui, sans-serif; font-weight: 700; }
      .shared-notation-layer .shared-dynamic { font-family: system-ui, sans-serif; font-weight: 650; }
    """
    return app, template, styles


def render_document(
    *,
    template: str,
    styles: str,
    app: str,
    alphatab: str,
    pitchy: str,
    font: bytes,
    score_xml: str,
    playback: dict[str, Any],
    config: dict[str, Any],
    metadata: dict[str, Any],
    notices: str,
    fingerprint: str,
    standalone: bool,
) -> str:
    require_markers(template)
    if re.search(r"</style", styles, flags=re.IGNORECASE):
        raise BuildError("styles.css contains an unsafe </style sequence.")
    if re.search(r"</script", app, flags=re.IGNORECASE):
        raise BuildError("app.js contains an unsafe </script sequence.")
    if re.search(r"</script", alphatab, flags=re.IGNORECASE):
        raise BuildError("alphaTab.min.js contains an unsafe </script sequence.")
    if re.search(r"</script", pitchy, flags=re.IGNORECASE):
        raise BuildError("Pitchy runtime contains an unsafe </script sequence.")

    score_value = safe_script_text(score_xml)
    playback_value = safe_script_text(stable_json(playback))
    config_value = safe_script_text(stable_json(config))
    metadata_value = safe_script_text(stable_json(metadata))
    notices_value = safe_script_text(notices)

    # Make structural HTML edits while this is still only the template. Once
    # the runtime is embedded, JavaScript strings may legitimately contain
    # snippets such as </head> or <link>, which must not be mistaken for the
    # document's own markup.
    document = decorate_head(
        template, config["title"], config["favicon"], fingerprint,
        browser_title=config.get("browserTitle"),
    )
    if standalone:
        font_uri = "data:font/woff2;base64," + base64.b64encode(font).decode(
            "ascii"
        )
        document = replace_once(
            document, STYLE_MARKER, f"<style>\n{styles}\n</style>"
        )
        document = replace_once(
            document,
            ALPHATAB_MARKER,
            f'<script id="alphatab-runtime">\n{alphatab}\n</script>',
        )
        document = replace_once(
            document,
            PITCHY_MARKER,
            f'<script id="pitchy-runtime">\n{pitchy}\n</script>',
        )
        document = replace_once(
            document,
            FONT_MARKER,
            f"window.TRAINER_FONT_SOURCE = {json.dumps(font_uri)};",
        )
        document = replace_once(
            document, APP_MARKER, f"<script>\n{app}\n</script>"
        )
    else:
        document = replace_once(
            document,
            STYLE_MARKER,
            '<link rel="stylesheet" href="./styles.css" />',
        )
        document = replace_once(
            document,
            ALPHATAB_MARKER,
            '<script src="./vendor/alphatab/alphaTab.min.js" defer></script>',
        )
        document = replace_once(
            document,
            PITCHY_MARKER,
            f'<script id="pitchy-runtime">\n{pitchy}\n</script>',
        )
        document = replace_once(
            document,
            FONT_MARKER,
            'window.TRAINER_FONT_SOURCE = new URL('
            '"./vendor/alphatab/font/Bravura.woff2", window.location.href).href;',
        )
        document = replace_once(
            document,
            APP_MARKER,
            '<script src="./app.js" defer></script>',
        )

    document = replace_once(
        document,
        SCORE_MARKER,
        '<script id="score-data" '
        f'type="application/vnd.recordare.musicxml+xml">\n{score_value}</script>',
    )
    document = replace_once(
        document,
        PLAYBACK_MARKER,
        f'<script id="playback-data" type="application/json">{playback_value}</script>',
    )
    document = replace_once(
        document,
        CONFIG_MARKER,
        f'<script id="trainer-config" type="application/json">{config_value}</script>',
    )
    document = replace_once(
        document,
        METADATA_MARKER,
        f'<script id="build-metadata" type="application/json">{metadata_value}</script>',
    )
    document = replace_once(
        document,
        LICENSE_MARKER,
        f'<script id="third-party-notices" type="text/plain">{notices_value}</script>',
    )
    unresolved = [
        marker for marker in REQUIRED_TEMPLATE_MARKERS if marker in document
    ]
    if unresolved or "data-inline" in document or re.search(r"{{[^{}]+}}", document):
        raise BuildError("Generated HTML still contains unresolved template markers.")
    return document


class StandaloneHTMLInspector(HTMLParser):
    """Collect references from real HTML and CSS, not inert script data."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[tuple[str, str]] = []
        self.css_chunks: list[str] = []
        self.style_depth = 0

    def inspect_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if normalized_tag == "style":
            self.style_depth += 1
        for attribute, value in attrs:
            if value is None:
                continue
            normalized_attribute = attribute.casefold()
            if normalized_attribute in {"src", "href", "poster", "data"}:
                self.references.append(
                    (f"<{normalized_tag}> {normalized_attribute}", value.strip())
                )
            elif normalized_attribute == "style":
                self.css_chunks.append(value)

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.inspect_tag(tag, attrs)

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.inspect_tag(tag, attrs)
        if tag.casefold() == "style":
            self.style_depth = max(0, self.style_depth - 1)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "style":
            self.style_depth = max(0, self.style_depth - 1)

    def handle_data(self, data: str) -> None:
        if self.style_depth:
            self.css_chunks.append(data)


def strip_css_comments(css: str) -> str:
    return re.sub(r"/\*[\s\S]*?\*/", "", css)


def css_references(css: str) -> list[tuple[str, str]]:
    clean = strip_css_comments(css)
    references: list[tuple[str, str]] = []
    for match in re.finditer(
        r"\burl\(\s*(?:(['\"])(.*?)\1|([^)'\"\s][^)]*?))\s*\)",
        clean,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        references.append(("CSS url()", (match.group(2) or match.group(3) or "").strip()))
    # Quoted @imports without url() are not found by the expression above.
    for match in re.finditer(
        r"@import\s+(['\"])(.*?)\1",
        clean,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        references.append(("CSS @import", match.group(2).strip()))
    return references


def is_inline_reference(target: str) -> bool:
    return not target or target.startswith(("#", "data:"))


def verify_standalone(document: str) -> None:
    inspector = StandaloneHTMLInspector()
    try:
        inspector.feed(document)
        inspector.close()
    except Exception as exc:
        raise BuildError(f"Could not inspect generated standalone HTML: {exc}") from exc

    references = list(inspector.references)
    for css in inspector.css_chunks:
        references.extend(css_references(css))
    external = sorted(
        {(kind, target) for kind, target in references if not is_inline_reference(target)}
    )
    if external:
        details = ", ".join(f"{kind}={target!r}" for kind, target in external)
        raise BuildError(
            "Standalone HTML contains external or unresolved asset references: "
            + details
        )
    if "data:font/woff2;base64," not in document:
        raise BuildError("Standalone HTML does not contain the inline notation font.")


def content_fingerprint(items: Iterable[tuple[str, bytes]]) -> str:
    digest = hashlib.sha256()
    for name, value in sorted(items, key=lambda item: item[0]):
        label = name.encode("utf-8")
        digest.update(len(label).to_bytes(8, "big"))
        digest.update(label)
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    return digest.hexdigest()[:16]


def build(args: argparse.Namespace) -> dict[str, Any]:
    source = args.score.expanduser().resolve()
    if not source.is_file():
        raise BuildError(f"Input score does not exist: {source}")
    suffix = source.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        allowed = ", ".join(sorted(SUPPORTED_SUFFIXES))
        raise BuildError(f"Unsupported score type {suffix!r}; expected {allowed}.")

    try:
        source_bytes = source.read_bytes()
    except OSError as exc:
        raise BuildError(f"Could not snapshot input score {source}: {exc}") from exc
    source_sha256 = sha256(source_bytes)

    config_input = args.config.expanduser().resolve() if args.config else None
    override = load_config(config_input)

    # For naming an as-yet-unexported MuseScore project, the filename is a
    # stable preliminary fallback.  The final default slug is based on the
    # score's actual title after export.
    preliminary_slug = slugify(source.stem)
    provisional_project = (
        args.project_dir.expanduser().resolve()
        if args.project_dir
        else source.parent / f"{preliminary_slug}-practice-web"
    )
    validate_project_path(provisional_project)
    if args.project_dir:
        validate_project_ownership(provisional_project)

    cached_score = None
    if suffix in MUSESCORE_SUFFIXES and not args.refresh_score:
        cached_score = load_cached_musicxml(provisional_project, source_sha256)

    if cached_score is not None:
        normalized_xml, breaks_removed = cached_score
        score_conversion = "verified-cache"
    else:
        export_temp_parent = (
            Path("/private/tmp")
            if sys.platform == "darwin" and Path("/private/tmp").is_dir()
            else None
        )
        with tempfile.TemporaryDirectory(
            prefix="choir-score-export-", dir=export_temp_parent
        ) as temporary_dir_name:
            temporary_dir = Path(temporary_dir_name)
            if suffix in MUSESCORE_SUFFIXES:
                snapshot_source = temporary_dir / source.name
                atomic_write(snapshot_source, source_bytes)
                exported = temporary_dir / "score.musicxml"
                export_with_musescore(
                    snapshot_source, exported, provisional_project,
                    musescore=getattr(args, "musescore", None),
                )
                raw_xml = exported.read_bytes()
                score_conversion = "musescore-export"
            else:
                raw_xml = source_bytes
                score_conversion = "direct-musicxml"
            normalized_xml, breaks_removed = normalize_musicxml(raw_xml, source)

    normalized_xml, syllable_hyphens_added = hyphenate_lyric_syllables(normalized_xml)
    normalized_xml, repeated_lyrics_marked = annotate_repeated_lyrics(normalized_xml)

    inferred = score_metadata(
        normalized_xml,
        fallback_title=normalized_words(re.sub(r"[-_]+", " ", source.stem)),
    )
    config = effective_config(inferred, override)

    if args.project_dir:
        project_dir = provisional_project
    else:
        project_dir = source.parent / f"{config['slug']}-practice-web"
    validate_project_ownership(project_dir)

    output = (
        args.output.expanduser().resolve()
        if args.output
        else project_dir / "dist" / "index.html"
    )
    validate_output_path(
        output,
        project_dir=project_dir,
        source=source,
        config_path=config_input,
    )

    project_dir.parent.mkdir(parents=True, exist_ok=True)
    staged_project = Path(
        tempfile.mkdtemp(
            prefix=f".{project_dir.name}.stage-", dir=project_dir.parent
        )
    )
    staged_external: Path | None = None
    try:
        copy_builder_sources(staged_project)
        assets = staged_project / "assets"
        source_archive = assets / "source" / source.name
        atomic_write(source_archive, source_bytes)

        score_path = assets / "score.musicxml"
        playback_path = assets / "playback.json"
        extractor_metadata_path = assets / "score-metadata.json"
        config_path = assets / "trainer-config.json"
        build_metadata_path = assets / "build-metadata.json"
        atomic_write(score_path, normalized_xml)
        atomic_write(config_path, stable_json(config, pretty=True))

        run_extractor(score_path, playback_path, extractor_metadata_path)
        playback = read_json_object(playback_path, "playback data")
        extracted = read_json_object(extractor_metadata_path, "score metadata")

        template = read_required(TEMPLATE_DIR / "index.html")
        styles = read_required(TEMPLATE_DIR / "styles.css")
        app = read_required(TEMPLATE_DIR / "app.js")
        melete_license = read_required(ROOT / "LICENSE")
        alphatab = read_required(VENDOR_DIR / "alphatab" / "alphaTab.min.js")
        fft_source = read_required(VENDOR_DIR / "fft" / "fft.js")
        pitchy_source = read_required(VENDOR_DIR / "pitchy" / "index.js")
        pitchy_license = read_required(VENDOR_DIR / "pitchy" / "LICENSE")
        fft_license = read_required(VENDOR_DIR / "fft" / "LICENSE")
        alpha_license = read_required(VENDOR_DIR / "alphatab" / "LICENSE")
        font = read_required(
            VENDOR_DIR / "alphatab" / "font" / "Bravura.woff2", binary=True
        )
        font_license = read_required(
            VENDOR_DIR / "alphatab" / "font" / "Bravura-OFL.txt"
        )
        lucide_license = read_required(VENDOR_DIR / "lucide" / "LICENSE")
        assert isinstance(template, str)
        assert isinstance(styles, str)
        assert isinstance(app, str)
        assert isinstance(melete_license, str)
        assert isinstance(alphatab, str)
        assert isinstance(fft_source, str)
        assert isinstance(pitchy_source, str)
        assert isinstance(pitchy_license, str)
        assert isinstance(fft_license, str)
        assert isinstance(alpha_license, str)
        assert isinstance(font, bytes)
        assert isinstance(font_license, str)
        assert isinstance(lucide_license, str)
        app, template, styles = install_compact_lyrics(app, template, styles)
        app = install_system_annotations(app)
        app = read_required(TEMPLATE_DIR / "loop_recorder.js") + "\n" + app
        atomic_write(staged_project / "app.js", app)
        atomic_write(staged_project / "styles.css", styles)
        pitchy = pitchy_browser_runtime(fft_source, pitchy_source)
        verify_pitchy_runtime(pitchy)

        playback_bytes = stable_json(playback).encode("utf-8")
        extracted_bytes = stable_json(extracted).encode("utf-8")
        config_bytes = stable_json(config).encode("utf-8")
        fingerprint = content_fingerprint(
            (
                ("builder-version", BUILDER_VERSION.encode("ascii")),
                ("template", template.encode("utf-8")),
                ("styles", styles.encode("utf-8")),
                ("app", app.encode("utf-8")),
                ("melete-license", melete_license.encode("utf-8")),
                ("alphatab", alphatab.encode("utf-8")),
                ("alphatab-license", alpha_license.encode("utf-8")),
                ("pitchy-runtime", pitchy.encode("utf-8")),
                ("pitchy-license", pitchy_license.encode("utf-8")),
                ("fft-license", fft_license.encode("utf-8")),
                ("bravura-font", font),
                ("bravura-license", font_license.encode("utf-8")),
                ("lucide-license", lucide_license.encode("utf-8")),
                ("score", normalized_xml.encode("utf-8")),
                ("playback", playback_bytes),
                ("score-metadata", extracted_bytes),
                ("config", config_bytes),
            )
        )

        metadata = dict(extracted)
        metadata.update(
            {
                "schemaVersion": 1,
                "title": config["title"],
                "composer": config["composer"],
                "slug": config["slug"],
                "favicon": config["favicon"],
                "layoutBreaksRemoved": breaks_removed,
                "repeatedLyricsMarked": repeated_lyrics_marked,
                "build": {
                    "builder": "choir-practice-builder",
                    "builderVersion": BUILDER_VERSION,
                    "fingerprint": fingerprint,
                    "source": {
                        "name": source.name,
                        "format": suffix.removeprefix("."),
                        "sha256": source_sha256,
                    },
                    "normalizedScoreSha256": sha256(normalized_xml.encode("utf-8")),
                    "playbackSha256": sha256(playback_bytes),
                },
            }
        )
        atomic_write(build_metadata_path, stable_json(metadata, pretty=True))

        notices = third_party_notices(
            melete_license,
            alpha_license,
            font_license,
            lucide_license,
            pitchy_license,
            fft_license,
        )
        standalone = render_document(
            template=template,
            styles=styles,
            app=app,
            alphatab=alphatab,
            pitchy=pitchy,
            font=font,
            score_xml=normalized_xml,
            playback=playback,
            config=config,
            metadata=metadata,
            notices=notices,
            fingerprint=fingerprint,
            standalone=True,
        )
        verify_standalone(standalone)
        development = render_document(
            template=template,
            styles=styles,
            app=app,
            alphatab=alphatab,
            pitchy=pitchy,
            font=font,
            score_xml=normalized_xml,
            playback=playback,
            config=config,
            metadata=metadata,
            notices=notices,
            fingerprint=fingerprint,
            standalone=False,
        )
        atomic_write(staged_project / "index.html", development)
        atomic_write(staged_project / PROJECT_MARKER_NAME, project_marker(fingerprint))
        # The development UI's Download action always targets this canonical
        # local artifact, even when an additional standalone destination was
        # requested outside the generated project.
        atomic_write(staged_project / "dist" / "index.html", standalone)

        if path_is_within(output, project_dir):
            staged_output = staged_project / output.relative_to(project_dir)
            if staged_output != staged_project / "dist" / "index.html":
                atomic_write(staged_output, standalone)
            external_output = None
        else:
            staged_external = stage_external_output(output, standalone)
            external_output = output

        commit_generated_outputs(
            staged_project=staged_project,
            project_dir=project_dir,
            staged_external=staged_external,
            external_output=external_output,
        )
    finally:
        if staged_external is not None and staged_external.exists():
            staged_external.unlink(missing_ok=True)
        if staged_project.exists():
            shutil.rmtree(staged_project, ignore_errors=True)

    return {
        "title": config["title"],
        "composer": config["composer"],
        "slug": config["slug"],
        "parts": extracted.get("parts", inferred["partNames"]),
        "measures": extracted.get("measureCount", inferred["measureCount"]),
        "layoutBreaksRemoved": breaks_removed,
        "repeatedLyricsMarked": repeated_lyrics_marked,
        "scoreConversion": score_conversion,
        "projectDir": str(project_dir),
        "output": str(output),
        "bytes": output.stat().st_size,
        "fingerprint": fingerprint,
    }


def main(argv: list[str] | None = None) -> int:
    try:
        result = build(parse_args(argv))
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(stable_json(result, pretty=True), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
