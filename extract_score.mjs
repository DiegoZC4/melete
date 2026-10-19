#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const alphaTabPath = path.join(
  scriptDirectory,
  "vendor",
  "alphatab",
  "alphaTab.min.js",
);

function usage() {
  return [
    "Usage:",
    "  node extract_score.mjs --score <musicxml> --playback <json> --metadata <json>",
  ].join("\n");
}

function parseArguments(argv) {
  const result = {};
  const known = new Set(["score", "playback", "metadata"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}\n${usage()}`);
    }

    const key = argument.slice(2);
    if (!known.has(key)) {
      throw new Error(`Unknown option: ${argument}\n${usage()}`);
    }
    if (Object.hasOwn(result, key)) {
      throw new Error(`Option supplied more than once: ${argument}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}\n${usage()}`);
    }
    result[key] = path.resolve(value);
    index += 1;
  }

  for (const key of known) {
    if (!result[key]) {
      throw new Error(`Missing required option: --${key}\n${usage()}`);
    }
  }
  if (result.playback === result.metadata) {
    throw new Error("--playback and --metadata must name different files.");
  }
  if (result.score === result.playback || result.score === result.metadata) {
    throw new Error("Output files must not overwrite the source score.");
  }

  return result;
}

function decodeXmlEntities(value) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["quot", '"'],
    ["nbsp", " "],
  ]);

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][\w.-]*));/giu,
    (entity, decimal, hexadecimal, name) => {
      if (decimal) {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return named.get(name.toLowerCase()) ?? entity;
    },
  );
}

function plainText(value) {
  if (value === null || value === undefined) return "";
  return decodeXmlEntities(String(value))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function xmlAttribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu"),
  );
  return plainText(match?.[1] ?? match?.[2] ?? "");
}

function extractXmlMetadata(xml) {
  const creators = [];
  const seenCreators = new Set();

  for (const match of xml.matchAll(
    /<creator\b([^>]*)>([\s\S]*?)<\/creator>/giu,
  )) {
    const name = plainText(match[2]);
    if (!name) continue;
    const type = xmlAttribute(match[1], "type") || "creator";
    const key = `${type.toLocaleLowerCase()}:${name.toLocaleLowerCase()}`;
    if (seenCreators.has(key)) continue;
    seenCreators.add(key);
    creators.push({ type, name });
  }

  const extractFirst = (element) => {
    const match = xml.match(
      new RegExp(`<${element}\\b[^>]*>([\\s\\S]*?)<\\/${element}>`, "iu"),
    );
    return plainText(match?.[1] ?? "");
  };

  return {
    title: extractFirst("work-title") || extractFirst("movement-title"),
    creators,
  };
}

function addCreator(creators, type, value) {
  const name = plainText(value);
  if (!name) return;
  const duplicate = creators.some(
    (creator) =>
      creator.type.toLocaleLowerCase() === type.toLocaleLowerCase() &&
      creator.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (!duplicate) creators.push({ type, name });
}

function initialism(value) {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toLocaleUpperCase()
    .slice(0, 4);
}

function preferredPartShortName(name, importedShortName) {
  const normalizedName = plainText(name);
  const nameMatch = normalizedName.match(
    /^(soprano|mezzo(?:[- ]soprano)?|alto|countertenor|tenor|baritone|bass)(?:\s*(\d+))?$/iu,
  );
  if (nameMatch) {
    const canonical = new Map([
      ["soprano", "S"],
      ["mezzo", "M"],
      ["mezzo-soprano", "M"],
      ["mezzo soprano", "M"],
      ["alto", "A"],
      ["countertenor", "CT"],
      ["tenor", "T"],
      ["baritone", "Br"],
      ["bass", "B"],
    ]);
    return `${canonical.get(nameMatch[1].toLocaleLowerCase())}${nameMatch[2] || ""}`;
  }

  const imported = plainText(importedShortName)
    .replace(/[.\s]+/gu, "")
    .slice(0, 5);
  if (imported) return imported;

  return initialism(normalizedName) || "Part";
}

function buildParts(score, warnings) {
  const parts = score.tracks.map((track, index) => {
    const importedName = plainText(track.name);
    const name = importedName || `Part ${index + 1}`;
    if (!importedName) {
      warnings.push(`Track ${index + 1} had no name; using “${name}”.`);
    }
    return {
      index,
      name,
      short: preferredPartShortName(name, track.shortName),
    };
  });

  const used = new Set();
  for (const part of parts) {
    const base = part.short;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase())) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    part.short = candidate;
    used.add(candidate.toLocaleLowerCase());
  }
  return parts;
}

function navigationProblems(score, xml) {
  const problems = [];
  const add = (problem) => {
    if (!problems.includes(problem)) problems.push(problem);
  };

  for (const bar of score.masterBars) {
    const measure = bar.index + 1;
    if (bar.isRepeatStart) add(`repeat start at measure ${measure}`);
    if (Number(bar.repeatCount) > 0) {
      add(`repeat end at measure ${measure}`);
    }
    if (Number(bar.alternateEndings) > 0) {
      add(`alternate ending at measure ${measure}`);
    }
    if (bar.directions && bar.directions.size > 0) {
      const labels = [...bar.directions]
        .map((direction) => alphaTab.model.Direction[direction] ?? direction)
        .join(", ");
      add(`playback direction at measure ${measure}${labels ? ` (${labels})` : ""}`);
    }
  }

  // Raw XML checks cover constructs an importer might not expose, but markup
  // examples inside comments or CDATA are inert and must not reject a score.
  const uncommentedXml = xml.replace(/<!--[\s\S]*?-->/gu, "");
  const structuralXml = uncommentedXml.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>/gu,
    "",
  );

  if (/<repeat\b/iu.test(structuralXml)) add("a MusicXML repeat marker");
  if (/<ending\b/iu.test(structuralXml)) add("a MusicXML alternate ending");
  if (
    /<sound\b[^>]*\b(?:dacapo|dalsegno|tocoda|fine)\s*=/iu.test(structuralXml) ||
    /<(?:segno|coda)\b/iu.test(structuralXml)
  ) {
    add("a MusicXML jump or navigation target");
  }

  for (const match of uncommentedXml.matchAll(
    /<words\b[^>]*>([\s\S]*?)<\/words>/giu,
  )) {
    const words = plainText(match[1]);
    if (
      /(?:\bD\.?\s*[CS]\.?(?:\s+al\s+(?:coda|fine))?\b|\bda\s+capo\b|\bdal\s+segno\b|\bto\s+coda\b)/iu.test(
        words,
      )
    ) {
      add(`the navigation text “${words}”`);
    }
  }

  return problems;
}

function buildMeasures(score) {
  return score.masterBars.map((bar) => {
    const start = Math.round(bar.start);
    const duration = Math.round(bar.calculateDuration());
    const numerator = Math.round(bar.timeSignatureNumerator);
    const denominator = Math.round(bar.timeSignatureDenominator);
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(numerator) ||
      numerator <= 0 ||
      !Number.isFinite(denominator) ||
      denominator <= 0
    ) {
      throw new Error(`Invalid timing data in measure ${bar.index + 1}.`);
    }
    return [start, duration, numerator, denominator];
  });
}

function rehearsalChaptersFromXml(xml, measures) {
  const firstPart = xml.match(
    /<part(?:\s[^>]*)?>([\s\S]*?)<\/part>/iu,
  )?.[1];
  if (!firstPart) return [];

  const chapters = [];
  let measureIndex = 0;
  for (const measureMatch of firstPart.matchAll(
    /<measure\b[^>]*>([\s\S]*?)<\/measure>/giu,
  )) {
    if (measureIndex >= measures.length) break;
    const rehearsal = measureMatch[1].match(
      /<rehearsal\b[^>]*>([\s\S]*?)<\/rehearsal>/iu,
    );
    const label = plainText(rehearsal?.[1] ?? "");
    if (label) {
      chapters.push({
        tick: measures[measureIndex][0],
        measure: measureIndex + 1,
        label,
      });
    }
    measureIndex += 1;
  }
  return chapters;
}

function buildChapters(score, xml, measures) {
  const chapters = new Map();

  for (const bar of score.masterBars) {
    const label = plainText(bar.section?.text || bar.section?.marker);
    if (!label) continue;
    chapters.set(Math.round(bar.start), {
      tick: Math.round(bar.start),
      measure: bar.index + 1,
      label,
    });
  }
  for (const chapter of rehearsalChaptersFromXml(xml, measures)) {
    if (!chapters.has(chapter.tick)) chapters.set(chapter.tick, chapter);
  }
  if (!chapters.has(0)) {
    chapters.set(0, { tick: 0, measure: 1, label: "Start" });
  }

  return [...chapters.values()].sort(
    (left, right) => left.tick - right.tick || left.measure - right.measure,
  );
}

function buildLyrics(score) {
  const lyrics = [];
  const seen = new Set();

  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            const tick = Math.round(beat.absolutePlaybackStart);
            if (!Number.isFinite(tick) || tick < 0) continue;
            for (let verse = 0; verse < (beat.lyrics?.length || 0); verse += 1) {
              const text = plainText(beat.lyrics[verse]);
              if (!text) continue;
              const key = `${track.index}\u0000${tick}\u0000${verse}\u0000${text}`;
              if (seen.has(key)) continue;
              seen.add(key);
              lyrics.push([track.index, tick, verse, text]);
            }
          }
        }
      }
    }
  }

  lyrics.sort(
    (left, right) =>
      left[1] - right[1] ||
      left[0] - right[0] ||
      left[2] - right[2] ||
      left[3].localeCompare(right[3]),
  );
  return lyrics;
}

function eventNoteKey(event) {
  return `${event.track}:${event.channel}:${event.noteKey}`;
}

function buildMidiPlayback(score, settings, partCount, warnings) {
  const midiFile = new alphaTab.midi.MidiFile();
  const midiHandler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile);
  new alphaTab.midi.MidiFileGenerator(score, settings, midiHandler).generate();

  const openNotes = new Map();
  const notes = [];
  const tempoAtTick = new Map();
  let lastEventTick = 0;

  const closeNote = (event, tick) => {
    const identity = eventNoteKey(event);
    const queue = openNotes.get(identity);
    const start = queue?.shift();
    if (!start) {
      throw new Error(
        `Unmatched MIDI note-off for track ${event.track}, channel ${event.channel}, key ${event.noteKey} at tick ${tick}.`,
      );
    }
    if (tick <= start.tick) {
      throw new Error(
        `Non-positive MIDI note duration for track ${start.track}, key ${start.key} at tick ${start.tick}.`,
      );
    }
    notes.push([
      start.track,
      start.tick,
      tick,
      start.key,
      start.velocity,
    ]);
    if (!queue.length) openNotes.delete(identity);
  };

  for (const event of midiFile.events) {
    const tick = Math.round(event.tick);
    if (!Number.isFinite(tick) || tick < 0) {
      throw new Error("AlphaTab generated an event with an invalid tick.");
    }
    lastEventTick = Math.max(lastEventTick, tick);

    if (
      event instanceof alphaTab.midi.NoteOnEvent &&
      Number(event.noteVelocity) === 0
    ) {
      closeNote(event, tick);
    } else if (event instanceof alphaTab.midi.NoteOnEvent) {
      const track = Math.round(event.track);
      const channel = Math.round(event.channel);
      const key = Math.round(event.noteKey);
      const velocity = Math.round(event.noteVelocity);
      if (track < 0 || track >= partCount) {
        throw new Error(`Note-on event refers to unknown track ${track}.`);
      }
      if (key < 0 || key > 127 || velocity < 0 || velocity > 127) {
        throw new Error(`Invalid MIDI note-on event at tick ${tick}.`);
      }

      const identity = eventNoteKey(event);
      const queue = openNotes.get(identity) || [];
      queue.push({ track, channel, tick, key, velocity });
      openNotes.set(identity, queue);
    } else if (event instanceof alphaTab.midi.NoteOffEvent) {
      closeNote(event, tick);
    } else if (event instanceof alphaTab.midi.TempoChangeEvent) {
      const bpm = Number(event.beatsPerMinute);
      if (!Number.isFinite(bpm) || bpm <= 0) {
        throw new Error(`Invalid tempo event at tick ${tick}.`);
      }
      tempoAtTick.set(tick, bpm);
    }
  }

  if (openNotes.size) {
    const unmatched = [...openNotes.values()].reduce(
      (count, queue) => count + queue.length,
      0,
    );
    throw new Error(`${unmatched} MIDI note-on event(s) have no matching note-off.`);
  }

  notes.sort(
    (left, right) =>
      left[1] - right[1] ||
      left[0] - right[0] ||
      left[3] - right[3] ||
      left[2] - right[2],
  );

  if (!tempoAtTick.size) {
    const fallbackTempo = Number(score.tempo);
    tempoAtTick.set(0, Number.isFinite(fallbackTempo) && fallbackTempo > 0 ? fallbackTempo : 120);
    warnings.push("The score had no MIDI tempo event; a fallback tempo was inserted.");
  } else if (!tempoAtTick.has(0)) {
    const firstTempo = [...tempoAtTick.entries()].sort(
      (left, right) => left[0] - right[0],
    )[0][1];
    tempoAtTick.set(0, firstTempo);
    warnings.push("The first tempo event occurred after tick 0; its tempo was copied to the start.");
  }

  return {
    division: Math.round(midiFile.division),
    notes,
    tempos: [...tempoAtTick.entries()].sort((left, right) => left[0] - right[0]),
    lastEventTick,
  };
}

function countNotesByTrack(notes, partCount) {
  const counts = Array.from({ length: partCount }, () => 0);
  for (const note of notes) counts[note[0]] += 1;
  return counts;
}

function buildLegato(score, notes, warnings) {
  const atOnset = new Map();
  notes.forEach(([track, start, , key], index) => {
    const identity = `${track}:${start}:${key}`;
    const matches = atOnset.get(identity) || [];
    matches.push(index);
    atOnset.set(identity, matches);
  });
  const eventFor = (note, track) => {
    // MIDI already folds ties into one event. A slur can start/end on its continuation.
    while (note.isTieDestination && note.tieOrigin) note = note.tieOrigin;
    const matches = atOnset.get(`${track}:${Math.round(note.beat.absolutePlaybackStart)}:${note.realValue}`);
    return matches?.length === 1 ? matches[0] : null;
  };
  const successors = new Map();
  const predecessors = new Map();
  const link = (from, to) => {
    if (from === null || to === null || from === to) return;
    if (notes[from][2] !== notes[to][1]) return; // Never bridge a rest or detached articulation.
    if (!successors.has(from)) successors.set(from, new Set());
    if (!predecessors.has(to)) predecessors.set(to, new Set());
    successors.get(from).add(to);
    predecessors.get(to).add(from);
  };
  let unmapped = 0;
  for (const track of score.tracks) for (const staff of track.staves) {
    if (staff.isPercussion) continue;
    const voices = new Map();
    for (const bar of staff.bars) for (const voice of bar.voices) {
      if (!voices.has(voice.index)) voices.set(voice.index, []);
      voices.get(voice.index).push(...voice.beats);
    }
    for (const beats of voices.values()) {
      const beatIndices = new Map(beats.map((beat, index) => [beat, index]));
      for (let start = 0; start < beats.length; start += 1) {
        const destinations = new Set(beats[start].notes.map(note => note.slurDestination?.beat).filter(Boolean));
        for (const destination of destinations) {
          const end = beatIndices.get(destination);
          if (end === undefined || end <= start) { unmapped += 1; continue; }
          for (let index = start; index < end; index += 1) {
            const left = [...beats[index].notes].sort((a, b) => a.realValue - b.realValue);
            const right = [...beats[index + 1].notes].sort((a, b) => a.realValue - b.realValue);
            // Match parallel chord tones only within this written voice, never another divisi voice.
            if (!left.length || !right.length) continue;
            if (left.length !== right.length) { unmapped += 1; continue; }
            left.forEach((note, rank) => {
              const from = eventFor(note, track.index), to = eventFor(right[rank], track.index);
              if (from === null || to === null) unmapped += 1;
              else link(from, to);
            });
          }
        }
      }
    }
  }
  const next = new Map(), previous = new Map();
  for (const [from, targets] of successors) {
    if (targets.size !== 1) continue;
    const to = [...targets][0];
    if (predecessors.get(to).size !== 1) continue;
    next.set(from, to);
    previous.set(to, from);
  }
  const chains = [];
  for (const start of next.keys()) {
    if (previous.has(start)) continue;
    const chain = [start];
    while (next.has(chain.at(-1))) chain.push(next.get(chain.at(-1)));
    chains.push(chain);
  }
  if (unmapped) warnings.push(`${unmapped} slur transition(s) could not be mapped unambiguously; left articulated.`);
  return chains.sort((a, b) => a[0] - b[0]);
}

async function writeJson(destination, data) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const options = parseArguments(process.argv.slice(2));
const scoreBytes = await readFile(options.score);
const xml = scoreBytes.toString("utf8");
if (!/<score-(?:partwise|timewise)\b/iu.test(xml)) {
  throw new Error(`${options.score} does not appear to be a MusicXML score.`);
}

const alphaTab = require(alphaTabPath);
const settings = new alphaTab.Settings();
settings.importer.mergePartGroupsInMusicXml = false;

let score;
try {
  score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(scoreBytes),
    settings,
  );
} catch (error) {
  throw new Error(`AlphaTab could not parse ${options.score}: ${error.message}`, {
    cause: error,
  });
}

if (!score.tracks.length) throw new Error("The score contains no tracks.");
if (!score.masterBars.length) throw new Error("The score contains no measures.");

const problems = navigationProblems(score, xml);
if (problems.length) {
  throw new Error(
    `The score uses playback navigation that this linear trainer cannot map reliably: ${problems.join(
      "; ",
    )}. Expand repeats and jumps in MuseScore before building the trainer.`,
  );
}

const warnings = [];
const parts = buildParts(score, warnings);
const measures = buildMeasures(score);
const chapters = buildChapters(score, xml, measures);
const lyrics = buildLyrics(score);
const midi = buildMidiPlayback(score, settings, parts.length, warnings);

if (!midi.notes.length) throw new Error("The score generated no playable notes.");
if (!Number.isFinite(midi.division) || midi.division <= 0) {
  throw new Error("AlphaTab generated an invalid MIDI division.");
}

const finalMeasureEnd = measures.reduce(
  (latest, measure) => Math.max(latest, measure[0] + measure[1]),
  0,
);
const finalNoteEnd = midi.notes.reduce(
  (latest, note) => Math.max(latest, note[2]),
  0,
);
const endTick = Math.max(finalMeasureEnd, finalNoteEnd, midi.lastEventTick);
const notesByTrack = countNotesByTrack(midi.notes, parts.length);
for (const part of parts) {
  if (notesByTrack[part.index] === 0) {
    warnings.push(`“${part.name}” contains no playable notes.`);
  }
}

const playback = {
  version: 1,
  division: midi.division,
  endTick,
  parts,
  tempos: midi.tempos,
  measures,
  notes: midi.notes,
  legato: buildLegato(score, midi.notes, warnings),
  chapters,
  lyrics,
};

const xmlMetadata = extractXmlMetadata(xml);
const creators = [...xmlMetadata.creators];
addCreator(creators, "music", score.music);
addCreator(creators, "lyrics", score.words);
addCreator(creators, "artist", score.artist);
const composer =
  creators.find((creator) =>
    /^(?:composer|music|music by)$/iu.test(creator.type),
  )?.name || "";
const title =
  plainText(score.title) ||
  xmlMetadata.title ||
  path.basename(options.score).replace(/\.(?:musicxml|xml)$/iu, "");
const fingerprint = createHash("sha256").update(scoreBytes).digest("hex");
const metadata = {
  version: 1,
  title,
  creators,
  composer,
  trackCount: parts.length,
  measureCount: measures.length,
  noteCount: midi.notes.length,
  counts: {
    tracks: parts.length,
    measures: measures.length,
    notes: midi.notes.length,
    legato: playback.legato.length,
    lyrics: lyrics.length,
    chapters: chapters.length,
    tempos: midi.tempos.length,
  },
  fingerprint,
  fingerprintAlgorithm: "sha256",
  sourceFile: path.basename(options.score),
  warnings,
};

await Promise.all([
  writeJson(options.playback, playback),
  writeJson(options.metadata, metadata),
]);

process.stdout.write(
  `${JSON.stringify({
    score: options.score,
    playback: options.playback,
    metadata: options.metadata,
    title,
    tracks: parts.length,
    measures: measures.length,
    notes: midi.notes.length,
    lyrics: lyrics.length,
    chapters: chapters.length,
    endTick,
    fingerprint,
    warnings,
  })}\n`,
);
