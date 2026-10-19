/* Display-only grouping: the imported score and audio events remain untouched. */
const sharedNotationTools = (() => {
  const normalize = (text) => text.replace(/[\u2018\u2019]/g, "'").trim();

  function annotationPreferences(stored = {}) {
    // Explicit viewport choices win over the former repetition-only setting.
    const legacyCompact = stored?.lyrics === "changes";
    return {
      desktop: ["part", "shared"].includes(stored?.annotationLayouts?.desktop)
        ? stored.annotationLayouts.desktop : legacyCompact ? "shared" : "part",
      mobile: stored?.annotationLayouts?.mobile === "part" ? "part" : "shared",
    };
  }

  function repeatedLyrics(lyrics, minimum = 2) {
    const hidden = new Set(), runs = new Map();
    const finish = (run) => {
      if (run?.length >= minimum) run.slice(1).forEach((lyric) => hidden.add(lyric));
    };
    for (const lyric of lyrics) {
      const text = String(lyric[3] || "").trim().replace(/\s+/gu, " ");
      if (!text) continue;
      const key = `${lyric[0]}:${lyric[2]}`;
      const run = runs.get(key);
      if (run?.text === text) run.push(lyric);
      else {
        finish(run);
        const next = [lyric];
        next.text = text;
        runs.set(key, next);
      }
    }
    runs.forEach(finish);
    return hidden;
  }

  function ownerSegments(owners, parts) {
    const indices = [...new Set(owners)].sort((a, b) => a - b);
    const segments = [];
    const addPart = part => segments.push({ part, text: parts[part].short || parts[part].name[0] });
    for (let i = 0; i < indices.length; i++) {
      const first = indices[i];
      let last = first;
      while (indices[i + 1] === last + 1) last = indices[++i];
      if (segments.length) segments.push({ part: null, text: ", " });
      addPart(first);
      if (last !== first) {
        segments.push({ part: null, text: "\u2013" });
        addPart(last);
      }
    }
    return segments;
  }

  function lyricEnd(beat) {
    let end = beat.absolutePlaybackStart + beat.playbackDuration;
    let next = beat.nextBeat;
    const seen = new Set([beat]);
    while (next && !seen.has(next) && !next.isRest && !next.isEmpty
      && !next.lyrics?.some((text) => text?.trim())) {
      seen.add(next);
      end = Math.max(end, next.absolutePlaybackStart + next.playbackDuration);
      next = next.nextBeat;
    }
    return end;
  }

  function plan(events, visible, leadRanges) {
    const hidden = new Set();
    const rows = { melody: [], backing: [] };
    if (visible.size < 2) return { hidden, rows };
    const groups = new Map();
    for (const event of events) {
      if (!visible.has(event.part)) continue;
      const key = JSON.stringify([event.bar, event.tick, event.end, normalize(event.text)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    for (const members of groups.values()) {
      const event = members[0];
      const lead = leadRanges.find((range) => range.start <= event.tick && event.tick < range.end)
        ?.parts.find((part) => visible.has(part));
      const isMelody = members.some((member) => member.part === lead);
      const owners = [...new Set(members.map((member) => member.part))].sort((a, b) => a - b);
      if (!isMelody && owners.length < 2) continue;
      const anchor = members.find((member) => member.part === lead) || event;
      rows[isMelody ? "melody" : "backing"].push({ ...anchor, owners, members });
      members.forEach((member) => hidden.add(member.beat));
    }
    for (const [name, row] of Object.entries(rows)) {
      // Independent simultaneous words need their own staves, not one shared lane.
      rows[name] = row.filter((event) => {
        if (!row.some((other) => other !== event && other.tick === event.tick)) return true;
        event.members.forEach((member) => hidden.delete(member.beat));
        return false;
      }).sort((a, b) => a.tick - b.tick);
    }
    return { hidden, rows };
  }

  function dynamics(events, visible, leadRanges) {
    const groups = new Map();
    for (const event of events) {
      if (!visible.has(event.part)) continue;
      const key = `${event.tick}:${event.value}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    return [...groups.values()].map((members) => {
      const event = members[0];
      const owners = [...new Set(members.map((member) => member.part))].sort((a, b) => a - b);
      const lead = leadRanges.find((range) => range.start <= event.tick && event.tick < range.end)
        ?.parts.find((part) => visible.has(part));
      return { ...event, owners, members, row: owners.includes(lead) ? "melody" : "backing" };
    });
  }

  function compactSpacing(springs, lyricRows = [], tailWidth = 0) {
    if (!springs.length) return null;
    const index = new Map(springs.map((spring, i) => [spring.timePosition, i]));
    let head = springs[0].preSpringWidth;
    const minimum = springs.map((spring, i) => spring.postSpringWidth
      + (springs[i + 1]?.preSpringWidth || 0) + 3);
    minimum[minimum.length - 1] += tailWidth;
    const elastic = springs.map((spring, i) => Math.max(6, 1 / spring.springConstant - minimum[i]));
    const sum = (values, start = 0, end = values.length) => values.slice(start, end).reduce((a, b) => a + b, 0);
    const reserve = (start, end, required) => {
      if (end <= start) return;
      const missing = required - sum(minimum, start, end);
      if (missing > 0) for (let i = start; i < end; i++) minimum[i] += missing / (end - start);
    };
    for (const row of lyricRows) {
      const words = row.filter(word => index.has(word.tick)).sort((a, b) => a.tick - b.tick);
      for (let i = 0; i < words.length; i++) {
        const word = words[i], at = index.get(word.tick);
        const left = word.left ?? word.width / 2, right = word.right ?? word.width / 2;
        if (at === 0) head = Math.max(head, left + 2);
        else reserve(0, at, left + 2 - head);
        const next = words[i + 1];
        if (next) reserve(at, index.get(next.tick), right + (next.left ?? next.width / 2) + 3);
        reserve(at, springs.length, right + 3 + tailWidth);
      }
    }
    const minimumWidth = head + sum(minimum), elasticWidth = sum(elastic);
    return {
      minimumWidth, elasticWidth,
      width: force => minimumWidth + Math.max(0, force) * elasticWidth,
      force: width => Math.max(0, (width - minimumWidth) / elasticWidth),
      positions(force) {
        let x = head;
        return new Map(springs.map((spring, i) => {
          const pair = [spring.timePosition, x];
          x += minimum[i] + Math.max(0, force) * elastic[i];
          return pair;
        }));
      },
    };
  }

  // Change only the engraver's spacing interface; note glyphs and score data
  // keep their native sizes/timing. Native pre-spring widths already include
  // leading grace rods; trailing grace groups need their fixed tail budget too.
  function installSpacing(factory, rowsForBar) {
    const originalCreate = factory.create;
    const patched = new WeakMap();
    factory.create = function (scoreRenderer, bar) {
      const renderer = originalCreate.call(this, scoreRenderer, bar);
      const originalApply = renderer.applyLayoutingInfo;
      renderer.applyLayoutingInfo = function () {
        const info = this.layoutingInfo;
        if (!patched.has(info)) {
          const original = {
            width: info.calculateVoiceWidth.bind(info),
            force: info.spaceToForce.bind(info),
            positions: info.buildOnTimePositions.bind(info),
          };
          const state = { version: -1, model: null, original };
          patched.set(info, state);
          info.calculateVoiceWidth = force => state.model?.width(force) ?? original.width(force);
          info.spaceToForce = width => state.model?.force(width) ?? original.force(width);
          info.buildOnTimePositions = force => state.model?.positions(force) ?? original.positions(force);
        }
        const state = patched.get(info);
        if (state.version !== info.version) {
          state.version = info.version;
          const springs = [...info.springs.values()].sort((a, b) => a.timePosition - b.timePosition);
          const tail = Math.max(0, state.original.width(0) - (springs[0]?.preSpringWidth || 0));
          state.model = springs.some(spring => !(spring.springConstant > 0))
            ? null : compactSpacing(springs, rowsForBar(this), tail);
        }
        // AlphaTab's bar-wide minimum spring force otherwise reinflates every
        // interval to accommodate the single most crowded interval in the bar.
        if (state.model) info.minStretchForce = 0;
        return originalApply.call(this);
      };
      const scale = renderer.scaleToWidth;
      if (scale) renderer.scaleToWidth = function(width) {
        const model = patched.get(this.layoutingInfo)?.model;
        // A single dense bar may be wider than a phone. Keep its barline and
        // following bars outside the notes, then expose that width for panning.
        return scale.call(this, Math.max(width, model ? this.fixedOverhead + model.minimumWidth : 0));
      };
      return renderer;
    };
  }

  return { normalize, lyricEnd, plan, dynamics, compactSpacing, installSpacing, annotationPreferences, repeatedLyrics, ownerSegments };
})();

if (typeof module === "object" && module.exports) module.exports = sharedNotationTools;

let annotationLayouts = sharedNotationTools.annotationPreferences();
let annotationLayout = "part";
let sharedNotationPlan = null;
let sharedNotationFrame = 0;
let notationLyricRows = new Map();

function sharedNotationActive() {
  return annotationLayout === "shared" && scoreView === "standard" && visibleTracks.size > 1;
}

function prepareSharedNotation() {
  sharedNotationPlan = null;
  notationLyricRows = new Map();
  if (api) api.settings.display.trackStaffPaddingBetween = sharedNotationActive() ? 1 : 5;
  if (!scoreTracks.length) return;
  const lyrics = [], dynamics = [];
  const allLyrics = [];
  scoreTracks.forEach((track, part) => track.staves.forEach((staff) => staff.bars.forEach((bar) => {
    bar.voices.forEach((voice) => voice.beats.forEach((beat) => {
      const tick = beat.absolutePlaybackStart;
      const texts = (beat.lyrics || []).filter((text) => text?.trim());
      (beat.lyrics || []).forEach((text, verse) => {
        if (text?.trim() && visibleTracks.has(part)) allLyrics.push({ part, bar: bar.index,
          tick: beat.absoluteDisplayStart, text, verse, beat });
      });
      // Multiple lyric verses stay local rather than silently losing a verse.
      if (texts.length === 1) lyrics.push({ part, bar: bar.index, tick,
        end: sharedNotationTools.lyricEnd(beat), text: texts[0], beat });
      if (staffDynamicChangesAt(beat)) dynamics.push({ part, bar: bar.index, tick,
        value: typeof writtenDynamicForBeat === "function" ? writtenDynamicForBeat(beat) : beat.dynamics, beat });
    }));
  })));
  if (sharedNotationActive()) {
    const ranges = config.sharedNotation?.leadRanges || [];
    sharedNotationPlan = sharedNotationTools.plan(lyrics, visibleTracks, ranges);
    const groupedDynamics = sharedNotationTools.dynamics(dynamics, visibleTracks, ranges);
    sharedNotationPlan.dynamics = groupedDynamics.filter((event) => !groupedDynamics.some((other) =>
      other !== event && other.tick === event.tick && other.row === event.row)
      && !sharedNotationPlan.rows[event.row].some(lyric => lyric.tick === event.tick
        && !event.owners.every(part => lyric.owners.includes(part))));
    sharedNotationPlan.hiddenDynamics = new Set(sharedNotationPlan.dynamics
      .flatMap((event) => event.members.map((member) => member.beat)));
    sharedNotationPlan.bars = { melody: new Set(), backing: new Set() };
    sharedNotationPlan.lyricBars = { melody: new Set(), backing: new Set() };
    for (const row of ["melody", "backing"]) {
      sharedNotationPlan.rows[row].forEach((event) => sharedNotationPlan.bars[row].add(event.bar));
      sharedNotationPlan.rows[row].forEach((event) => sharedNotationPlan.lyricBars[row].add(event.bar));
      sharedNotationPlan.dynamics.filter((event) => event.row === row)
        .forEach((event) => sharedNotationPlan.bars[row].add(event.bar));
    }
  }
  const add = (bar, row, event) => {
    if (!notationLyricRows.has(bar)) notationLyricRows.set(bar, new Map());
    const rows = notationLyricRows.get(bar);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(event);
  };
  for (const event of allLyrics) if (!sharedNotationPlan?.hidden.has(event.beat)) {
    add(event.bar, `part-${event.part}-${event.verse}`, event);
  }
  for (const [row, events] of Object.entries(sharedNotationPlan?.rows || {})) {
    for (const event of events) add(event.bar, row, { ...event, tick: event.beat.absoluteDisplayStart });
  }
  if (sharedNotationPlan) for (const row of ["melody", "backing"]) {
    const label = owners => sharedNotationTools.ownerSegments(owners, parts).map(segment => segment.text).join("");
    const lyrics = sharedNotationPlan.rows[row];
    const dynamics = sharedNotationPlan.dynamics.filter(event => event.row === row);
    const events = [...lyrics, ...dynamics.filter(mark => !lyrics.some(event => event.tick === mark.tick
      && mark.owners.every(part => event.owners.includes(part))))].sort((a, b) => a.tick - b.tick);
    let previousOwners = "", previousBar = -1;
    for (const event of events) {
      const owners = label(event.owners);
      const marks = dynamics.filter(mark => mark.tick === event.tick && mark.owners.every(part => event.owners.includes(part)));
      if (marks.length || owners !== previousOwners || event.bar !== previousBar) {
        const text = owners + marks.map(mark => {
          const scope = label(mark.owners) === owners ? "" : `${label(mark.owners)} `;
          const value = window.alphaTab.model.DynamicValue[mark.value]?.toLowerCase() || "";
          return scope ? ` (${scope}${value})` : ` ${value}`;
        }).join("");
        add(event.bar, `${row}-owners`, {tick: event.beat.absoluteDisplayStart, text, ownerLabel: true});
      }
      previousOwners = owners; previousBar = event.bar;
    }
  }
}

function annotationViewport() {
  return window.matchMedia("(max-width: 600px)").matches ? "mobile" : "desktop";
}

function restoreAnnotationLayouts(stored, options) {
  annotationLayouts = sharedNotationTools.annotationPreferences(stored);
  setAnnotationLayout(undefined, options);
}

function setAnnotationLayout(value, { render = true, persist = true } = {}) {
  const previous = annotationLayout;
  if (["part", "shared"].includes(value)) annotationLayouts[annotationViewport()] = value;
  annotationLayout = annotationLayouts[annotationViewport()];
  setLyricsMode(annotationLayout === "shared" ? "changes" : "full", { reload: false, persist: false });
  const toggle = document.getElementById("annotationLayout");
  toggle?.setAttribute("aria-pressed", String(annotationLayout === "shared"));
  if (previous !== annotationLayout && render) {
    if (buildMetadata.repeatedLyricsMarked) {
      if (!reloadNotationForDisplay()) {
        setAnnotationLayout(previous, { render: false, persist: false });
        showToast("Lyric display could not be changed", "error");
        return;
      }
      if (scoreView === "bars") scheduleBarRender();
    } else scheduleRender();
  }
  if (persist) savePreferences();
}

function installSharedNotation() {
  const toggle = document.getElementById("annotationLayout");
  toggle.addEventListener("click", () => {
    setAnnotationLayout(annotationLayout === "shared" ? "part" : "shared");
  });
  registerResetTarget(toggle, "compact lyrics", (state, defaults) => {
    state.annotationLayouts[annotationViewport()] = defaults.annotationLayouts[annotationViewport()];
  });
  setAnnotationLayout(undefined, { render: false, persist: false });
  window.matchMedia("(max-width: 600px)").addEventListener("change", () => {
    setAnnotationLayout(undefined, { persist: false });
  });
  const factories = window.alphaTab.Environment.defaultRenderers;
  const lyricEffect = factories.flatMap((factory) => factory.effectBands)
    .find((band) => band.effect.notationElement === window.alphaTab.NotationElement.EffectLyrics).effect;
  const originalLyricPredicate = lyricEffect.shouldCreateGlyph.bind(lyricEffect);
  lyricEffect.shouldCreateGlyph = (settings, beat) => originalLyricPredicate(settings, beat)
    && !sharedNotationPlan?.hidden.has(beat);
  const standardFactory = factories.find((factory) => factory.staffId === "score");
  sharedNotationTools.installSpacing(standardFactory, (renderer) => {
    const canvas = renderer.scoreRenderer.canvas;
    const previous = canvas.font;
    const lyricFont = renderer.settings.display.resources.elementFonts.get(window.alphaTab.NotationElement.EffectLyrics);
    const ownerFont = new window.alphaTab.model.Font("system-ui, sans-serif", 9,
      window.alphaTab.model.FontStyle.Plain, window.alphaTab.model.FontWeight.Bold);
    try {
      return [...(notationLyricRows.get(renderer.bar.index)?.values() || [])]
        .map(row => row.map(event => {
          canvas.font = event.ownerLabel ? ownerFont : lyricFont;
          const width = canvas.measureText(event.text).width;
          return {tick: event.tick, width, ...(event.ownerLabel ? {left: 0, right: width} : {})};
        }));
    } finally { canvas.font = previous; }
  });
  for (const factory of factories) {
    for (const band of factory.effectBands) {
      if (band.effect.isWrittenExpression) {
        band.effect.isDynamicVisible = beat => !sharedNotationPlan?.hiddenDynamics.has(beat);
        continue;
      }
      if (band.effect.notationElement !== window.alphaTab.NotationElement.EffectDynamics) continue;
      const original = band.effect.shouldCreateGlyph.bind(band.effect);
      band.effect.shouldCreateGlyph = (settings, beat) => original(settings, beat)
        && !sharedNotationPlan?.hiddenDynamics.has(beat);
    }
  }
  // Invisible effect bands reserve space in AlphaTab's own system layout.
  // Their SVG rectangles give the overlay exact, scaled lane coordinates.
  for (const [row, mode] of [["melody", 2], ["backing", 3]]) {
    class SharedLane extends lyricEffect.constructor {
      get effectId() { return `shared-${row}`; }
      get canShareBand() { return false; }
      shouldCreateGlyph(_settings, beat) {
        if (!sharedNotationPlan || !sharedNotationPlan.bars[row].has(beat.voice.bar.index)) return false;
        const indices = [...visibleTracks].sort((a, b) => a - b);
        const part = row === "melody" ? indices[0] : indices.at(-1);
        return beat.voice.index === 0 && beat.index === 0
          && beat.voice.bar.staff.track === scoreTracks[part];
      }
      createNewGlyph(settings, beat) {
        const glyph = lyricEffect.createNewGlyph(settings, { lyrics: [" "] });
        glyph.doLayout = function () {
          this.height = sharedNotationPlan?.lyricBars[row].has(beat.voice.bar.index) ? 26 : 14;
          this.width = 0;
        };
        glyph.paint = function (cx, cy, canvas) {
          canvas.beginGroup(`shared-anchor shared-${row}-${beat.voice.bar.index}`);
          canvas.fillRect(cx + this.x, cy + this.y, 1, this.height);
          canvas.endGroup();
        };
        return glyph;
      }
    }
    standardFactory.effectBands.push({ effect: new SharedLane(), mode });
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => [...record.addedNodes].some((node) => node.nodeType === 1
      && (node.matches?.(".at-surface, svg:not(.shared-notation-layer)")
        || node.querySelector?.(".shared-anchor"))))) scheduleSharedNotation();
  });
  observer.observe(elements.score, { childList: true, subtree: true });
}

function scheduleSharedNotation() {
  cancelAnimationFrame(sharedNotationFrame);
  sharedNotationFrame = requestAnimationFrame(renderSharedNotation);
}

function renderSharedNotation() {
  elements.score.querySelectorAll(":scope > .shared-notation-layer").forEach((layer) => layer.remove());
  if (!sharedNotationPlan || !sharedNotationActive()) return;
  const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
  if (!lookup) return;
  const scale = api.settings.display.scale;
  const origin = elements.score.getBoundingClientRect();
  const svg = createSvgElement("svg", { class: "shared-notation-layer", "aria-label": "Shared melody and accompaniment lyrics" });
  const dimensions = { width: elements.score.scrollWidth, height: elements.score.scrollHeight };
  svg.setAttribute("width", dimensions.width);
  svg.setAttribute("height", dimensions.height);
  svg.style.width = `${dimensions.width}px`;
  svg.style.height = `${dimensions.height}px`;
  const label = owners => sharedNotationTools.ownerSegments(owners, parts).map(segment => segment.text).join("");
  for (const row of ["melody", "backing"]) {
    let previousOwners = "", previousSystem = null;
    const lyricEvents = sharedNotationPlan.rows[row].map((event) => ({ ...event, kind: "lyric" }));
    const dynamicEvents = sharedNotationPlan.dynamics.filter((event) => event.row === row)
      .map((event) => ({ ...event, kind: "dynamic" }));
    const ordered = [...lyricEvents, ...dynamicEvents].sort((a, b) => a.tick - b.tick || a.kind.localeCompare(b.kind));
    for (const event of ordered) {
      if (event.kind === "dynamic" && lyricEvents.some((lyric) => lyric.tick === event.tick
        && event.owners.every((part) => lyric.owners.includes(part)))) continue;
      const anchor = elements.score.querySelector(`.shared-${row}-${event.bar} rect`);
      const beatBounds = lookup.findBeat(event.beat);
      if (!anchor || !beatBounds) continue;
      const box = anchor.getBoundingClientRect();
      const y = box.top - origin.top;
      const x = beatBounds.onNotesX;
      const master = lookup.findMasterBarByIndex(event.bar);
      const system = master?.staffSystemBounds?.index;
      const owners = label(event.owners);
      const group = createSvgElement("g", { "data-row": row, "data-measure": event.bar + 1,
        "data-parts": owners, "data-part-indices": event.owners.join(","), "data-tick": event.tick, "data-kind": event.kind });
      const text = (content, baseline, size, className, align = "middle") => {
        const element = createSvgElement("text", { x, y: baseline, "font-size": size * scale,
          "text-anchor": align, class: className });
        element.textContent = content;
        group.appendChild(element);
        return element;
      };
      const ownerLabel = (marks = []) => {
        const element = text("", y + 9 * scale, 9, "shared-owners", "start");
        for (const { part, text: content } of sharedNotationTools.ownerSegments(event.owners, parts)) {
          const span = createSvgElement("tspan");
          if (part !== null) span.style.fill = `var(--part-${part + 1}, ${parts[part].color})`;
          span.textContent = content;
          element.appendChild(span);
        }
        for (const mark of marks) {
          const span = createSvgElement("tspan", { class: "shared-dynamic" });
          const scope = label(mark.owners) === owners ? "" : `${label(mark.owners)} `;
          const value = window.alphaTab.model.DynamicValue[mark.value]?.toLowerCase() || "";
          span.textContent = scope ? ` (${scope}${value})` : ` ${value}`;
          element.appendChild(span);
        }
      };
      if (event.kind === "dynamic") {
        ownerLabel([event]);
      } else {
        const marks = dynamicEvents.filter((dynamic) => dynamic.tick === event.tick
          && dynamic.owners.every((part) => event.owners.includes(part)));
        if (marks.length || owners !== previousOwners || system !== previousSystem) {
          ownerLabel(marks);
        }
        text(event.text, y + 24 * scale, LYRIC_FONT_SIZE, "shared-syllable");
        previousOwners = owners;
        previousSystem = system;
      }
      svg.appendChild(group);
    }
  }
  elements.score.appendChild(svg);
}
