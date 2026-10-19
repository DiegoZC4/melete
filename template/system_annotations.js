/* Score-wide directions follow the first visible staff, never a fixed singer. */
const systemAnnotationTools = (() => {
  const rhythmicCues = new WeakMap();
  const systemCues = new WeakMap();
  let rhythmInstalled = false;
  function fromXml(documentXml) {
    const children = (node, name) => [...node.children].filter(child => child.localName === name);
    const number = (node, name, fallback = 0) => Number(children(node, name)[0]?.textContent ?? fallback);
    const marks = new Map();
    children(documentXml.documentElement, 'part').forEach((part, track) => {
      let divisions = 1;
      children(part, 'measure').forEach((measure, bar) => {
        let position = 0;
        for (const node of measure.children) {
          if (node.localName === 'attributes') divisions = number(node, 'divisions', divisions);
          if (node.localName === 'backup') position -= number(node, 'duration') / divisions;
          if (node.localName === 'forward') position += number(node, 'duration') / divisions;
          if (node.localName === 'note' && !children(node, 'chord').length && !children(node, 'grace').length) {
            position += number(node, 'duration') / divisions;
          }
          if (node.localName !== 'direction') continue;
          const at = position + number(node, 'offset') / divisions;
          const staff = number(node, 'staff', 1) - 1;
          for (const type of children(node, 'direction-type')) {
            for (const item of type.children) {
              const heading = item.localName === 'rehearsal';
              if (!heading && !(item.localName === 'words' && ['only-top', 'also-top'].includes(node.getAttribute('system')))) continue;
              const text = item.textContent.trim();
              // Metric equations have their own music-font tempo lane.
              if (!text || /[\uECA2-\uECAF].*=.*[\uECA2-\uECAF]/.test(text)) continue;
              const key = JSON.stringify([bar, at, heading, text]);
              const mark = marks.get(key) || {bar, at, heading: heading ? text : '', cue: heading ? '' : text, sources: []};
              mark.sources.push({track, staff, original: text, alsoTop: node.getAttribute('system') === 'also-top'});
              marks.set(key, mark);
            }
          }
        }
      });
    });
    return [...marks.values()];
  }

  function installRhythmCues(alphaTab) {
    if (rhythmInstalled) return;
    rhythmInstalled = true;
    const effects = new Set();
    for (const factory of alphaTab.Environment.defaultRenderers) for (const band of factory.effectBands || []) {
      if (band.effect.notationElement !== alphaTab.NotationElement.EffectText || effects.has(band.effect)) continue;
      effects.add(band.effect);
      const createGlyph = band.effect.createNewGlyph;
      band.effect.createNewGlyph = function(renderer, beat) {
        const cues = systemCues.get(beat);
        const glyph = createGlyph.call(this, renderer, beat), cue = rhythmicCues.get(beat);
        if (cues && !cue) {
          const local = cues.original ? createGlyph.call(this, renderer,
            Object.create(beat, {text: {value: cues.original}})) : null;
          const layout = glyph.doLayout;
          glyph.doLayout = function() {
            layout.call(this);
            if (local) { local.renderer = this.renderer; local.doLayout(); }
            this.height = Math.max(this.height, (cues.original ? 1 : 0) * 16 + cues.marks.length * 16);
          };
          glyph.paint = function(x, y, canvas) {
            if (local) { local.x = this.x; local.y = this.y; local.paint(x, y, canvas); }
            const font = canvas.font, align = canvas.textAlign, baseline = canvas.textBaseline;
            canvas.font = renderer.resources.elementFonts.get(alphaTab.NotationElement.EffectText);
            canvas.textAlign = 0; canvas.textBaseline = 3;
            cues.marks.forEach((mark, index) => {
              const left = renderer.getRatioPositionX(mark.ratio);
              canvas.beginGroup('system-cue');
              canvas.fillText(mark.cue, x + left, y + this.y + (index + 1 + (cues.original ? 1 : 0)) * 16 - 3);
              canvas.endGroup();
            });
            canvas.font = font; canvas.textAlign = align; canvas.textBaseline = baseline;
          };
          return glyph;
        }
        if (!cue) return glyph;
        glyph.doLayout = function() { this.width = 120; this.height = 20; };
        glyph.paint = function(x, y, canvas) {
          const font = canvas.font, align = canvas.textAlign, baseline = canvas.textBaseline, line = canvas.lineWidth;
          canvas.font = renderer.resources.elementFonts.get(alphaTab.NotationElement.EffectText).withSize(12);
          canvas.textAlign = 0;
          canvas.textBaseline = 3;
          const left = x + this.x, bottom = y + this.y + this.height - 3;
          canvas.beginGroup('body-rhythm-cue');
          canvas.fillText(cue.label + ' (', left, bottom);
          let cursor = left + canvas.measureText(cue.label + ' (').width + 6;
          const scale = 0.55, metrics = renderer.smuflMetrics;
          for (const symbol of cue.rhythm) {
            if (symbol === 'rest') {
              canvas.fillMusicFontSymbol(cursor, bottom - 7, scale, alphaTab.model.MusicFontSymbol.RestQuarter, true);
            } else {
              const head = alphaTab.model.MusicFontSymbol.NoteheadXBlack;
              canvas.fillMusicFontSymbol(cursor, bottom - 2, scale, head, true);
              const stem = cursor + metrics.glyphWidths.get(head) * scale / 2 - 0.3;
              canvas.lineWidth = metrics.stemThickness * scale;
              canvas.beginPath(); canvas.moveTo(stem, bottom - 2); canvas.lineTo(stem, bottom - 17); canvas.stroke();
            }
            cursor += 17;
          }
          canvas.fillText(')', cursor - 5, bottom);
          canvas.endGroup();
          canvas.font = font; canvas.textAlign = align; canvas.textBaseline = baseline; canvas.lineWidth = line;
        };
        return glyph;
      };
    }
  }

  function create(alphaTab, score, annotations, division = 960) {
    installRhythmCues(alphaTab);
    const original = new Map();
    for (const mark of annotations) {
      for (const track of score.tracks) for (const staff of track.staves) {
        const bar = staff.bars[mark.bar];
        for (const voice of bar?.voices || []) for (const beat of voice.beats) {
          if (mark.sources) {
            const texts = mark.sources.filter(source => source.track === track.index && source.staff === staff.index)
              .map(source => source.original);
            const current = original.get(beat) ?? beat.text ?? '';
            const remaining = current.split('\n').filter(line => !texts.includes(line)).join('\n');
            if (remaining !== current) original.set(beat, remaining);
          } else if (beat.text === mark.original || mark.importedTexts?.includes(beat.text)) original.set(beat, '');
        }
      }
      if (mark.heading && score.masterBars[mark.bar]) {
        const section = new alphaTab.model.Section();
        section.text = mark.heading;
        score.masterBars[mark.bar].section = section;
      }
    }
    return (tracks, settings) => {
      for (const [beat, text] of original) { beat.text = text; rhythmicCues.delete(beat); systemCues.delete(beat); }
      const top = tracks[0]?.staves[0];
      for (const mark of annotations) {
        const destinations = new Set([top]);
        for (const source of mark.sources || []) if (source.alsoTop) {
          destinations.add(tracks.find(track => track.index === source.track)?.staves[source.staff]);
        }
        for (const staff of destinations) {
          const beats = staff?.bars[mark.bar]?.voices[0]?.beats || [];
          const at = mark.at || 0;
          const beat = beats.filter(beat => beat.playbackStart <= at * division + 0.01).at(-1) || beats[0];
          if (!beat || !mark.cue) continue;
          if (!original.has(beat)) original.set(beat, beat.text);
          if (mark.at !== undefined) {
            const cues = systemCues.get(beat) || {original: beat.text || '', marks: []};
            cues.marks.push({...mark, ratio: at * division / beat.voice.bar.masterBar.calculateDuration()});
            systemCues.set(beat, cues);
          }
          beat.text = [beat.text, mark.cue].filter(Boolean).join('\n');
          if (mark.rhythm) rhythmicCues.set(beat, {label:mark.cue, rhythm:mark.rhythm});
        }
      }
      const fonts = settings.display.resources;
      const heading = fonts.markerFont.withSize(18);
      heading.style = alphaTab.model.FontStyle.Plain;
      heading.weight = alphaTab.model.FontWeight.Bold;
      fonts.markerFont = heading;
      settings.display.effectBandPaddingBottom = 6;
    };
  }
  return { create, fromXml };
})();

if (typeof module === 'object' && module.exports) module.exports = systemAnnotationTools;
let systemAnnotationScore = null;
let updateSystemAnnotations = null;
function prepareSystemAnnotations(tracks = scoreTracks.filter((_, index) => visibleTracks.has(index))) {
  const score = scoreTracks[0]?.score;
  if (!score || !api) return;
  if (score !== systemAnnotationScore) {
    systemAnnotationScore = score;
    const annotations = config.systemAnnotations ?? systemAnnotationTools.fromXml(
      new DOMParser().parseFromString(fullScoreXml, 'application/xml'));
    updateSystemAnnotations = systemAnnotationTools.create(window.alphaTab, score, annotations, sequence.division);
  }
  updateSystemAnnotations(tracks, api.settings);
}
