(() => {
  "use strict";

  // Voice-part colours live in the stylesheet, as --part-1 upward, so the dark
  // theme can lift them off its own ground. These are only the fallbacks the
  // var() calls carry, and they match the light theme's values.
  const PALETTE = Object.freeze([
    "#ac345e",
    "#855418",
    "#086b7c",
    "#64499b",
    "#4f8265",
    "#925b91",
    "#a75e3b",
    "#3d7898",
  ]);
  const partPaint = (index) => `var(--part-${(index % PALETTE.length) + 1}, ${PALETTE[index % PALETTE.length]})`;
  const TEMPO_VALUES = Object.freeze([25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
  const VERTICAL_VALUES = Object.freeze([50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
  const STANDARD_HORIZONTAL_VALUES = Object.freeze([5, 10, 15, 20, 25, 35, 50, 65, 80, 100, 120, 140, 160, 180, 200,
    220, 240, 260, 280, 300, 320, 340, 360, 380, 400]);
  const HORIZONTAL_VALUES = Object.freeze(Array.from({ length: 80 }, (_, index) => (index + 1) * 5));
  const PITCH_BAR_UNIT_WIDTH = 16;
  const VOLUME_VALUES = Object.freeze(Array.from({ length: 31 }, (_, index) => index * 5));
  const PAN_VALUES = Object.freeze(Array.from({ length: 41 }, (_, index) => index * 5 - 100));
  const METRONOME_VALUES = Object.freeze(Array.from({ length: 11 }, (_, index) => index * 10));
  const PITCH_CONFIDENCE_THRESHOLD = 0.7;
  const SCHEDULER_INTERVAL_MS = 40;
  const SCHEDULER_HORIZON_SECONDS = 0.34;
  const SCHEDULER_LEAD_SECONDS = 0.028;
  const PITCH_BAR_HYPHEN_LEEWAY = 2;
  // Fractions of a bar note's height, by metric weight: downbeat, middle of the
  // bar, plain beat. The tallest stays clear of a reattack line, which cuts the
  // whole height and means something else entirely.
  const BEAT_TICK_HEIGHTS = Object.freeze([0.7, 0.55, 0.4]);
  const MIXER_SOLO_HOLD_MS = 500;
  const PITCH_AUDITION_HOLD_MS = 250;
  const KEYBOARD_NOTE_PREVIEW_SECONDS = 0.22;
  const PITCH_AUDITION_RELEASE_SECONDS = 0.12;
  const PITCH_CAPTURE_INTERVAL_MS = 1000 / 15;
  const PITCH_CAPTURE_FALLBACK_INTERVAL_MS = 100;
  const PITCH_CAPTURE_BUFFER_SIZE = 4096;
  const PITCH_CAPTURE_MIN_FREQUENCY = 55;
  const PITCH_CAPTURE_MAX_FREQUENCY = 1200;
  const PITCH_TRACE_STORAGE_VERSION = 3;
  const PITCH_TRACE_BINS_PER_QUARTER = 16;
  const PITCH_TRACE_SAVE_DELAY_MS = 850;
  const PITCH_TRACE_MAX_DRAW_GAP_SECONDS = 0.25;
  const PITCH_TRACE_RENDER_JUMP_CENTS = 400;
  const PITCH_TRACE_GREEN_TOLERANCE_CENTS = 10;
  const PITCH_TRACE_RED_CENTS = 50;
  const STAFF_TRACE_CENTS_PER_STEP = 25;
  const LYRIC_FONT_SIZE = 14;
  const PORTABLE_STATE_VERSION = 1;
  const NOTATION_RENDER_TIMEOUT_MS = 6000;
  const FOLLOW_CHECK_INTERVAL_MS = 60;
  const FOLLOW_SCROLL_LEAD_BUFFER_MS = 80;

  let api = null;
  let engine = null;
  let sequence = null;
  let pitchBarUnitTicks = 960;
  let config = {};
  let buildMetadata = {};
  let portableState = null;
  let initialDocumentSource = "";
  let scoreTracks = [];
  let parts = [];
  let ready = false;
  let loadFailed = false;
  let playing = false;
  let seeking = false;
  let chapterSeekMilliseconds = [];
  let renderTimer = 0;
  let notationRenderInFlight = false;
  let notationRenderQueued = false;
  let notationRenderTimeout = 0;
  let notationHasRendered = false;
  let notationRenderFailed = false;
  let scoreRenderSnapshot = null;
  let scoreRenderSnapshotTimer = 0;
  let scoreRenderStyleLock = null;
  let toastTimer = 0;
  let toastAction = null;
  let lastFollow = 0;
  let followScrollFrame = 0;
  let cursorTrimFrame = 0;
  let cursorTrimBurstGeneration = 0;
  let cursorTrimObserver = null;
  let cursorTrimTargets = [];
  let fullRestCenterGeneration = 0;
  let automaticScrollUntil = 0;
  let playbackDetached = false;
  let verticalFollowAnimationFrame = 0;
  let verticalFollowAnimationGeneration = 0;
  let predictiveFollowRange = null;
  let pinchActive = false;
  let pinchStartDistance = 0;
  let pinchStartScale = 100;
  let pinchTargetScale = 100;
  let pinchSurface = null;
  let scoreResizeObserver = null;
  let lastScoreShellWidth = 0;
  let flow = "wrap";
  let scoreView = "standard";
  let lyricsMode = "full";
  let fullScoreXml = "";
  let writtenDynamicForBeat = null;
  let pendingNotationReload = null;
  let loopStartMeasure = null;
  let loopEndMeasure = null;
  let practicePartIndex = null;
  let partDivisi = [];
  let practicePartPager = null;
  let practiceDivisi = [];
  let practiceDivisiPager = null;
  let activePracticeMix = null;
  let practiceMixPartIndex = null;
  let practiceMixUndo = null;
  let editingAnnotation = null;
  let annotationDragActive = false;
  let selectedScoreTick = null;
  let selectedScorePartIndex = null;
  let keyboardAudition = null;
  let scoreScrub = null;
  const pitchAuditions = new Map();
  let sectionGuideGeneration = 0;
  let preferenceKey = "choir-practice-trainer:v1";
  let settingsPanelPreferenceKey = "choir-practice:settings-open:v1";
  let annotationKey = "choir-practice-trainer:notes:v3";
  let legacyAnnotationKeys = [];
  let legacyPreferenceKeys = [];
  let legacySettingsPanelKeys = [];
  let legacyPitchTraceKeys = [];
  let pitchTraceKey = "choir-practice-trainer:pitch-trace:v2";
  // One contour per divisi line, so the upper and the lower line of the same
  // passage can both be kept instead of the second take erasing the first.
  // Lane 0 is the top line, and the only lane an undivided part ever uses.
  const pitchTraceLanes = new Map();
  let pitchTraceCount = 0;
  let pitchTraceSaveTimer = 0;
  let pitchCaptureState = "off";
  let wantsPitchCapture = false;
  let pitchCaptureRequestGeneration = 0;
  let pitchCaptureStream = null;
  let pitchCaptureContext = null;
  let pitchCaptureSource = null;
  let pitchCaptureAnalyser = null;
  let pitchCaptureDetector = null;
  let pitchCaptureBuffer = null;
  let pitchCaptureTimer = 0;
  let pitchCapturePreviousTick = null;
  let pitchCapturePreviousSeconds = null;
  let pitchCaptureWasSilent = true;
  let pitchLastAcceptedCents = null;
  let pitchPendingEvidence = null;
  let pitchCaptureMisses = 0;
  let barRenderFrame = 0;
  let barSystems = [];
  let staffTraceSystems = [];
  let activeBarSystemIndex = -1;
  let scoreKeyPitchClasses = { tonic: 7, dominant: 2, third: 11 };

  const visibleTracks = new Set();
  const audibleTracks = new Set();
  const annotations = new Map();
  let trackVolumes = [];
  let trackPans = [];
  const volumeControls = [];
  const panControls = [];
  let settingsHelpEnabled = false;
  let settingsTooltipTarget = null;
  let settingsTooltipTimer = 0;
  let partChooserKey = "";
  let pendingPartLink = null;

  const elements = {
    transport: document.querySelector(".transport"),
    playPause: document.getElementById("playPause"),
    seek: document.getElementById("seek"),
    timelineRail: document.getElementById("timelineRail"),
    timelineSegments: document.getElementById("timelineSegments"),
    loopBand: document.getElementById("loopBand"),
    currentTime: document.getElementById("currentTime"),
    totalTime: document.getElementById("totalTime"),
    scoreShell: document.getElementById("scoreShell"),
    score: document.getElementById("score"),
    barScore: document.getElementById("barScore"),
    scoreLoading: document.getElementById("scoreLoading"),
    scoreLoadingText: document.getElementById("scoreLoadingText"),
    playbackReturn: document.getElementById("playbackReturn"),
    mixer: document.getElementById("mixer"),
    practicePart: document.getElementById("practicePart"),
    tempo: document.getElementById("tempo"),
    metronome: document.getElementById("metronome"),
    verticalScale: document.getElementById("verticalScale"),
    horizontalScale: document.getElementById("horizontalScale"),
    flowToggle: document.getElementById("flowToggle"),
    scoreViewToggle: document.getElementById("scoreViewToggle"),
    pitchCapture: document.getElementById("pitchCapture"),
    settingsToggle: document.getElementById("settingsToggle"),
    settingsPanel: document.getElementById("settingsPanel"),
    settingsHelp: document.getElementById("settingsHelp"),
    settingsTooltip: document.getElementById("settingsTooltip"),
    shortcutTip: document.getElementById("shortcutTip"),
    shortcutTipMessage: document.getElementById("shortcutTipMessage"),
    shortcutTipDismiss: document.getElementById("shortcutTipDismiss"),
    loopStart: document.getElementById("loopStart"),
    loopEnd: document.getElementById("loopEnd"),
    loopControls: document.getElementById("loopControls"),
    fullscreen: document.getElementById("fullscreen"),
    noteMode: document.getElementById("noteMode"),
    download: document.getElementById("download"),
    demoVideo: document.getElementById("demoVideo"),
    printScore: document.getElementById("printScore"),
    downloadScore: document.getElementById("downloadScore"),
    toast: document.getElementById("toast"),
    toastMessage: document.getElementById("toastMessage"),
    toastUndo: document.getElementById("toastUndo"),
    partChooser: document.getElementById("partChooser"),
    partChooserOptions: document.getElementById("partChooserOptions"),
    partChooserNote: document.getElementById("partChooserNote"),
    partChooserDismiss: document.getElementById("partChooserDismiss"),
    scrubLabel: document.getElementById("scrubLabel"),
  };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function nearestAllowed(value, values) {
    return values.reduce(
      (best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
      values[0],
    );
  }

  function hideSettingsTooltip() {
    window.clearTimeout(settingsTooltipTimer);
    settingsTooltipTimer = 0;
    if (settingsTooltipTarget?.getAttribute("aria-describedby") === "settingsTooltip") {
      settingsTooltipTarget.removeAttribute("aria-describedby");
    }
    settingsTooltipTarget = null;
    elements.settingsTooltip.classList.remove("is-visible");
    elements.settingsTooltip.setAttribute("aria-hidden", "true");
    elements.settingsTooltip.hidden = true;
  }

  function positionSettingsTooltip(target) {
    if (!target || elements.settingsTooltip.hidden) return;
    const targetBounds = target.getBoundingClientRect();
    const tooltipBounds = elements.settingsTooltip.getBoundingClientRect();
    const margin = 8;
    const centeredLeft = targetBounds.left + targetBounds.width / 2 - tooltipBounds.width / 2;
    const left = clamp(centeredLeft, margin, Math.max(margin, window.innerWidth - tooltipBounds.width - margin));
    const fitsBelow = targetBounds.bottom + margin + tooltipBounds.height <= window.innerHeight - margin;
    const top = fitsBelow
      ? targetBounds.bottom + margin
      : Math.max(margin, targetBounds.top - tooltipBounds.height - margin);
    elements.settingsTooltip.style.left = `${Math.round(left)}px`;
    elements.settingsTooltip.style.top = `${Math.round(top)}px`;
  }

  // A control's own line, then how to reset it. Row and section labels carry no
  // line of their own, so theirs names what it resets; anywhere else the
  // tooltip already sits on the thing, so it does not repeat the name.
  const SETTING_HELP_SELECTOR = "[data-help], [data-reset-scope]";

  function settingHelpMessage(target) {
    const own = target.dataset.help?.trim();
    const scope = target.dataset.resetScope;
    if (!scope) return own || "";
    const hold = target.dataset.resetHold === "true" ? " or hold" : "";
    return [own, `Right-click${hold} to reset${own ? "" : ` ${scope}`}.`].filter(Boolean).join(" ");
  }

  function showSettingsTooltip(target, { delay = 120 } = {}) {
    if (!settingsHelpEnabled || !(target instanceof Element)) return;
    const message = settingHelpMessage(target);
    if (!message) return;
    window.clearTimeout(settingsTooltipTimer);
    const reveal = () => {
      if (!settingsHelpEnabled || !target.isConnected) return;
      if (settingsTooltipTarget && settingsTooltipTarget !== target
        && settingsTooltipTarget.getAttribute("aria-describedby") === "settingsTooltip") {
        settingsTooltipTarget.removeAttribute("aria-describedby");
      }
      settingsTooltipTarget = target;
      elements.settingsTooltip.textContent = settingHelpMessage(target);
      elements.settingsTooltip.hidden = false;
      elements.settingsTooltip.setAttribute("aria-hidden", "false");
      target.setAttribute("aria-describedby", "settingsTooltip");
      positionSettingsTooltip(target);
      requestAnimationFrame(() => elements.settingsTooltip.classList.add("is-visible"));
    };
    if (delay > 0) settingsTooltipTimer = window.setTimeout(reveal, delay);
    else reveal();
  }

  function setSettingsHelp(enabled) {
    hideShortcutTip();
    settingsHelpEnabled = Boolean(enabled);
    elements.settingsPanel.classList.toggle("is-help-mode", settingsHelpEnabled);
    elements.settingsHelp.setAttribute("aria-pressed", String(settingsHelpEnabled));
    elements.settingsHelp.setAttribute("aria-label", settingsHelpEnabled ? "Hide setting help" : "Show setting help");
    if (!settingsHelpEnabled) hideSettingsTooltip();
  }

  function setupSettingsHelp() {
    setSettingsHelp(false);
    elements.settingsHelp.addEventListener("click", () => setSettingsHelp(!settingsHelpEnabled));
    elements.settingsPanel.addEventListener("pointerover", (event) => {
      if (!settingsHelpEnabled || event.pointerType === "touch") return;
      const target = event.target.closest?.(SETTING_HELP_SELECTOR);
      if (!target || target.contains(event.relatedTarget)) return;
      showSettingsTooltip(target);
    });
    elements.settingsPanel.addEventListener("pointerout", (event) => {
      if (!settingsHelpEnabled || event.pointerType === "touch") return;
      const target = event.target.closest?.(SETTING_HELP_SELECTOR);
      if (!target || target.contains(event.relatedTarget)) return;
      hideSettingsTooltip();
    });
    elements.settingsPanel.addEventListener("focusin", (event) => {
      if (settingsHelpEnabled) showSettingsTooltip(event.target.closest?.(SETTING_HELP_SELECTOR), { delay: 0 });
    });
    elements.settingsPanel.addEventListener("focusout", (event) => {
      if (settingsTooltipTarget?.contains(event.relatedTarget)) return;
      hideSettingsTooltip();
    });
    // Only a touch has to spend its tap on reading: with no hover there is no
    // other way to see a tooltip. A mouse or pen has already been shown one on
    // the way in, so its click is left to do its job and help mode stops
    // standing between the user and the control. A click that changes what the
    // control says refreshes the tooltip it is already showing.
    let inspectByTouch = false;
    const inspectSetting = (event) => {
      if (!settingsHelpEnabled || event.target.closest?.("#settingsHelp")) return;
      if (event.type === "pointerdown") inspectByTouch = event.pointerType === "touch";
      else if (!event.detail) inspectByTouch = false;
      const target = event.target.closest?.(SETTING_HELP_SELECTOR);
      if (!target || !elements.settingsPanel.contains(target)) return;
      if (!inspectByTouch) {
        if (event.type === "click" && target === settingsTooltipTarget) {
          requestAnimationFrame(() => showSettingsTooltip(target, { delay: 0 }));
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      showSettingsTooltip(target, { delay: 0 });
    };
    elements.settingsPanel.addEventListener("pointerdown", inspectSetting, true);
    elements.settingsPanel.addEventListener("click", inspectSetting, true);
    document.addEventListener("keydown", (event) => {
      if (settingsHelpEnabled && event.key === "Escape") setSettingsHelp(false);
    });
    window.addEventListener("resize", hideSettingsTooltip, { passive: true });
    window.addEventListener("scroll", hideSettingsTooltip, { passive: true });
  }

  // Track completed manual actions, never the stream of input events from a drag.
  class ShortcutHintTracker {
    constructor({ now = () => Date.now(), read = () => [], write = () => {} } = {}) {
      this.now = now;
      this.read = read;
      this.write = write;
      this.handled = new Set();
      this.sync();
      this.history = new Map();
      this.lastShown = -Infinity;
    }

    // One record serves every song, and a collection runs its songs side by
    // side, so re-read it before deciding or writing rather than trusting the
    // copy this page started with: a tip seen in one song stays seen in the
    // other, and neither page's write can drop what the other learned.
    sync() {
      try {
        const stored = this.read();
        if (Array.isArray(stored)) stored.forEach((id) => {
          if (["isolate", "reset-row", "vol-hold", "pan-hold"].includes(id)) this.handled.add(id);
        });
      } catch {}
    }

    clear() { this.history.clear(); }

    learn(id) {
      this.sync();
      this.handled.add(id);
      this.clear();
      try { this.write([...this.handled]); } catch {}
    }

    eligible(id) {
      this.sync();
      return !this.handled.has(id) && this.now() - this.lastShown >= 60000;
    }

    // The first finished Vol or Pan drag, or choosing a part, is when holding
    // that control is worth a mention; a hold already performed has taught it.
    hold(row, index, input = "mouse") {
      const id = `${row}-hold`;
      if (!["vol-hold", "pan-hold"].includes(id) || !this.eligible(id)) return null;
      return { id, row, part: index, input };
    }

    shown(id) {
      if (!this.eligible(id)) return false;
      this.lastShown = this.now();
      this.learn(id);
      return true;
    }

    toggle(row, index, before, after, input = "mouse") {
      const key = `toggle:${row}`;
      const now = this.now();
      const previous = this.history.get(key);
      let actions = previous && previous.state.every((value, i) => value === before[i])
        ? previous.actions.filter((action) => now - action.at <= 3000) : [];
      if (before.length < 3 || before.length !== after.length || !before[index] || after[index]
        || before.filter((value, i) => value !== after[i]).length !== 1) {
        this.history.delete(key);
        return null;
      }
      actions.push({ index, at: now });
      this.history.set(key, { actions, state: [...after] });
      if (!this.eligible("isolate") || new Set(actions.map((action) => action.index)).size < 2
        || after.filter(Boolean).length !== 1) return null;
      return { id: "isolate", row, part: after.indexOf(true), input };
    }

    adjust(row, index, before, after, defaultValue, input = "mouse") {
      const key = `adjust:${row}`;
      const now = this.now();
      const actions = (this.history.get(key) || [])
        .filter((action) => now - action.at <= 8000 && action.index !== index);
      if (before !== after && before !== defaultValue && after === defaultValue) {
        actions.push({ index, at: now });
      }
      this.history.set(key, actions);
      if (!this.eligible("reset-row") || actions.length < 2) return null;
      return { id: "reset-row", row, parts: actions.map((action) => action.index), input };
    }
  }

  const shortcutHints = new ShortcutHintTracker({
    read: () => JSON.parse(localStorage.getItem("choir-practice:shortcut-tips:v1") || "[]"),
    write: (handled) => localStorage.setItem("choir-practice:shortcut-tips:v1", JSON.stringify(handled)),
  });
  let shortcutTipTarget = null;
  let shortcutTipTimer = 0;
  let shortcutTipLifetime = 0;

  function hideShortcutTip() {
    const restoreFocus = elements.shortcutTip.contains(document.activeElement);
    window.clearTimeout(shortcutTipTimer);
    window.clearTimeout(shortcutTipLifetime);
    shortcutTipTarget?.classList.remove("is-shortcut-tip-target");
    if (shortcutTipTarget) {
      const descriptions = (shortcutTipTarget.getAttribute("aria-describedby") || "")
        .split(/\s+/u).filter((id) => id && id !== "shortcutTipMessage");
      if (descriptions.length) shortcutTipTarget.setAttribute("aria-describedby", descriptions.join(" "));
      else shortcutTipTarget.removeAttribute("aria-describedby");
    }
    elements.shortcutTip.hidden = true;
    elements.shortcutTip.classList.remove("is-visible");
    if (restoreFocus) shortcutTipTarget?.focus({ preventScroll: true });
    shortcutTipTarget = null;
  }

  function learnShortcut(id) {
    shortcutHints.learn(id);
    hideShortcutTip();
  }

  function shortcutTipContent(hint) {
    if (hint.id === "vol-hold" || hint.id === "pan-hold") {
      const volumes = hint.id === "vol-hold";
      const part = parts[hint.part];
      const target = elements.mixer.querySelector(`[data-${volumes ? "volume" : "pan"}-index="${hint.part}"]`);
      if (!part || !target) return null;
      const keyboard = hint.input === "keyboard";
      const gesture = `${keyboard ? "Press Shift+Enter on" : "Press and hold"} ${part.name}’s ${volumes ? "volume" : "pan"}`;
      const again = keyboard ? "Repeat" : "Hold again";
      // The cycles in cyclePartVolumeMix and togglePartPanSeparation, in order
      // and in the words of the messages they show.
      return { target, message: volumes
        ? `${gesture} to emphasize ${part.name} (others 20%). ${again} to reduce ${part.name} to 20%; a third time sets all voices to 100%.`
        : `${gesture} to put ${part.name} right and the other parts left. ${again} to center all parts.` };
    }
    if (hint.id === "isolate") {
      const selector = hint.row === "see" ? "data-visible-index" : "data-audio-index";
      const target = elements.mixer.querySelector(`[${selector}="${hint.part}"]`);
      const selected = hint.row === "see" ? visibleTracks : audibleTracks;
      if (selected.size !== 1 || !selected.has(hint.part)) return null;
      const part = parts[hint.part];
      const gesture = hint.input === "keyboard" ? `Shift+Enter on ${part.short}` : `Press and hold ${part.short}`;
      return { target, message: `${gesture} in ${hint.row === "see" ? "See" : "Hear"} to ${hint.row === "see" ? "show" : "hear"} only ${part.name}.` };
    }
    const volumes = hint.row === "vol";
    const defaults = preferenceDefaults()[volumes ? "volumes" : "pans"];
    const values = volumes ? trackVolumes : trackPans;
    if (!hint.parts.every((index) => values[index] === defaults[index])) return null;
    const target = elements.mixer.querySelector(`[data-mixer-row="${hint.row}"]`);
    const name = volumes ? "Vol" : "Pan";
    const gesture = hint.input === "keyboard" ? `Focus the ${name} label and press Shift+F10`
      : `${hint.input === "touch" ? "Press and hold" : "Right-click"} the ${name} label`;
    const action = defaults.every((value) => value === (volumes ? 100 : 0))
      ? volumes ? "reset all part volumes to 100%" : "center all parts"
      : `reset all ${volumes ? "part volumes" : "pans"} to their defaults`;
    return { target, message: `${gesture} to ${action}.` };
  }

  // A tip waits for a drag, audition or scrub to end, for an Undo message to
  // go, and for the part chooser to be answered, rather than competing with them.
  const heldPointers = new Set();
  document.addEventListener("pointerdown", (event) => heldPointers.add(event.pointerId), true);
  document.addEventListener("pointerup", (event) => heldPointers.delete(event.pointerId), true);
  document.addEventListener("pointercancel", (event) => heldPointers.delete(event.pointerId), true);
  window.addEventListener("blur", () => heldPointers.clear());

  function shortcutTipMustWait() {
    return heldPointers.size > 0 || !elements.partChooser.hidden
      || (elements.toast.classList.contains("has-action") && elements.toast.classList.contains("is-visible"));
  }

  function queueShortcutTip(hint, waited = 0) {
    window.clearTimeout(shortcutTipTimer);
    if (!hint || !shortcutHints.eligible(hint.id)) return;
    shortcutTipTimer = window.setTimeout(() => {
      if (settingsHelpEnabled || document.hidden || !elements.shortcutTip.hidden) return;
      if (shortcutTipMustWait()) {
        if (waited < 12) queueShortcutTip(hint, waited + 1);
        return;
      }
      const content = shortcutTipContent(hint);
      const bounds = content?.target?.getBoundingClientRect();
      if (!bounds?.width || !bounds.height || bounds.top < 0 || bounds.bottom > window.innerHeight
        || bounds.left < 0 || bounds.right > window.innerWidth) return;
      if (!shortcutHints.shown(hint.id)) return;
      shortcutTipTarget = content.target;
      elements.shortcutTipMessage.textContent = content.message;
      elements.shortcutTip.hidden = false;
      const box = elements.shortcutTip.getBoundingClientRect();
      elements.shortcutTip.style.left = `${clamp(bounds.left, 8, Math.max(8, window.innerWidth - box.width - 8))}px`;
      elements.shortcutTip.style.top = `${bounds.bottom + box.height + 8 < window.innerHeight
        ? bounds.bottom + 8 : Math.max(8, bounds.top - box.height - 8)}px`;
      shortcutTipTarget.classList.add("is-shortcut-tip-target");
      shortcutTipTarget.setAttribute("aria-describedby",
        [shortcutTipTarget.getAttribute("aria-describedby"), "shortcutTipMessage"].filter(Boolean).join(" "));
      elements.shortcutTip.classList.add("is-visible");
      shortcutTipLifetime = window.setTimeout(hideShortcutTip, 9000);
    }, 650);
  }

  elements.shortcutTipDismiss.addEventListener("click", hideShortcutTip);
  elements.shortcutTip.addEventListener("pointerenter", () => window.clearTimeout(shortcutTipLifetime));
  elements.shortcutTip.addEventListener("focusin", () => window.clearTimeout(shortcutTipLifetime));
  const resumeShortcutTipTimer = () => {
    if (!elements.shortcutTip.contains(document.activeElement)) {
      window.clearTimeout(shortcutTipLifetime);
      shortcutTipLifetime = window.setTimeout(hideShortcutTip, 9000);
    }
  };
  elements.shortcutTip.addEventListener("pointerleave", resumeShortcutTipTimer);
  elements.shortcutTip.addEventListener("focusout", resumeShortcutTipTimer);
  document.addEventListener("pointerdown", (event) => {
    if (!elements.shortcutTip.contains(event.target)) hideShortcutTip();
  }, true);
  function shortcutTipKeydown(event) {
    if (event.key === "Escape" && !elements.shortcutTip.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hideShortcutTip();
    } else if (!elements.shortcutTip.contains(event.target)) hideShortcutTip();
  }
  document.addEventListener("keydown", shortcutTipKeydown, true);
  window.addEventListener("resize", hideShortcutTip, { passive: true });
  document.addEventListener("scroll", hideShortcutTip, { capture: true, passive: true });
  document.addEventListener("visibilitychange", hideShortcutTip);

  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function parseEmbeddedJson(id, fallback = {}) {
    const source = document.getElementById(id)?.textContent?.trim();
    if (!source) return fallback;
    return JSON.parse(source);
  }

  function showToast(message, state = "", action = null) {
    window.clearTimeout(toastTimer);
    toastAction = typeof action === "function" ? action : null;
    elements.toastMessage.textContent = message;
    elements.toastUndo.hidden = !toastAction;
    elements.toast.classList.toggle("has-action", Boolean(toastAction));
    elements.toast.classList.toggle("is-error", state === "error");
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
      toastAction = null;
    }, state === "error" || toastAction ? 5200 : 2200);
  }

  elements.toastUndo.addEventListener("click", () => {
    const action = toastAction;
    toastAction = null;
    elements.toastUndo.hidden = true;
    elements.toast.classList.remove("has-action", "is-visible");
    if (action) action();
  });

  function setNotationLoadingMessage(message = "Engraving score…") {
    elements.scoreLoadingText.textContent = message;
  }

  function syncScoreLoadingVisibility() {
    const shouldShow = scoreView === "standard"
      && (loadFailed || (!notationHasRendered && !notationRenderFailed));
    elements.scoreLoading.classList.toggle("is-hidden", !shouldShow);
  }

  function showLoadError(summary, detail = summary) {
    loadFailed = true;
    ready = false;
    playing = false;
    engine?.pause();
    elements.playPause.disabled = true;
    elements.playPause.classList.remove("is-playing");
    elements.seek.disabled = true;
    setNotationLoadingMessage(summary);
    syncScoreLoadingVisibility();
    showToast(detail, "error");
  }

  function updateTransportHeight() {
    const height = Math.ceil(elements.transport?.getBoundingClientRect().height || 46);
    document.documentElement.style.setProperty("--transport-height", `${height}px`);
  }

  function sensibleShortName(name, index) {
    const trimmed = String(name || "").trim();
    const known = trimmed.match(/^(soprano|alto|tenor|baritone|bass)(?:\s*(\d+))?/iu);
    if (known) {
      const initial = known[1][0].toUpperCase();
      return `${initial}${known[2] || ""}`;
    }
    const words = trimmed.split(/\s+/u).filter(Boolean);
    const initials = words.map((word) => word[0]).join("").toUpperCase();
    return initials.slice(0, 3) || `P${index + 1}`;
  }

  function normalizeParts(rawParts) {
    return (rawParts || []).map((part, index) => {
      const source = typeof part === "string" ? { name: part } : (part || {});
      const override = config.parts?.[index] || {};
      const name = String(override.name || source.name || `Part ${index + 1}`);
      return {
        index,
        id: String(source.id || override.id || `P${index + 1}`),
        name,
        short: String(override.short || source.short || sensibleShortName(name, index)),
        color: String(override.color || config.partColors?.[name] || source.color || partPaint(index)),
      };
    });
  }

  function createDragNumber(button, options) {
    const valueLabel = document.createElement("span");
    valueLabel.className = "drag-number-value";
    button.replaceChildren(valueLabel);
    const values = options.values;
    const initialValue = Number(button.dataset.value);
    const defaultValue = () => typeof options.defaultValue === "function" ? options.defaultValue() : options.defaultValue;
    let value = nearestAllowed(Number.isFinite(initialValue) ? initialValue : defaultValue(), values);
    let pointerId = null;
    let startY = 0;
    let startIndex = 0;
    let dragValues = values;
    let startValue = value;
    let startX = 0;
    let pointerType = "mouse";
    let holdTimer = 0;
    let held = false;
    let suppressTouchContextUntil = 0;

    const clearHold = () => {
      if (holdTimer) window.clearTimeout(holdTimer);
      holdTimer = 0;
    };
    const cancelPointer = () => {
      clearHold();
      const captured = pointerId;
      pointerId = null;
      if (captured !== null && button.hasPointerCapture(captured)) button.releasePointerCapture(captured);
    };

    function interactionValues() {
      const configured = typeof options.stepValues === "function" ? options.stepValues() : values;
      if (configured.includes(value)) return configured;
      return [...configured, value].sort((left, right) => left - right);
    }

    function update(next, emit = true) {
      const nextValue = nearestAllowed(Number(next), values);
      const changed = nextValue !== value;
      value = nextValue;
      button.dataset.value = String(value);
      valueLabel.textContent = options.format(value);
      button.setAttribute("aria-valuenow", String(value));
      button.setAttribute("aria-valuemin", String(values[0]));
      button.setAttribute("aria-valuemax", String(values.at(-1)));
      button.setAttribute("aria-valuetext", options.aria(value));
      if (changed && emit) button.dispatchEvent(new Event("input", { bubbles: true }));
      return value;
    }

    button.setAttribute("role", "spinbutton");
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      cancelPointer();
      pointerId = event.pointerId;
      pointerType = event.pointerType || "mouse";
      startX = event.clientX;
      startY = event.clientY;
      startValue = value;
      held = false;
      dragValues = interactionValues();
      startIndex = dragValues.indexOf(value);
      button.setPointerCapture(pointerId);
      if (options.onHold) holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        held = true;
        suppressTouchContextUntil = performance.now() + 800;
        options.onHold();
      }, 600);
      event.preventDefault();
    });
    button.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !button.hasPointerCapture(pointerId) || held) return;
      const delta = startY - event.clientY;
      const indexDelta = Math.round(delta / (options.pixelsPerStep || 8));
      if (indexDelta !== 0 || Math.hypot(event.clientX - startX, delta) > 8) clearHold();
      // Horizontal displacement is deliberately ignored so a finger can move
      // aside to reveal the value without editing it. Zero vertical
      // displacement remains anchored to the original index, letting a drag
      // move away and return without skipping the starting value.
      update(dragValues[clamp(startIndex + indexDelta, 0, dragValues.length - 1)]);
    });
    const endPointer = (event) => {
      if (event.pointerId !== pointerId) return;
      cancelPointer();
      if (!held && event.type === "pointerup" && startValue !== value) options.onManualChange?.(startValue, value, event.pointerType);
    };
    button.addEventListener("pointerup", endPointer);
    button.addEventListener("pointercancel", endPointer);
    button.addEventListener("lostpointercapture", cancelPointer);
    button.addEventListener("contextmenu", (event) => {
      if (options.onHold && (event.pointerType || pointerType) !== "mouse"
        && (pointerId !== null || performance.now() < suppressTouchContextUntil)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      cancelPointer();
    });
    button.addEventListener("dblclick", () => update(defaultValue()));
    button.addEventListener("keydown", (event) => {
      if (options.onHold && event.shiftKey && event.key === "Enter") {
        cancelPointer();
        event.preventDefault();
        if (!event.repeat) options.onHold();
        return;
      }
      if (event.key === "Escape" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) cancelPointer();
      const before = value;
      const stepValues = interactionValues();
      const index = stepValues.indexOf(value);
      if (["ArrowUp", "ArrowRight"].includes(event.key)) update(stepValues[Math.min(stepValues.length - 1, index + 1)]);
      else if (["ArrowDown", "ArrowLeft"].includes(event.key)) update(stepValues[Math.max(0, index - 1)]);
      else if (event.key === "Home") update(stepValues[0]);
      else if (event.key === "End") update(stepValues.at(-1));
      else if (event.key === "0") update(defaultValue());
      else return;
      event.preventDefault();
      if (event.key !== "0" && before !== value) options.onManualChange?.(before, value, "keyboard");
    });
    update(value, false);
    return { value: () => value, setValue: update };
  }

  function createPanRing(button, options) {
    const initialValue = Number(button.dataset.value);
    const defaultValue = () => typeof options.defaultValue === "function" ? options.defaultValue() : options.defaultValue;
    let value = nearestAllowed(Number.isFinite(initialValue) ? initialValue : defaultValue(), PAN_VALUES);
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startIndex = 0;
    let startValue = value;
    let pointerType = "mouse";
    let holdTimer = 0;
    let feedbackTimer = 0;
    let held = false;
    let suppressContextUntil = 0;

    const clearHold = () => {
      if (holdTimer) window.clearTimeout(holdTimer);
      if (feedbackTimer) window.clearTimeout(feedbackTimer);
      holdTimer = feedbackTimer = 0;
      button.classList.remove("is-holding");
    };
    const cancelPointer = () => {
      clearHold();
      const captured = pointerId;
      pointerId = null;
      if (captured !== null && button.hasPointerCapture(captured)) button.releasePointerCapture(captured);
    };

    function update(next, emit = true) {
      const nextValue = nearestAllowed(Number(next), PAN_VALUES);
      const changed = nextValue !== value;
      value = nextValue;
      const label = value === 0 ? "C" : `${Math.abs(value)}${value < 0 ? "L" : "R"}`;
      const angle = value * 1.35;
      button.dataset.value = String(value);
      button.style.setProperty("--pan-angle", `${angle}deg`);
      button.style.setProperty("--pan-arc-start", `${Math.min(0, angle)}deg`);
      button.style.setProperty("--pan-arc-sweep", `${Math.abs(angle)}deg`);
      button.setAttribute("aria-valuenow", String(value));
      button.setAttribute("aria-valuetext", value === -100
        ? "Hard left"
        : value === 100
          ? "Hard right"
          : value === 0
            ? "Center"
            : `${Math.abs(value)} percent ${value < 0 ? "left" : "right"}`);
      button.dataset.help = `${options.name} pan ${label}. Drag horizontally.`;
      if (changed && emit) button.dispatchEvent(new Event("input", { bubbles: true }));
    }

    button.setAttribute("role", "slider");
    button.setAttribute("aria-orientation", "horizontal");
    button.setAttribute("aria-valuemin", "-100");
    button.setAttribute("aria-valuemax", "100");
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      cancelPointer();
      pointerId = event.pointerId;
      pointerType = event.pointerType || "mouse";
      startX = event.clientX;
      startY = event.clientY;
      startValue = value;
      startIndex = PAN_VALUES.indexOf(value);
      held = false;
      button.setPointerCapture(pointerId);
      if (options.onHold) {
        feedbackTimer = window.setTimeout(() => button.classList.add("is-holding"), 250);
        holdTimer = window.setTimeout(() => {
          clearHold();
          held = true;
          suppressContextUntil = performance.now() + 800;
          options.onHold();
        }, 600);
      }
      event.preventDefault();
    });
    button.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !button.hasPointerCapture(pointerId) || held) return;
      const indexDelta = Math.round((event.clientX - startX) / 4);
      if (indexDelta !== 0 || Math.hypot(event.clientX - startX, event.clientY - startY) > 8) clearHold();
      update(PAN_VALUES[clamp(startIndex + indexDelta, 0, PAN_VALUES.length - 1)]);
    });
    const finish = (event) => {
      if (event.pointerId !== pointerId) return;
      cancelPointer();
      if (!held && event.type === "pointerup" && startValue !== value) options.onManualChange?.(startValue, value, event.pointerType);
    };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
    button.addEventListener("lostpointercapture", cancelPointer);
    button.addEventListener("click", (event) => {
      if (!held) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    button.addEventListener("contextmenu", (event) => {
      if (options.onHold && (event.pointerType || pointerType) !== "mouse"
        && (pointerId !== null || performance.now() < suppressContextUntil)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      cancelPointer();
    });
    button.addEventListener("dblclick", () => { if (!held) update(defaultValue()); });
    button.addEventListener("keydown", (event) => {
      if (options.onHold && event.shiftKey && event.key === "Enter") {
        cancelPointer();
        event.preventDefault();
        if (!event.repeat) options.onHold();
        return;
      }
      if (event.key === "Escape" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) cancelPointer();
      const before = value;
      const index = PAN_VALUES.indexOf(value);
      if (event.key === "ArrowRight") update(PAN_VALUES[Math.min(PAN_VALUES.length - 1, index + 1)]);
      else if (event.key === "ArrowLeft") update(PAN_VALUES[Math.max(0, index - 1)]);
      else if (event.key === "Home") update(PAN_VALUES[0]);
      else if (event.key === "End") update(PAN_VALUES.at(-1));
      else if (event.key === "0") update(defaultValue());
      else return;
      event.preventDefault();
      if (event.key !== "0" && before !== value) options.onManualChange?.(before, value, "keyboard");
    });
    if (options.onHold) {
      window.addEventListener("blur", cancelPointer);
      window.addEventListener("scroll", cancelPointer, true);
      window.addEventListener("pointerdown", (event) => {
        if (pointerId !== null && event.pointerId !== pointerId) cancelPointer();
      }, true);
    }
    update(value, false);
    return { value: () => value, setValue: update };
  }

  class InfinitePager {
    constructor(element, { options, value, placeholder = "" }) {
      if (!element || !Array.isArray(options) || options.length < 2) {
        throw new TypeError("InfinitePager requires an element and at least two options");
      }
      this.element = element;
      this.element.title = "Tap to advance; drag to browse.";
      this.options = options;
      this.placeholder = placeholder;
      const initialIndex = this.indexForValue(value);
      this.unset = initialIndex === null;
      this.index = initialIndex ?? 0;
      this.layers = [];
      this.drag = null;
      this.pendingIndex = null;
      this.snapTimer = null;
      this.events = new AbortController();
      this.snapDuration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100;

      this.element.replaceChildren();
      this.layers = Array.from({ length: 3 }, () => {
        const layer = document.createElement("span");
        layer.className = "practice-part-layer";
        layer.setAttribute("aria-hidden", "true");
        this.element.append(layer);
        return layer;
      });
      this.element.setAttribute("aria-valuemin", "0");
      this.element.setAttribute("aria-valuemax", String(this.options.length - 1));
      this.setTransition("none");
      if (this.unset) this.layoutUnset();
      else this.layout(this.index);
      this.syncAccessibility();
      this.bindEvents();
    }

    indexForValue(value) {
      const index = this.options.findIndex((option) => option.value === value);
      return index >= 0 ? index : null;
    }

    value() { return this.unset ? null : this.options[this.index].value; }

    setValue(value) {
      this.finishPendingAnimation(false);
      const nextIndex = this.indexForValue(value);
      if (nextIndex === null) {
        this.unset = true;
        this.index = 0;
        this.setTransition("none");
        this.layoutUnset();
        this.syncAccessibility();
        return;
      }
      if (this.unset || nextIndex !== this.index) this.commit(nextIndex, false);
    }

    height() { return this.element.clientHeight || 25; }

    wrappedIndex(index) {
      return ((index % this.options.length) + this.options.length) % this.options.length;
    }

    layout(index, offset = 0) {
      const height = this.height();
      const indices = [this.wrappedIndex(index - 1), this.wrappedIndex(index), this.wrappedIndex(index + 1)];
      this.layers.forEach((layer, layerIndex) => {
        this.populateLayer(layer, this.options[indices[layerIndex]]);
        layer.style.transform = `translate3d(0,${offset + (layerIndex - 1) * height}px,0)`;
      });
    }

    layoutUnset(offset = 0) {
      const height = this.height();
      const options = [this.options.at(-1), null, this.options[0]];
      this.layers.forEach((layer, layerIndex) => {
        this.populateLayer(layer, options[layerIndex], layerIndex === 1 ? this.placeholder : undefined);
        layer.style.transform = `translate3d(0,${offset + (layerIndex - 1) * height}px,0)`;
      });
    }

    populateLayer(layer, option, fallbackLabel = "") {
      if (!layer.firstElementChild) {
        const label = document.createElement("span");
        label.className = "practice-part-label";
        const detail = document.createElement("span");
        detail.className = "practice-part-detail";
        layer.append(label, detail);
      }
      const detail = typeof option?.detail === "function" ? option.detail() : option?.detail;
      layer.children[0].textContent = option?.label ?? fallbackLabel;
      layer.children[1].textContent = detail ?? "";
      layer.children[1].hidden = !detail;
      layer.classList.toggle("has-detail", Boolean(detail));
      const color = option?.color;
      layer.classList.toggle("has-option-color", Boolean(color));
      if (color) layer.style.setProperty("--pager-option-color", color);
      else layer.style.removeProperty("--pager-option-color");
    }

    refreshLabels() {
      if (this.drag || this.pendingIndex !== null) return;
      if (this.unset) this.layoutUnset();
      else this.layout(this.index);
    }

    setTransition(value) {
      this.layers.forEach((layer) => { layer.style.transition = value; });
    }

    syncAccessibility() {
      this.element.classList.toggle("is-unset", this.unset);
      if (this.unset) {
        this.element.dataset.value = "";
        this.element.removeAttribute("aria-valuenow");
        this.element.setAttribute("aria-valuetext", this.placeholder);
        return;
      }
      const option = this.options[this.index];
      this.element.dataset.value = option.value ?? "";
      this.element.setAttribute("aria-valuenow", String(this.index));
      this.element.setAttribute("aria-valuetext", option.label);
    }

    commit(index, emit = true) {
      const nextIndex = this.wrappedIndex(index);
      const changed = this.unset || nextIndex !== this.index;
      this.unset = false;
      this.index = nextIndex;
      this.pendingIndex = null;
      this.element.classList.remove("is-paging");
      this.setTransition("none");
      this.layout(this.index);
      this.syncAccessibility();
      if (changed && emit) this.element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    finishPendingAnimation(emit = true) {
      if (this.snapTimer !== null) {
        window.clearTimeout(this.snapTimer);
        this.snapTimer = null;
      }
      if (this.pendingIndex !== null) this.commit(this.pendingIndex, emit);
    }

    animateTo(startIndex, targetOffset, nextIndex) {
      this.finishPendingAnimation();
      this.pendingIndex = this.wrappedIndex(nextIndex);
      this.element.classList.add("is-paging");
      this.setTransition(`transform ${this.snapDuration}ms ease-out`);
      if (this.unset) this.layoutUnset(targetOffset);
      else this.layout(startIndex, targetOffset);
      if (this.snapDuration === 0) {
        this.commit(this.pendingIndex);
        return;
      }
      this.snapTimer = window.setTimeout(() => {
        this.snapTimer = null;
        this.commit(this.pendingIndex);
      }, this.snapDuration);
    }

    step(direction) {
      this.finishPendingAnimation();
      if (this.unset) {
        this.animateTo(this.index, direction > 0 ? -this.height() : this.height(),
          direction > 0 ? 0 : this.options.length - 1);
        return;
      }
      const height = this.height();
      this.animateTo(this.index, direction > 0 ? -height : height, this.index + direction);
    }

    bindEvents() {
      const listenerOptions = { signal: this.events.signal };
      this.element.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || this.drag) return;
        this.finishPendingAnimation();
        this.setTransition("none");
        // startY moves as the wheel wraps; originY stays put so a press can
        // tell whether it was a drag at all.
        this.drag = { index: this.index, offset: 0, pointerId: event.pointerId,
          startY: event.clientY, originY: event.clientY, originX: event.clientX, moved: false, unset: this.unset };
        this.element.classList.add("is-dragging");
        this.element.setPointerCapture(event.pointerId);
        event.preventDefault();
      }, listenerOptions);
      this.element.addEventListener("pointermove", (event) => {
        if (!this.drag || this.drag.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - this.drag.originX, event.clientY - this.drag.originY) > 4) this.drag.moved = true;
        const height = this.height();
        let delta = event.clientY - this.drag.startY;
        if (this.drag.unset) {
          delta = clamp(delta, -height, height);
          this.drag.offset = delta;
          this.layoutUnset(delta);
          event.preventDefault();
          return;
        }
        while (delta <= -height) {
          this.drag.index = this.wrappedIndex(this.drag.index + 1);
          this.drag.startY -= height;
          delta += height;
        }
        while (delta >= height) {
          this.drag.index = this.wrappedIndex(this.drag.index - 1);
          this.drag.startY += height;
          delta -= height;
        }
        this.drag.offset = delta;
        this.layout(this.drag.index, delta);
        event.preventDefault();
      }, listenerOptions);
      this.element.addEventListener("pointerup", (event) => this.release(event), listenerOptions);
      this.element.addEventListener("pointercancel", (event) => this.cancel(event.pointerId), listenerOptions);
      this.element.addEventListener("lostpointercapture", (event) => this.cancel(event.pointerId), listenerOptions);
      this.element.addEventListener("click", (event) => {
        // Pointer taps are handled on release; only synthetic/assistive clicks
        // belong here, otherwise a drag's trailing click would advance again.
        if (event.detail === 0 && !event.pointerType && !this.drag) this.step(1);
      }, listenerOptions);
      window.addEventListener("blur", () => this.cancel(this.drag?.pointerId), listenerOptions);
      this.element.addEventListener("wheel", (event) => {
        if (event.deltaY === 0) return;
        event.preventDefault();
        this.step(event.deltaY > 0 ? 1 : -1);
      }, { passive: false, signal: this.events.signal });
      this.element.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
        event.preventDefault();
        this.step(event.key === "ArrowUp" ? -1 : 1);
      }, listenerOptions);
    }

    release(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const drag = this.drag;
      const height = this.height();
      const delta = event.clientY - drag.startY;
      // Tapping is what people try first, so it moves to the next option
      // rather than doing nothing and leaving the control looking inert.
      if (!drag.moved) {
        this.drag = null;
        this.element.classList.remove("is-dragging");
        if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
        this.step(1);
        event.preventDefault();
        return;
      }
      if (drag.unset) {
        this.drag = null;
        this.element.classList.remove("is-dragging");
        if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
        this.setTransition("none");
        if (Math.abs(delta) > height / 2) this.commit(delta < 0 ? 0 : this.options.length - 1);
        else {
          this.layoutUnset();
          this.syncAccessibility();
        }
        event.preventDefault();
        return;
      }
      const nextIndex = Math.abs(delta) > height / 2 ? drag.index + (delta < 0 ? 1 : -1) : drag.index;
      const targetOffset = nextIndex === drag.index ? 0 : delta < 0 ? -height : height;
      this.drag = null;
      this.element.classList.remove("is-dragging");
      if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
      this.animateTo(drag.index, targetOffset, nextIndex);
      event.preventDefault();
    }

    cancel(pointerId) {
      if (!this.drag || this.drag.pointerId !== pointerId) return;
      this.drag = null;
      this.element.classList.remove("is-dragging");
      this.setTransition("none");
      if (this.unset) this.layoutUnset();
      else this.layout(this.index);
      if (this.element.hasPointerCapture(pointerId)) this.element.releasePointerCapture(pointerId);
    }

    destroy() {
      this.events.abort();
      if (this.snapTimer !== null) window.clearTimeout(this.snapTimer);
      this.snapTimer = null;
      this.drag = null;
      this.pendingIndex = null;
      this.element.classList.remove("is-paging", "is-dragging");
    }
  }

  const tempoControl = createDragNumber(elements.tempo, {
    values: TEMPO_VALUES,
    defaultValue: () => preferenceDefaults().tempo,
    format: (value) => `${value}%`,
    aria: (value) => `${value} percent of written tempo`,
  });
  const metronomeControl = createDragNumber(elements.metronome, {
    values: METRONOME_VALUES,
    defaultValue: () => preferenceDefaults().metronome,
    format: (value) => `${value}%`,
    aria: (value) => `metronome volume ${value} percent`,
  });
  const verticalControl = createDragNumber(elements.verticalScale, {
    values: VERTICAL_VALUES,
    defaultValue: () => preferenceDefaults().vertical,
    format: (value) => `${value}%`,
    aria: (value) => `${value} percent vertical scale`,
  });
  const horizontalControl = createDragNumber(elements.horizontalScale, {
    values: HORIZONTAL_VALUES,
    stepValues: () => scoreView === "bars" ? HORIZONTAL_VALUES : STANDARD_HORIZONTAL_VALUES,
    pixelsPerStep: 4,
    defaultValue: () => preferenceDefaults().horizontal,
    format: (value) => `${value}%`,
    aria: (value) => `${value} percent horizontal scale`,
  });

  function syncPillThumb(group = null) {
    const groups = group ? [group] : [elements.flowToggle, elements.scoreViewToggle];
    groups.forEach((toggle) => {
      const active = toggle?.querySelector(".pill-option.is-active");
      const thumb = toggle?.querySelector(".pill-thumb");
      if (!active || !thumb) return;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.height = `${active.offsetHeight}px`;
      thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    });
  }

  function setFlow(next, { render = true, persist = true } = {}) {
    flow = next === "continuous" ? "continuous" : "wrap";
    elements.flowToggle.querySelectorAll("[data-flow]").forEach((button) => {
      const selected = button.dataset.flow === flow;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    elements.score.classList.toggle("is-continuous", flow === "continuous");
    elements.barScore.classList.toggle("is-continuous", flow === "continuous");
    requestAnimationFrame(() => syncPillThumb(elements.flowToggle));
    if (persist) savePreferences();
    if (render) scheduleRender();
  }

  function setScoreView(next, { render = true, persist = true } = {}) {
    cancelPitchAuditions();
    cancelScoreScrub();
    const previous = scoreView;
    scoreView = next === "bars" ? "bars" : "standard";
    if (scoreView !== "standard") {
      window.clearTimeout(renderTimer);
      renderTimer = 0;
      clearNotationRenderTimeout();
      notationRenderInFlight = false;
      notationRenderQueued = false;
      discardScoreRenderSnapshot();
    } else if (previous !== "standard") {
      notationRenderFailed = false;
      setNotationLoadingMessage();
    }
    elements.scoreViewToggle.querySelectorAll("[data-view]").forEach((button) => {
      const selected = button.dataset.view === scoreView;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    requestAnimationFrame(() => syncPillThumb(elements.scoreViewToggle));
    elements.score.hidden = scoreView !== "standard";
    elements.barScore.hidden = scoreView !== "bars";
    updateMixerAppearance();
    syncScoreLoadingVisibility();
    updateNoteActionLabel();
    requestAnimationFrame(() => {
      renderSelectedPartHighlight();
    });
    if (render) scheduleRender();
    if (persist) savePreferences();
  }

  function scoreWithoutRepeatedLyrics(xml) {
    const documentXml = new DOMParser().parseFromString(xml, "application/xml");
    if (documentXml.querySelector("parsererror")) throw new Error("Repeated lyrics could not be filtered");
    documentXml.querySelectorAll('[data-choir-repeated-lyric="true"]').forEach((lyric) => lyric.remove());
    return new XMLSerializer().serializeToString(documentXml);
  }

  function scoreXmlForDisplayMode() {
    const documentXml = new DOMParser().parseFromString(fullScoreXml, "application/xml");
    if (documentXml.querySelector("parsererror")) throw new Error("Score display options could not be applied");
    if (lyricsMode === "changes") {
      documentXml.querySelectorAll('[data-choir-repeated-lyric="true"]').forEach((lyric) => lyric.remove());
    }
    [...documentXml.getElementsByTagName("*")]
      .filter((element) => element.localName === "rehearsal")
      .forEach((rehearsal) => rehearsal.remove());
    return new XMLSerializer().serializeToString(documentXml);
  }

  function captureNotationReloadAnchor() {
    const cursor = elements.score.querySelector(".at-cursor-bar");
    const anchor = {
      scrollY: window.scrollY,
      scoreScrollLeft: elements.score.scrollLeft,
    };
    if (!cursor) return anchor;
    const bounds = cursor.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return anchor;
    const headerBottom = elements.transport.getBoundingClientRect().bottom;
    anchor.top = clamp(bounds.top, headerBottom + 8, Math.max(headerBottom + 8, window.innerHeight - bounds.height - 20));
    anchor.left = bounds.left;
    return anchor;
  }

  function restoreNotationReloadScrollOffset(anchor) {
    if (!anchor) return;
    automaticScrollUntil = Date.now() + 350;
    window.scrollTo({ top: Math.max(0, Number(anchor.scrollY) || 0), behavior: "auto" });
    elements.score.scrollTo({ left: Math.max(0, Number(anchor.scoreScrollLeft) || 0), behavior: "auto" });
  }

  function restoreNotationReloadAnchor(anchor) {
    const cursor = elements.score.querySelector(".at-cursor-bar");
    if (!cursor) return false;
    const bounds = cursor.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    const headerBottom = elements.transport.getBoundingClientRect().bottom;
    // A freshly loaded score briefly exposes AlphaTab's measure-one cursor.
    // Do not mistake that off-screen stale element for the restored cursor.
    if (bounds.bottom < headerBottom + 2 || bounds.top > window.innerHeight - 2) return false;
    const targetTop = anchor?.top ?? Math.min(window.innerHeight * 0.32, headerBottom + 120);
    const safeTop = clamp(targetTop, headerBottom + 8, Math.max(headerBottom + 8, window.innerHeight - bounds.height - 20));
    automaticScrollUntil = Date.now() + 350;
    window.scrollTo({ top: Math.max(0, window.scrollY + bounds.top - safeTop), behavior: "auto" });
    if (flow === "continuous") {
      const scoreBounds = elements.score.getBoundingClientRect();
      const targetLeft = anchor?.left ?? scoreBounds.left + Math.min(scoreBounds.width * 0.25, 180);
      elements.score.scrollTo({
        left: Math.max(0, elements.score.scrollLeft + bounds.left - targetLeft),
        behavior: "auto",
      });
    }
    playbackDetached = false;
    hidePlaybackReturn();
    return true;
  }

  function finishNotationReloadWhenReady() {
    const pending = pendingNotationReload;
    if (!pending || !pending.playerReady || !pending.renderReady || pending.restoring) return;
    pending.restoring = true;
    selectedScoreTick = pending.selectedTick;
    selectedScorePartIndex = pending.selectedPartIndex;
    if (Number.isInteger(selectedScorePartIndex)) elements.score.dataset.selectedPart = String(selectedScorePartIndex);
    requestAnimationFrame(renderSelectedPartHighlight);

    // Loading new MusicXML makes AlphaTab seek its external-media output to
    // zero. Restore the guide engine itself only after the new score and its
    // player are ready; setting AlphaTab's tick during playerReady is too early
    // and can leave the cursor painted against the previous surface geometry.
    let frame = 0;
    const restoreAfterCursorPaint = () => {
      if (pendingNotationReload !== pending) return;
      frame += 1;
      if (frame === 1) {
        // Restoring the old document offset first causes AlphaTab's lazy
        // renderer to attach the same system before the cursor is repositioned.
        restoreNotationReloadScrollOffset(pending.anchor);
        requestAnimationFrame(restoreAfterCursorPaint);
        return;
      }
      if (frame === 2) {
        // Do not re-enter AlphaTab's external-media position update while its
        // ready/render event is still unwinding.
        engine.seek(engine.secondsAtTick(pending.tick));
        requestAnimationFrame(restoreAfterCursorPaint);
        return;
      }
      if (frame >= 3) {
        if (frame <= 8) restoreNotationReloadScrollOffset(pending.anchor);
        if (frame > 3 && frame % 4 === 0) engine.pushPosition();
      }
      if (frame >= 3 && restoreNotationReloadAnchor(pending.anchor)) {
        pendingNotationReload = null;
        scheduleCursorTrimBurst();
        updateNoteActionLabel();
        if (pending.resume) void engine.startTransport();
        return;
      }
      if (frame < 36) {
        requestAnimationFrame(restoreAfterCursorPaint);
        return;
      }
      restoreNotationReloadScrollOffset(pending.anchor);
      pendingNotationReload = null;
      scheduleCursorTrimBurst();
      updateNoteActionLabel();
      if (pending.resume) void engine.startTransport();
    };
    requestAnimationFrame(restoreAfterCursorPaint);
  }

  function reloadNotationForDisplay() {
    if (!api || !fullScoreXml) return true;
    cancelPitchAuditions();
    cancelScoreScrub();
    const wasPlaying = playing || engine?.preparing;
    const tick = currentScoreTick();
    const anchor = captureNotationReloadAnchor();
    if (wasPlaying) engine.pauseTransport();
    pendingNotationReload = {
      tick,
      selectedTick: tick,
      selectedPartIndex: currentScorePartIndex(),
      anchor,
      resume: wasPlaying,
      playerReady: false,
      renderReady: false,
      restoring: false,
    };
    const tracks = parts.map((_, index) => index).filter((index) => visibleTracks.has(index));
    if (api.load(new TextEncoder().encode(scoreXmlForDisplayMode()), tracks)) return true;
    pendingNotationReload = null;
    if (wasPlaying) void engine.startTransport();
    return false;
  }

  function setLyricsMode(next, { reload = true, persist = true } = {}) {
    const previous = lyricsMode;
    lyricsMode = next === "changes" ? "changes" : "full";
    if (reload && lyricsMode !== previous) {
      if (!reloadNotationForDisplay()) {
        lyricsMode = previous;
        setLyricsMode(previous, { reload: false, persist: false });
        showToast("Lyric display could not be changed", "error");
        return;
      }
      if (scoreView === "bars") scheduleBarRender();
    }
    if (persist) savePreferences();
  }

  function applyMeasureNumberSettings(settings = api?.settings, score = scoreTracks[0]?.score) {
    const notationElement = window.alphaTab?.NotationElement?.BarNumber;
    if (settings?.notation?.elements && notationElement !== undefined) {
      settings.notation.elements.set(notationElement, true);
    }
    const display = window.alphaTab?.model?.BarNumberDisplay;
    const value = display?.AllBars;
    if (score?.stylesheet && value !== undefined) {
      score.stylesheet.barNumberDisplay = value;
      // MusicXML's <measure-numbering> import can set an explicit value on
      // every bar, which takes precedence over the score-wide stylesheet.
      // Normalize those per-bar values so all measure labels survive
      // responsive reflow.
      score.tracks?.forEach((track) => track.staves?.forEach((staff) => {
        staff.bars?.forEach((bar) => { bar.barNumberDisplay = value; });
      }));
    }
  }

  function applyWrittenChordNames(score) {
    const names = new Map((config.writtenChordNames || []).map(mark => [mark.tick, mark.name]));
    if (!names.size) return;
    for (const track of score.tracks) for (const staff of track.staves) {
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
        const name = names.get(beat.absoluteDisplayStart), chord = beat.chord;
        if (!name || !chord || chord.name === name) continue;
        // Display spellings such as Fadd9 must not inherit the importer's F9.
        // A dedicated chord ID avoids renaming a genuinely different chord
        // that the importer happened to put in the same chord-name cache.
        const id = `${beat.chordId}:written:${name}`;
        if (!staff.hasChord(id)) staff.addChord(id,
          Object.assign(Object.create(Object.getPrototypeOf(chord)), chord, {name}));
        beat.chordId = id;
      }
    }
  }

  function applyLyricFontSettings(settings = api?.settings) {
    const notationElement = window.alphaTab?.NotationElement?.EffectLyrics;
    const elementFonts = settings?.display?.resources?.elementFonts;
    const currentFont = notationElement === undefined ? null : elementFonts?.get(notationElement);
    if (currentFont?.withSize) elementFonts.set(notationElement, currentFont.withSize(LYRIC_FONT_SIZE));
  }

  // AlphaTab decides whether to print a dynamic by looking back along the
  // beat's own voice. A MuseScore second voice that first sounds mid-score
  // has no history there, so the staff's prevailing dynamic is printed again
  // (Blake, Autumn m12: a stray "pp"). Dynamics belong to the staff. A lower
  // voice that is sounding speaks for it, and is also the only one whose
  // values can be trusted: the importer stamps one running dynamic on beats
  // in document order, voice 1 before voice 2, so a change late in a bar
  // leaks onto the second voice's earlier beats. Otherwise compare with
  // whatever sounded last on the staff, the lower voice winning a tie.
  function staffDynamicChangesAt(beat) {
    if (typeof writtenDynamicForBeat === "function") return writtenDynamicForBeat(beat) !== undefined;
    const bar = beat.voice.bar;
    if (bar.staff.track.score.stylesheet.hideDynamics || beat.isEmpty || beat.voice.isEmpty || beat.isRest) return false;
    const start = beat.playbackStart;
    const sounds = (other) => !other.isRest && !other.isEmpty;
    for (const voice of bar.voices) {
      if (voice.index < beat.voice.index && voice.beats.some((other) => sounds(other)
        && other.playbackStart <= start && start < other.playbackStart + other.playbackDuration)) return false;
    }
    for (let index = bar.index; index >= 0; index -= 1) {
      const limit = index === bar.index ? start : Infinity;
      let previous = null;
      let previousEnd = -1;
      for (const voice of bar.staff.bars[index].voices) {
        for (const other of voice.beats) {
          if (!sounds(other) || other.playbackStart >= limit) continue;
          const end = Math.min(other.playbackStart + other.playbackDuration, limit);
          if (end > previousEnd) { previous = other; previousEnd = end; }
        }
      }
      if (previous) return beat.dynamics !== previous.dynamics;
    }
    return true;
  }

  function installStaffLevelDynamics() {
    const dynamics = window.alphaTab?.NotationElement?.EffectDynamics;
    for (const factory of window.alphaTab?.Environment?.defaultRenderers ?? []) {
      for (const band of factory.effectBands ?? []) {
        if (band?.effect?.notationElement !== dynamics || typeof band.effect.shouldCreateGlyph !== "function") continue;
        band.effect.shouldCreateGlyph = (_settings, beat) => staffDynamicChangesAt(beat);
      }
    }
  }

  function installLowerVoiceRestPlacement() {
    const installed = Symbol.for("melete.lowerVoiceRestPlacement");
    for (const factory of window.alphaTab.Environment.defaultRenderers) {
      if (factory.staffId !== "score" || factory[installed]) continue;
      const create = factory.create;
      factory.create = function(...args) {
        const renderer = create.apply(this, args);
        const helper = renderer.collisionHelper;
        const placeRest = helper.applyRestCollisionOffset;
        helper.applyRestCollisionOffset = function(beat, y, step) {
          if (beat.isRest && beat.voice.index === 1 &&
              renderer.getBeatDirection(beat) === window.alphaTab.rendering.BeamDirection.Down) {
            // AlphaTab 1.8.4 forces voice 2 upward regardless of stem direction.
            // Use its lower-side collision branch without changing the score voice.
            const voice = Object.create(beat.voice, {index: {value: 2}});
            const layoutBeat = Object.create(beat, {voice: {value: voice}});
            return placeRest.call(this, layoutBeat, y, step);
          }
          return placeRest.call(this, beat, y, step);
        };
        return renderer;
      };
      factory[installed] = true;
    }
  }

  function installNotationFormatting() {
    const alpha = window.alphaTab;
    const installed = Symbol.for("melete.notationFormatting");
    const view = (source, key, value) => Object.create(source, {[key]: {value}});
    for (const factory of alpha.Environment.defaultRenderers) {
      for (const band of factory.effectBands || []) {
        const effect = band.effect;
        if ([alpha.NotationElement.EffectMarker, alpha.NotationElement.EffectChordNames].includes(effect.notationElement)) {
          Object.defineProperty(effect, "canShareBand", {value: false, configurable: true});
        }
        if (effect.notationElement === alpha.NotationElement.EffectMarker && !effect[installed]
          && typeof effect.createNewGlyph === "function") {
          const create = effect.createNewGlyph;
          effect.createNewGlyph = function(renderer, beat) {
            const glyph = create.call(this, renderer, beat);
            glyph.font = glyph.font.withSize(18);
            glyph.font.weight = alpha.model.FontWeight.Bold;
            glyph.font.style = alpha.model.FontStyle.Plain;
            glyph.textBaseline = alpha.platform.TextBaseline.Top;
            const layout = glyph.doLayout, paint = glyph.paint;
            glyph.doLayout = function() {
              this.width = this.height = 0;
              layout.call(this);
              this.width += 12;
              this.height += 8;
            };
            glyph.paint = function(x, y, canvas) {
              const left = x + this.x, top = y + this.y;
              const right = left + this.width, bottom = top + this.height, radius = 3;
              const width = canvas.lineWidth;
              canvas.lineWidth = 1;
              canvas.beginGroup("section-heading");
              canvas.beginPath();
              canvas.moveTo(left + radius, top);
              canvas.lineTo(right - radius, top);
              canvas.quadraticCurveTo(right, top, right, top + radius);
              canvas.lineTo(right, bottom - radius);
              canvas.quadraticCurveTo(right, bottom, right - radius, bottom);
              canvas.lineTo(left + radius, bottom);
              canvas.quadraticCurveTo(left, bottom, left, bottom - radius);
              canvas.lineTo(left, top + radius);
              canvas.quadraticCurveTo(left, top, left + radius, top);
              canvas.stroke();
              paint.call(this, x + 6, y + 4, canvas);
              canvas.endGroup();
              canvas.lineWidth = width;
            };
            return glyph;
          };
          effect[installed] = true;
        }
        if (effect.notationElement !== alpha.NotationElement.EffectTempo || effect[installed]) continue;
        const create = effect.createNewGlyph;
        effect.createNewGlyph = function(renderer, beat) {
          // Round the rendering view only, never the timing used by playback.
          const master = beat.voice.bar.masterBar;
          const displayMaster = view(master, "tempoAutomations", master.tempoAutomations.map(mark =>
            view(mark, "value", Number(mark.value.toFixed(2)))));
          return create.call(this, renderer, view(beat, "voice",
            view(beat.voice, "bar", view(beat.voice.bar, "masterBar", displayMaster))));
        };
        effect[installed] = true;
      }
    }
  }

  function createLeftEdgeCursorHandler(alpha, player) {
    const systems = new WeakMap();
    const restNames = {1: "RestWhole", 2: "RestHalf", 4: "RestQuarter", 8: "Rest8th",
      16: "Rest16th", 32: "Rest32nd", 64: "Rest64th", 128: "Rest128th", 256: "Rest256th"};
    function columns(bounds) {
      const system = bounds.barBounds.masterBarBounds.staffSystemBounds;
      if (systems.has(system)) return systems.get(system);
      const groups = new Map();
      for (const master of system.bars) for (const bar of master.bars) for (const beat of bar.beats) {
        const center = beat.onNotesX;
        if (!Number.isFinite(center)) continue;
        const notes = (beat.notes || []).map(note => note.noteHeadBounds?.x).filter(Number.isFinite);
        let left = notes.length ? Math.min(...notes) : null;
        if (left === null && beat.beat.isRest) {
          const full = beat.beat.isFullBarRest;
          const symbol = alpha.model.MusicFontSymbol[full ? "RestWhole" : restNames[beat.beat.duration]];
          const width = player.settings.display.resources.engravingSettings.glyphWidths.get(symbol);
          if (Number.isFinite(width)) left = (full ? beat.realBounds.x + beat.realBounds.w / 2 : center)
            - width * player.settings.display.scale / 2;
        }
        if (!Number.isFinite(left)) continue;
        // At a shared onset, a sounding note wins over another part's full-bar rest.
        const key = `${master.index}:${beat.beat.absoluteDisplayStart}`;
        const existing = groups.get(key);
        if (!existing || (notes.length && !existing.hasNotes)) groups.set(key, {center, left, hasNotes: !!notes.length});
        else if (!!notes.length === existing.hasNotes) existing.left = Math.min(existing.left, left);
      }
      const result = [...groups.values()].sort((a, b) => a.center - b.center);
      systems.set(system, result);
      return result;
    }
    function position(bounds, x) {
      const points = columns(bounds);
      if (!points.length) return x;
      let previous = points[0];
      if (x <= previous.center) return previous.left + x - previous.center;
      for (const next of points.slice(1)) {
        if (x <= next.center && next.center > previous.center) {
          const ratio = (x - previous.center) / (next.center - previous.center);
          return previous.left + (next.left - previous.left) * ratio;
        }
        previous = next;
      }
      const end = bounds.barBounds.masterBarBounds.staffSystemBounds.realBounds;
      const right = Math.max(previous.center + 1, end.x + end.w);
      const ratio = Math.min(1, (x - previous.center) / (right - previous.center));
      return previous.left + (right - previous.left) * ratio;
    }
    return {
      onAttach() {}, onDetach() {},
      placeBarCursor(cursor, bounds) {
        const box = bounds.barBounds.masterBarBounds.visualBounds;
        cursor.setBounds(box.x, box.y, box.w, box.h);
      },
      placeBeatCursor(cursor, bounds, currentX) {
        const x = position(bounds, currentX), box = bounds.barBounds.masterBarBounds.visualBounds;
        cursor.transitionToX(0, x);
        cursor.setBounds(x, box.y, 1, box.h);
      },
      transitionBeatCursor(cursor, bounds, currentX, endX, duration, mode) {
        const start = position(bounds, currentX), end = position(bounds, endX);
        const factor = mode === alpha.midi.MidiTickLookupFindBeatResultCursorMode.ToNextBext ? 2 : 1;
        cursor.transitionToX(duration * factor, start + (end - start) * factor);
      },
    };
  }

  function installWrittenDirections(xml, division) {
    const alpha = window.alphaTab;
    const elements = alpha.NotationElement;
    const documentXml = new DOMParser().parseFromString(xml, "application/xml");
    const expressions = [], equations = [];
    const children = (node, name) => [...node.children].filter(child => child.localName === name);
    const number = (node, name, fallback = 0) => Number(children(node, name)[0]?.textContent ?? fallback);
    const noteSymbol = {quarter: 0xECA5, eighth: 0xECA7, half: 0xECA3, whole: 0xECA2, '16th': 0xECA9};
    const parts = children(documentXml.documentElement, "part");
    parts.forEach((part, track) => {
      let divisions = 1;
      children(part, "measure").forEach((measure, bar) => {
        let position = 0;
        for (const node of measure.children) {
          if (node.localName === "attributes") divisions = number(node, "divisions", divisions);
          if (node.localName === "backup") position -= number(node, "duration") / divisions;
          if (node.localName === "forward") position += number(node, "duration") / divisions;
          if (node.localName === "note" && !children(node, "chord").length && !children(node, "grace").length) {
            position += number(node, "duration") / divisions;
          }
          if (node.localName !== "direction") continue;
          const at = position + number(node, "offset") / divisions;
          const address = {track, staff: number(node, "staff", 1) - 1, bar, at,
            placement: node.getAttribute("placement") === "above" ? "above" : "below"};
          for (const type of children(node, "direction-type")) {
            for (const dynamic of children(type, "dynamics")) {
              const value = alpha.model.DynamicValue[dynamic.firstElementChild?.localName.toUpperCase()];
              if (value !== undefined) expressions.push({...address, dynamic: value});
            }
            for (const wedge of children(type, "wedge")) {
              expressions.push({...address, wedge: wedge.getAttribute("type"), number: wedge.getAttribute("number") || "1"});
            }
            for (const metronome of children(type, "metronome")) {
              const notes = [];
              for (const item of metronome.children) {
                if (item.localName === "beat-unit" && noteSymbol[item.textContent]) {
                  notes.push({symbol: noteSymbol[item.textContent], dots: 0});
                } else if (item.localName === "beat-unit-dot" && notes.length) notes.at(-1).dots++;
              }
              if (notes.length === 2) equations.push({...address, notes});
            }
          }
          // MuseScore sometimes exports a metric equation as SMuFL words plus
          // an empty metronome element. Recover only the explicit note equation.
          const words = [...node.querySelectorAll("direction-type > words")].map(word => word.textContent).join("");
          const match = words.match(/^\s*([\uECA2-\uECAF])(\uECB7*)\s*=\s*([\uECA2-\uECAF])(\uECB7*)(?:\s*\([\uECA2-\uECAF]\s*=\s*[\d.]+\))?/);
          if (match) equations.push({...address, importedText: match[0], notes: [
            {symbol: match[1].codePointAt(0), dots: match[2].length},
            {symbol: match[3].codePointAt(0), dots: match[4].length},
          ]});
        }
      });
    });

    let directions = new WeakMap();
    const source = alpha.Environment.defaultRenderers.find(factory => factory.staffId === "score");
    const dynamicBand = source.effectBands.find(band => band.effect.notationElement === elements.EffectDynamics);
    const hairpinBand = source.effectBands.find(band => band.effect.notationElement === elements.EffectCrescendo);
    if (expressions.length && dynamicBand && hairpinBand) {
      writtenDynamicForBeat = beat => {
        const entry = directions.get(beat);
        return entry?.above?.dynamic ?? entry?.below?.dynamic;
      };
      const nativeDynamic = dynamicBand.effect.createNewGlyph.bind(dynamicBand.effect);
      const nativeHairpin = hairpinBand.effect.createNewGlyph.bind(hairpinBand.effect);
      const aboveMode = source.effectBands.find(band => band.effect.notationElement === elements.EffectFermata).mode;
      source.effectBands = source.effectBands.filter(band => band !== dynamicBand && band !== hairpinBand);
      for (const placement of ["above", "below"]) {
        const effect = Object.create(hairpinBand.effect, {
          effectId: {value: `melete.expressions.${placement}`},
          canShareBand: {value: false},
        });
        effect.isWrittenExpression = true;
        effect.isDynamicVisible = () => true;
        effect.shouldCreateGlyph = (_settings, beat) => {
          const info = directions.get(beat)?.[placement];
          return !beat.voice.bar.staff.track.score.stylesheet.hideDynamics &&
            Boolean(info?.span || (info?.dynamic !== undefined && effect.isDynamicVisible(beat)));
        };
        effect.canExpand = (left, right) => {
          const a = directions.get(left)?.[placement], b = directions.get(right)?.[placement];
          return Boolean(a?.span && a.span === b?.span);
        };
        effect.createNewGlyph = (renderer, beat) => {
          const info = directions.get(beat)[placement];
          const glyph = nativeHairpin(renderer, Object.create(beat, {crescendo: {value: info.span?.type || 0}}));
          const dynamic = info.dynamic === undefined || !effect.isDynamicVisible(beat) ? null : nativeDynamic(renderer,
            Object.create(beat, {dynamics: {value: info.dynamic}}));
          glyph.writtenDynamic = dynamic;
          const layout = glyph.doLayout, paint = glyph.paint;
          glyph.doLayout = function() {
            layout.call(this);
            this.height = this.renderer.smuflMetrics.glyphHeights.get(alpha.model.MusicFontSymbol.DynamicForte);
            if (dynamic) { dynamic.renderer = this.renderer; dynamic.doLayout(); }
          };
          glyph.paint = function(x, y, canvas) {
            if (info.span) paint.call(this, x, y, canvas);
            if (dynamic) {
              dynamic.x = this.x;
              dynamic.y = this.y;
              canvas.beginGroup(`written-dynamic written-${placement} b${beat.id}`);
              dynamic.paint(x, y, canvas);
              canvas.endGroup();
            }
          };
          glyph.paintGrouped = function(x, y, end, canvas) {
            const metrics = this.renderer.smuflMetrics;
            let start = x + this.x;
            if (dynamic) start += dynamic.width / 2 + 8;
            end -= metrics.glyphWidths.get(alpha.model.MusicFontSymbol.NoteheadBlack) / 2;
            const origin = x - this.renderer.x;
            for (let bar = this.renderer; bar && bar.staff === this.renderer.staff; bar = bar.nextRenderer) {
              for (const voice of bar.bar.voices) {
                const band = (placement === "above" ? bar.topEffects : bar.bottomEffects).getBand(voice, effect.effectId);
                for (const mark of band?.iterateAllGlyphs() || []) {
                  const center = origin + bar.x + mark.x;
                  if (mark.writtenDynamic && center > start) end = Math.min(end, center - mark.writtenDynamic.width / 2 - 6);
                }
              }
              if (origin + bar.x + bar.width > end + 50) break;
            }
            if (end <= start) return;
            const center = y + this.y + this.height / 2;
            const aperture = metrics.glyphHeights.get(alpha.model.MusicFontSymbol.DynamicCrescendoHairpin) / 2;
            const opens = info.span.type === alpha.model.CrescendoType.Crescendo;
            const lineWidth = canvas.lineWidth;
            canvas.lineWidth = metrics.hairpinThickness;
            canvas.beginGroup(`written-hairpin written-${placement} b${beat.id}`);
            canvas.beginPath();
            canvas.moveTo(start, center - (opens ? 0 : aperture));
            canvas.lineTo(end, center - (opens ? aperture : 0));
            canvas.moveTo(start, center + (opens ? 0 : aperture));
            canvas.lineTo(end, center + (opens ? aperture : 0));
            canvas.stroke();
            canvas.endGroup();
            canvas.lineWidth = lineWidth;
          };
          return glyph;
        };
        source.effectBands.push({effect, mode: placement === "above" ? aboveMode : dynamicBand.mode});
      }
    }

    const tempoEffects = new Set();
    for (const factory of alpha.Environment.defaultRenderers) for (const band of factory.effectBands || []) {
      if (band.effect.notationElement !== elements.EffectTempo || tempoEffects.has(band.effect)) continue;
      tempoEffects.add(band.effect);
      const create = band.effect.createNewGlyph;
      band.effect.createNewGlyph = function(renderer, beat) {
        const glyph = create.call(this, renderer, beat);
        const master = beat.voice.bar.masterBar;
        const matching = equations.filter(mark => mark.bar === master.index);
        if (!matching.length) return glyph;
        glyph.paint = function(x, y, canvas) {
          const metrics = this.renderer.smuflMetrics, resources = this.renderer.resources;
          const scale = metrics.tempoNoteScale;
          const oldFont = canvas.font, oldBaseline = canvas.textBaseline, oldAlign = canvas.textAlign;
          canvas.font = resources.elementFonts.get(elements.EffectMarker);
          canvas.textBaseline = 3; // AlphaTab TextBaseline.Alphabetic.
          canvas.textAlign = 0; // AlphaTab TextAlign.Left.
          const baseline = y + this.y + this.height + metrics.glyphBottom.get(0xECA5) * scale;
          for (const mark of matching) {
            canvas.beginGroup(`metric-equation metric-m${master.index + 1}`);
            let cursor = x + this.renderer.getRatioPositionX(mark.at * division / master.calculateDuration());
            const drawNote = note => {
              canvas.fillMusicFontSymbol(cursor, baseline, scale, note.symbol, false);
              cursor += (metrics.glyphWidths.get(note.symbol) ?? metrics.glyphWidths.get(0xECA5)) * scale;
              for (let dot = 0; dot < note.dots; dot++) {
                cursor += 2;
                canvas.fillMusicFontSymbol(cursor, baseline, scale, 0xECB7, false);
                cursor += metrics.glyphWidths.get(0xECB7) * scale;
              }
            };
            drawNote(mark.notes[0]);
            const equals = " = ";
            canvas.fillText(equals, cursor, baseline);
            cursor += canvas.measureText(equals).width;
            drawNote(mark.notes[1]);
            canvas.endGroup();
          }
          canvas.font = oldFont; canvas.textBaseline = oldBaseline; canvas.textAlign = oldAlign;
        };
        return glyph;
      };
    }

    return score => {
      directions = new WeakMap();
      const at = mark => score.masterBars[mark.bar].start + mark.at * division;
      const spans = [], open = new Map();
      for (const mark of expressions) {
        if (!mark.wedge) continue;
        const key = `${mark.track}:${mark.staff}:${mark.number}`;
        if (["crescendo", "diminuendo"].includes(mark.wedge)) {
          open.set(key, {...mark, start: at(mark), type: mark.wedge === "crescendo" ? 1 : 2});
        } else if (mark.wedge === "stop" && open.has(key)) {
          spans.push({...open.get(key), end: at(mark)}); open.delete(key);
        }
      }
      for (const track of score.tracks) for (const staff of track.staves) {
        const marks = expressions.filter(mark => mark.track === track.index && mark.staff === staff.index && mark.dynamic !== undefined);
        const wedges = spans.filter(mark => mark.track === track.index && mark.staff === staff.index);
        for (const bar of staff.bars) {
          const seen = new Set();
          for (const voice of bar.voices) for (const beat of voice.beats) {
            const tick = bar.masterBar.start + beat.playbackStart;
            if (seen.has(tick)) continue;
            seen.add(tick);
            const entry = {};
            for (const mark of marks.filter(mark => Math.abs(at(mark) - tick) < 0.01)) {
              (entry[mark.placement] ||= {}).dynamic = mark.dynamic;
            }
            // A staff-wide wedge belongs to one voice, not every interleaved
            // beat of divisi. Otherwise lower-voice pickups create extra wedges.
            for (const span of wedges.filter(span => voice.index === 0 && span.start <= tick && tick < span.end)) {
              (entry[span.placement] ||= {}).span = span;
            }
            if (Object.keys(entry).length) directions.set(beat, entry);
          }
        }
      }
      // Remove only the duplicated word-form equation; its music-font version
      // now occupies the system's native tempo band, whichever parts are shown.
      for (const mark of equations) for (const track of score.tracks) for (const staff of track.staves) {
        for (const voice of staff.bars[mark.bar]?.voices || []) for (const beat of voice.beats) {
          if (beat.text && mark.importedText) beat.text = beat.text.replace(mark.importedText, "").trim();
        }
      }
    };
  }

  function demoVideoAddress(value) {
    try {
      const address = new URL(String(value || ""));
      return address.protocol === "https:" || address.protocol === "http:" ? address.href : "";
    } catch {
      return "";
    }
  }

  function preferenceDefaults() {
    const defaults = config.defaults || {};
    let practicePart = null;
    if (Number.isInteger(defaults.practicePart) && defaults.practicePart >= 0 && defaults.practicePart < parts.length) {
      practicePart = defaults.practicePart;
    } else if (typeof defaults.practicePart === "string") {
      const wanted = defaults.practicePart.trim().toLocaleLowerCase();
      const match = parts.findIndex((part) => [part.name, part.short, part.id].some((value) => String(value).toLocaleLowerCase() === wanted));
      if (match >= 0) practicePart = match;
    }
    return {
      tempo: nearestAllowed(Number(defaults.tempo) || 100, TEMPO_VALUES),
      metronome: nearestAllowed(Number(defaults.metronome) || 0, METRONOME_VALUES),
      vertical: nearestAllowed(Number(defaults.vertical) || (window.matchMedia("(max-width: 600px)").matches ? 70 : 100), VERTICAL_VALUES),
      horizontal: nearestAllowed(Number(defaults.horizontal) || 100, HORIZONTAL_VALUES),
      flow: defaults.flow === "continuous" ? "continuous" : "wrap",
      scoreView: defaults.scoreView === "bars" ? "bars" : "standard",
      lyrics: defaults.lyrics === "changes" ? "changes" : "full",
      practicePart,
      volumes: parts.map((_, index) => nearestAllowed(clamp(Number(defaults.volumes?.[index] ?? 100), 0, 150), VOLUME_VALUES)),
      pans: parts.map((_, index) => nearestAllowed(clamp(Number(defaults.pans?.[index] ?? 0), -100, 100), PAN_VALUES)),
    };
  }

  function captureSettingsState() {
    return {
      tempo: tempoControl.value(),
      metronome: metronomeControl.value(),
      vertical: verticalControl.value(),
      horizontal: horizontalControl.value(),
      flow,
      scoreView,
      lyrics: lyricsMode,
      practicePart: practicePartIndex,
      practiceDivisi: [...practiceDivisi],
      visible: parts.map((_, index) => visibleTracks.has(index)),
      audible: parts.map((_, index) => audibleTracks.has(index)),
      volumes: [...trackVolumes],
      pans: [...trackPans],
      practiceMixMode: activePracticeMix,
      practiceMixPart: practiceMixPartIndex,
      practiceMixUndo: practiceMixUndo ? {
        audible: [...practiceMixUndo.audible],
        volumes: [...practiceMixUndo.volumes],
      } : null,
      loopStart: loopStartMeasure,
      loopEnd: loopEndMeasure,
    };
  }

  function cloneSettingsState(state) {
    return {
      ...state,
      visible: [...state.visible],
      practiceDivisi: [...(state.practiceDivisi || [])],
      audible: [...state.audible],
      volumes: [...state.volumes],
      pans: [...state.pans],
      practiceMixUndo: state.practiceMixUndo ? {
        audible: [...state.practiceMixUndo.audible],
        volumes: [...state.practiceMixUndo.volumes],
      } : null,
    };
  }

  function restorePracticeMixInState(state) {
    const snapshot = state.practiceMixUndo;
    if (snapshot) {
      state.audible = [...snapshot.audible];
      state.volumes = [...snapshot.volumes];
    }
    state.practiceMixMode = null;
    state.practiceMixPart = null;
    state.practiceMixUndo = null;
  }

  function applySettingsState(state) {
    shortcutHints.clear();
    hideShortcutTip();
    const previousVisible = parts.map((_, index) => visibleTracks.has(index));
    const previousFlow = flow;
    const previousScoreView = scoreView;
    const previousLyrics = lyricsMode;
    const previousVertical = verticalControl.value();
    const previousHorizontal = horizontalControl.value();
    visibleTracks.clear();
    state.visible.forEach((visible, index) => { if (visible) visibleTracks.add(index); });
    if (!visibleTracks.size && parts.length) visibleTracks.add(0);
    audibleTracks.clear();
    state.audible.forEach((audible, index) => { if (audible) audibleTracks.add(index); });
    trackVolumes = state.volumes.map((value) => nearestAllowed(clamp(Number(value), 0, 150), VOLUME_VALUES));
    trackPans = state.pans.map((value) => nearestAllowed(clamp(Number(value), -100, 100), PAN_VALUES));
    practicePartIndex = Number.isInteger(state.practicePart) ? state.practicePart : null;
    practiceDivisi = normalizePracticeDivisi(state.practiceDivisi);
    activePracticeMix = ["learn", "check"].includes(state.practiceMixMode) ? state.practiceMixMode : null;
    practiceMixPartIndex = activePracticeMix ? state.practiceMixPart ?? practicePartIndex : null;
    practiceMixUndo = normalizePracticeMixUndo(state.practiceMixUndo);
    loopStartMeasure = Number.isInteger(state.loopStart) ? state.loopStart : null;
    loopEndMeasure = Number.isInteger(state.loopEnd) ? state.loopEnd : null;
    tempoControl.setValue(state.tempo, false);
    metronomeControl.setValue(state.metronome, false);
    verticalControl.setValue(state.vertical, false);
    setFlow(state.flow, { render: false, persist: false });
    setScoreView(state.scoreView, { render: false, persist: false });
    horizontalControl.setValue(state.horizontal, false);
    setLyricsMode(state.lyrics, { reload: false, persist: false });
    volumeControls.forEach((control, index) => control.setValue(trackVolumes[index], false));
    panControls.forEach((control, index) => control.setValue(trackPans[index], false));
    practicePartPager?.setValue(practicePartIndex);
    updateMixerAppearance();
    updateLoopState();
    engine?.setMetronome(metronomeControl.value());
    if (api) api.playbackSpeed = tempoControl.value() / 100;
    updateNoteActionLabel();
    savePreferences();
    if (lyricsMode !== previousLyrics) {
      reloadNotationForDisplay();
      if (scoreView === "bars") scheduleBarRender();
    }
    else {
      const renderRelevantChanged = flow !== previousFlow
        || scoreView !== previousScoreView
        || verticalControl.value() !== previousVertical
        || horizontalControl.value() !== previousHorizontal
        || parts.some((_, index) => visibleTracks.has(index) !== previousVisible[index])
        || lyricsMode !== previousLyrics;
      if (renderRelevantChanged) scheduleRender();
      else renderPitchTrace();
    }
  }

  function performScopedReset(label, mutate, beforeOverride = null) {
    const before = beforeOverride ? cloneSettingsState(beforeOverride) : captureSettingsState();
    const after = captureSettingsState();
    mutate(after, preferenceDefaults());
    if (JSON.stringify(after) === JSON.stringify(before)) {
      showToast(`${label} is already at its default`);
      return;
    }
    applySettingsState(after);
    showToast(`${label} reset`, "", () => {
      applySettingsState(before);
      showToast(`${label} restored`);
    });
  }

  function registerResetTarget(element, label, mutate, { labelTarget = false, cancelActive = null, holdToReset = true } = {}) {
    if (!element || element.dataset.resetBound === "true") return;
    element.dataset.resetBound = "true";
    element.dataset.resettable = "true";
    if (labelTarget) {
      element.dataset.resetLabel = "true";
      if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
    }
    element.setAttribute("aria-description", holdToReset
      ? `Right-click, long-press, or press Shift+F10 to reset ${label}`
      : `Right-click or press Shift+F10 to reset ${label}`);
    // The same news for everyone else: help mode adds this to the control's own
    // tooltip, so the gesture is not something only a screen reader is told.
    element.dataset.resetScope = label;
    element.dataset.resetHold = String(holdToReset);

    let holdTimer = 0;
    let holdPointerId = null;
    let holdX = 0;
    let holdY = 0;
    let holdSnapshot = null;
    let suppressClickUntil = 0;
    let suppressContextUntil = 0;
    const clearHold = () => {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
      holdPointerId = null;
      holdSnapshot = null;
    };
    const reset = (snapshot = null) => {
      if (element.dataset.mixerRow) learnShortcut("reset-row");
      performScopedReset(label, mutate, snapshot);
    };

    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() < suppressContextUntil) return;
      const snapshot = holdSnapshot;
      const pointerId = holdPointerId;
      if (snapshot) {
        suppressClickUntil = performance.now() + 800;
        suppressContextUntil = performance.now() + 800;
        cancelActive?.(pointerId);
      }
      clearHold();
      reset(snapshot);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      suppressContextUntil = performance.now() + 500;
      reset();
    });
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.pointerType === "mouse" || !holdToReset) return;
      clearHold();
      holdPointerId = event.pointerId;
      holdX = event.clientX;
      holdY = event.clientY;
      holdSnapshot = captureSettingsState();
      holdTimer = window.setTimeout(() => {
        const snapshot = holdSnapshot;
        const pointerId = holdPointerId;
        holdTimer = 0;
        suppressClickUntil = performance.now() + 800;
        suppressContextUntil = performance.now() + 800;
        cancelActive?.(pointerId);
        reset(snapshot);
      }, 600);
    }, true);
    element.addEventListener("pointermove", (event) => {
      if (event.pointerId !== holdPointerId) return;
      if (Math.hypot(event.clientX - holdX, event.clientY - holdY) > 8) clearHold();
    }, true);
    element.addEventListener("pointerup", clearHold, true);
    element.addEventListener("pointercancel", clearHold, true);
    element.addEventListener("click", (event) => {
      if (performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function attachHoldReset(button, activate, reset, label) {
    let gesture = null;
    let timer = 0;
    let feedback = 0;
    let suppressClick = false;
    button.classList.add("hold-reset");
    button.setAttribute("aria-description", `Hold or press Delete to clear ${label}`);
    const clearTimers = () => {
      window.clearTimeout(timer);
      window.clearTimeout(feedback);
      button.classList.remove("is-holding");
    };
    const cancel = () => {
      if (!gesture) return;
      suppressClick = true;
      clearTimers();
      const id = gesture.id;
      gesture = null;
      if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || button.disabled) return;
      if (gesture) { cancel(); return; }
      suppressClick = false;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
      button.setPointerCapture(event.pointerId);
      feedback = window.setTimeout(() => button.classList.add("is-holding"), 250);
      timer = window.setTimeout(() => {
        suppressClick = true;
        clearTimers();
        reset();
      }, 600);
    });
    button.addEventListener("pointermove", (event) => {
      if (gesture?.id === event.pointerId
        && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) cancel();
    });
    button.addEventListener("pointerup", (event) => {
      if (gesture?.id !== event.pointerId) return;
      clearTimers();
      gesture = null;
    });
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("lostpointercapture", cancel);
    button.addEventListener("contextmenu", (event) => { event.preventDefault(); cancel(); });
    window.addEventListener("blur", cancel);
    button.addEventListener("click", (event) => {
      if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
      activate();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") suppressClick = false;
      if (!["Backspace", "Delete"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      reset();
    });
  }

  function registerStaticResetTargets() {
    const resetAllParts = (state, defaults) => {
      state.practiceDivisi = parts.map(() => null);
      state.visible = parts.map(() => true);
      state.audible = parts.map(() => true);
      state.volumes = [...defaults.volumes];
      state.pans = [...defaults.pans];
      state.practiceMixMode = null;
      state.practiceMixUndo = null;
    };
    const resetPractice = (state, defaults) => {
      restorePracticeMixInState(state);
      state.practicePart = defaults.practicePart;
      state.practiceDivisi = parts.map(() => null);
      state.tempo = defaults.tempo;
      state.metronome = defaults.metronome;
      state.loopStart = null;
      state.loopEnd = null;
    };
    const resetDisplay = (state, defaults) => {
      state.scoreView = defaults.scoreView;
      state.flow = defaults.flow;
      state.vertical = defaults.vertical;
      state.horizontal = defaults.horizontal;
      state.lyrics = defaults.lyrics;
    };

    registerResetTarget(document.getElementById("partsLabel"), "Parts", resetAllParts, { labelTarget: true });
    registerResetTarget(document.getElementById("practiceLabel"), "Practice", resetPractice, { labelTarget: true });
    registerResetTarget(document.getElementById("displayLabel"), "Display", resetDisplay, { labelTarget: true });
    registerResetTarget(elements.practicePart, "practice part", (state, defaults) => {
      restorePracticeMixInState(state);
      state.practicePart = defaults.practicePart;
    }, { cancelActive: (pointerId) => practicePartPager?.cancel(pointerId) });
    registerResetTarget(elements.tempo, "Speed", (state, defaults) => { state.tempo = defaults.tempo; });
    registerResetTarget(elements.metronome, "metronome volume", (state, defaults) => { state.metronome = defaults.metronome; });
    registerResetTarget(elements.loopStart, "loop start", (state) => { state.loopStart = null; }, { holdToReset: false });
    registerResetTarget(elements.loopEnd, "loop end", (state) => { state.loopEnd = null; }, { holdToReset: false });
    registerResetTarget(elements.flowToggle, "Scroll", (state, defaults) => { state.flow = defaults.flow; });
    registerResetTarget(elements.verticalScale, "vertical scale", (state, defaults) => { state.vertical = defaults.vertical; });
    registerResetTarget(elements.horizontalScale, "horizontal scale", (state, defaults) => { state.horizontal = defaults.horizontal; });
    registerResetTarget(elements.scoreViewToggle, "Score view", (state, defaults) => { state.scoreView = defaults.scoreView; });

    registerResetTarget(document.querySelector(".practice-speed > span"), "Speed", (state, defaults) => { state.tempo = defaults.tempo; }, { labelTarget: true });
    registerResetTarget(document.querySelector(".practice-metronome-volume > span"), "metronome volume", (state, defaults) => { state.metronome = defaults.metronome; }, { labelTarget: true });
    registerResetTarget(document.getElementById("loopLabel"), "Loop", (state) => { state.loopStart = null; state.loopEnd = null; }, { labelTarget: true });
    registerResetTarget(document.querySelector(".display-direction-row > span"), "Scroll", (state, defaults) => { state.flow = defaults.flow; }, { labelTarget: true });
    registerResetTarget(document.getElementById("scaleLabel"), "Scale", (state, defaults) => {
      state.vertical = defaults.vertical;
      state.horizontal = defaults.horizontal;
    }, { labelTarget: true });
  }

  function resetStateToDefaults() {
    const defaults = preferenceDefaults();
    visibleTracks.clear();
    audibleTracks.clear();
    parts.forEach((_, index) => { visibleTracks.add(index); audibleTracks.add(index); });
    trackVolumes = [...defaults.volumes];
    trackPans = [...defaults.pans];
    practicePartIndex = defaults.practicePart;
    practiceDivisi = parts.map(() => null);
    activePracticeMix = null;
    practiceMixPartIndex = null;
    practiceMixUndo = null;
    loopStartMeasure = null;
    loopEndMeasure = null;
    tempoControl.setValue(defaults.tempo, false);
    metronomeControl.setValue(defaults.metronome, false);
    verticalControl.setValue(defaults.vertical, false);
    setFlow(defaults.flow, { render: false, persist: false });
    setScoreView(defaults.scoreView, { render: false, persist: false });
    horizontalControl.setValue(defaults.horizontal, false);
    setLyricsMode(defaults.lyrics, { reload: false, persist: false });
  }

  function portableStateFingerprint() {
    return String(buildMetadata.fingerprint || config.slug || config.title || "score");
  }

  function portableStateForCurrentScore() {
    if (!portableState || portableState.version !== PORTABLE_STATE_VERSION
      || portableState.fingerprint !== portableStateFingerprint()) return null;
    return portableState;
  }

  function currentPreferenceState() {
    return {
      tempo: tempoControl.value(),
      metronome: metronomeControl.value(),
      vertical: verticalControl.value(),
      horizontal: horizontalControl.value(),
      flow,
      scoreView,
      lyrics: lyricsMode,
      practicePart: practicePartIndex,
      practiceDivisi: [...practiceDivisi],
      visible: parts.map((_, index) => visibleTracks.has(index)),
      audible: parts.map((_, index) => audibleTracks.has(index)),
      volumes: [...trackVolumes],
      pans: [...trackPans],
      practiceMixMode: activePracticeMix,
      practiceMixPart: practiceMixPartIndex,
      practiceMixUndo: practiceMixUndo ? {
        audible: [...practiceMixUndo.audible],
        volumes: [...practiceMixUndo.volumes],
      } : null,
      loopStart: loopStartMeasure,
      loopEnd: loopEndMeasure,
      sing: pitchCaptureEnabled(),
    };
  }

  function applyPreferenceState(stored) {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    if (TEMPO_VALUES.includes(stored.tempo)) tempoControl.setValue(stored.tempo, false);
    if (METRONOME_VALUES.includes(stored.metronome)) metronomeControl.setValue(stored.metronome, false);
    if (VERTICAL_VALUES.includes(stored.vertical)) verticalControl.setValue(stored.vertical, false);
    if (["wrap", "continuous"].includes(stored.flow)) setFlow(stored.flow, { render: false, persist: false });
    if (["standard", "bars"].includes(stored.scoreView)) setScoreView(stored.scoreView, { render: false, persist: false });
    if (HORIZONTAL_VALUES.includes(stored.horizontal)) horizontalControl.setValue(stored.horizontal, false);
    if (Number.isInteger(stored.practicePart) && stored.practicePart >= 0 && stored.practicePart < parts.length) practicePartIndex = stored.practicePart;
    practiceDivisi = normalizePracticeDivisi(stored.practiceDivisi);
    if (Array.isArray(stored.visible) && stored.visible.length === parts.length && stored.visible.some(Boolean)) {
      visibleTracks.clear();
      stored.visible.forEach((value, index) => { if (value) visibleTracks.add(index); });
    }
    ensurePracticePartVisible();
    if (Array.isArray(stored.audible) && stored.audible.length === parts.length) {
      audibleTracks.clear();
      stored.audible.forEach((value, index) => { if (value) audibleTracks.add(index); });
    }
    if (Array.isArray(stored.volumes) && stored.volumes.length === parts.length) {
      trackVolumes = stored.volumes.map((value) => nearestAllowed(clamp(Number(value) || 0, 0, 150), VOLUME_VALUES));
    }
    if (Array.isArray(stored.pans) && stored.pans.length === parts.length) {
      trackPans = stored.pans.map((value) => nearestAllowed(clamp(Number(value) || 0, -100, 100), PAN_VALUES));
    }
    // A loop outlives the page it was set on, but only if it still points at
    // measures this score has: a shorter rebuild would otherwise restore a loop
    // running off the end.
    const lastMeasure = (sequence?.measures?.length || 0) - 1;
    if (Number.isInteger(stored.loopStart) && Number.isInteger(stored.loopEnd)
      && stored.loopStart >= 0 && stored.loopEnd <= lastMeasure && stored.loopStart <= stored.loopEnd) {
      loopStartMeasure = stored.loopStart;
      loopEndMeasure = stored.loopEnd;
    }
    wantsPitchCapture = stored.sing === true;
    const storedMixUndo = normalizePracticeMixUndo(stored.practiceMixUndo);
    const storedMixPart = stored.practiceMixPart ?? practicePartIndex;
    if (storedMixUndo && ["learn", "check"].includes(stored.practiceMixMode) && practiceMixMatches(stored.practiceMixMode, storedMixPart)) {
      activePracticeMix = stored.practiceMixMode;
      practiceMixPartIndex = storedMixPart;
      practiceMixUndo = storedMixUndo;
    }
  }

  // Reads the current key, or the first older key that still holds something,
  // moving it across so the next read finds it in its proper place.
  function storedValueFor(key, legacyKeys = []) {
    try {
      const current = localStorage.getItem(key);
      if (current !== null) return current;
      for (const legacy of legacyKeys) {
        const value = localStorage.getItem(legacy);
        if (value === null) continue;
        localStorage.setItem(key, value);
        localStorage.removeItem(legacy);
        return value;
      }
    } catch {
      // Device-local storage is optional.
    }
    return null;
  }

  // Names used to carry the build's fingerprint, so every rebuild left the
  // previous build's entries behind under a name nothing would ever ask for
  // again. By the time this runs the adoptions above have taken whatever this
  // build still wanted, so anything left under a fingerprint is dead, as are
  // this song's own superseded :vN names. Other songs' entries are left alone
  // and clear themselves the next time those songs are opened, and nothing
  // outside this app's prefix is touched — the site shares one origin.
  function sweepSupersededStorage(slug) {
    const fingerprinted = /^choir-practice:[0-9a-f]{16}:/;
    const ownPrefix = `choir-practice:${slug}:`;
    const superseded = (key) => fingerprinted.test(key) || (key.startsWith(ownPrefix) && /:v\d+$/.test(key));
    try {
      const doomed = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && superseded(key)) doomed.push(key);
      }
      doomed.forEach((key) => localStorage.removeItem(key));
      return doomed.length;
    } catch {
      // Device-local storage is optional.
      return 0;
    }
  }

  function loadPreferences() {
    resetStateToDefaults();
    let stored = null;
    let importedPortableState = false;
    try {
      const localValue = storedValueFor(preferenceKey, legacyPreferenceKeys);
      if (localValue !== null) stored = JSON.parse(localValue);
    } catch {
      // Device-local preferences are optional.
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      const embeddedPreferences = portableStateForCurrentScore()?.preferences;
      if (embeddedPreferences && typeof embeddedPreferences === "object" && !Array.isArray(embeddedPreferences)) {
        stored = embeddedPreferences;
        importedPortableState = true;
      }
    }
    applyPreferenceState(stored);
    if (importedPortableState) savePreferences();
  }

  function savePreferences() {
    if (!parts.length) return;
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(currentPreferenceState()));
    } catch {
      // Device-local preferences are optional.
    }
  }

  function isMobileSettingsDevice() {
    return navigator.userAgentData?.mobile === true
      || window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  }

  function loadSettingsOpenState() {
    try {
      const stored = storedValueFor(settingsPanelPreferenceKey, legacySettingsPanelKeys);
      if (stored === "open") return true;
      if (stored === "closed") return false;
    } catch {
      // Device-local preferences are optional.
    }
    return !isMobileSettingsDevice();
  }

  function setSettingsOpen(open, { persist = true } = {}) {
    const expanded = Boolean(open);
    elements.settingsPanel.classList.toggle("is-open", expanded);
    elements.settingsPanel.setAttribute("aria-hidden", String(!expanded));
    elements.settingsToggle.setAttribute("aria-expanded", String(expanded));
    elements.settingsToggle.setAttribute("aria-label", expanded ? "Close settings" : "Open settings");
    if (persist) {
      try {
        localStorage.setItem(settingsPanelPreferenceKey, expanded ? "open" : "closed");
      } catch {
        // Device-local preferences are optional.
      }
    }
    if (!expanded && elements.settingsPanel.contains(document.activeElement)) elements.settingsToggle.focus();
    requestAnimationFrame(updateTransportHeight);
  }

  function buildPracticePartPicker() {
    practicePartPager?.destroy();
    practicePartPager = new InfinitePager(elements.practicePart, {
      options: parts.map((part, index) => ({
        value: index, label: part.name, color: part.color,
        detail: () => practiceDivisiOptions(index).find(
          (option) => option.value === (practiceDivisi[index] ?? null))?.label,
      })),
      value: practicePartIndex,
      placeholder: "Choose part",
    });
    updatePracticeMixAppearance();
  }

  function normalizePracticeDivisi(values) {
    return parts.map((_, index) => {
      const count = partDivisi[index]?.maxLines || 1;
      const value = values?.[index];
      return count > 1 && Number.isInteger(value) && value >= 0 && value < count ? value : null;
    });
  }

  function practiceDivisiOptions(index) {
    const count = partDivisi[index]?.maxLines || 1;
    if (count < 2) return [];
    return [{ value: null, label: "All Div" },
      ...Array.from({ length: count }, (_, line) => ({ value: line, label: `Div ${line + 1}` }))];
  }

  function updatePracticeDivisi() {
    const options = practiceDivisiOptions(practicePartIndex);
    let control = document.getElementById("practiceDivisi");
    if (!control && partDivisi.some((part) => part.maxLines > 1)) {
      control = document.createElement("div");
      control.id = "practiceDivisi";
      control.className = "practice-part-pager practice-divisi-pager";
      control.setAttribute("role", "spinbutton");
      control.tabIndex = 0;
      document.querySelector(".practice-mix").append(control);
      control.addEventListener("input", () => {
        practiceDivisi[practicePartIndex] = practiceDivisiPager.value();
        updatePracticeDivisi();
        savePreferences();
      });
      registerResetTarget(control, "divisi playback", (state) => {
        if (Number.isInteger(state.practicePart)) state.practiceDivisi[state.practicePart] = null;
      }, { cancelActive: (pointerId) => practiceDivisiPager?.cancel(pointerId) });
    }
    if (control) {
      const hidden = options.length === 0;
      if (hidden && document.activeElement === control) elements.practicePart.focus();
      control.hidden = hidden;
      if (hidden) {
        practiceDivisiPager?.destroy();
        practiceDivisiPager = null;
      } else {
        const part = parts[practicePartIndex];
        const selected = practiceDivisi[practicePartIndex] ?? null;
        if (control.dataset.part !== String(practicePartIndex) || !practiceDivisiPager) {
          practiceDivisiPager?.destroy();
          control.dataset.part = String(practicePartIndex);
          practiceDivisiPager = new InfinitePager(control, { options, value: selected });
        } else practiceDivisiPager.setValue(selected);
        control.style.setProperty("--part-color", part.color);
        control.classList.add("has-part");
        control.setAttribute("aria-label", `${part.name} divisi playback`);
        control.dataset.help = `Hear all divisions or one numbered from highest to lowest in ${part.name}. Other voices and notation stay unchanged.`;
        control.title = "Tap to advance; drag to browse.";
      }
    }
    practicePartPager?.refreshLabels();
    engine?.setPracticeDivisi(practicePartIndex, practiceDivisi[practicePartIndex] ?? null);
  }

  function practiceMixMatches(mode, partIndex = practiceMixPartIndex, { volumesOnly = false } = {}) {
    if (!["learn", "check"].includes(mode) || !Number.isInteger(partIndex) || partIndex < 0
      || partIndex >= parts.length || (!volumesOnly && audibleTracks.size !== parts.length)) return false;
    return parts.every((_, index) => {
      const expected = mode === "check"
        ? index === partIndex ? 20 : 100
        : index === partIndex ? 100 : 20;
      return trackVolumes[index] === expected;
    });
  }

  function normalizePracticeMixUndo(value) {
    if (!value || typeof value !== "object"
      || !Array.isArray(value.audible) || value.audible.length !== parts.length
      || !value.audible.every((item) => typeof item === "boolean")
      || !Array.isArray(value.volumes) || value.volumes.length !== parts.length
      || !value.volumes.every((item) => Number.isFinite(Number(item)))) return null;
    return {
      audible: [...value.audible],
      volumes: value.volumes.map((item) => nearestAllowed(clamp(Number(item), 0, 150), VOLUME_VALUES)),
    };
  }

  function cancelPracticeMixSession() {
    activePracticeMix = null;
    practiceMixPartIndex = null;
    practiceMixUndo = null;
  }

  function snapshotPracticeMix() {
    return {
      audible: parts.map((_, index) => audibleTracks.has(index)),
      volumes: [...trackVolumes],
    };
  }

  function restorePracticeMix() {
    const snapshot = normalizePracticeMixUndo(practiceMixUndo);
    if (!snapshot) return false;
    audibleTracks.clear();
    snapshot.audible.forEach((audible, index) => { if (audible) audibleTracks.add(index); });
    trackVolumes = snapshot.volumes.map((value, index) => {
      volumeControls[index]?.setValue(value, false);
      return value;
    });
    cancelPracticeMixSession();
    return true;
  }

  function currentPracticeMix() {
    return practiceMixUndo && practiceMixMatches(activePracticeMix) ? activePracticeMix : null;
  }

  function updatePracticeMixAppearance() {
    updatePracticeDivisi();
    const mode = currentPracticeMix();
    const selectedPart = Number.isInteger(practicePartIndex) ? parts[practicePartIndex] : null;
    elements.practicePart.classList.toggle("has-part", Boolean(selectedPart));
    if (selectedPart) {
      elements.practicePart.style.setProperty("--part-color", selectedPart.color);
      document.documentElement.style.setProperty("--practice-color", selectedPart.color);
    } else {
      elements.practicePart.style.removeProperty("--part-color");
      document.documentElement.style.removeProperty("--practice-color");
    }
    elements.mixer.querySelectorAll("[data-volume-index]").forEach((button) => {
      const index = Number(button.dataset.volumeIndex);
      const active = index === practiceMixPartIndex ? mode : null;
      const nextMode = nextPartVolumeMix(index);
      const next = nextMode === "check" ? "reduce this part" : nextMode === "normal" ? "set all voices to 100%" : "emphasize this part";
      button.dataset.practiceMix = active || "normal";
      button.classList.toggle("is-mix-target", Boolean(active));
      button.dataset.help = `Drag vertically to adjust volume. Hold to ${next}. Shift+Enter does the same.`;
      button.title = `${parts[index].name} volume. ${button.dataset.help} Right-click to reset.`;
    });
  }

  function nextPartVolumeMix(partIndex) {
    // Infer the cycle from the displayed levels, including manually set or reloaded mixes.
    if (trackVolumes.every((value) => value === 100)) return "learn";
    if (practiceMixMatches("learn", partIndex, { volumesOnly: true })) return "check";
    if (practiceMixMatches("check", partIndex, { volumesOnly: true })) return "normal";
    return "learn";
  }

  function cyclePartVolumeMix(partIndex) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) return;
    const next = nextPartVolumeMix(partIndex);
    if (next !== "normal") {
      applyPracticeMix(next, { toggle: false, partIndex });
      return;
    }
    cancelPracticeMixSession();
    audibleTracks.clear();
    trackVolumes = parts.map((_, index) => {
      audibleTracks.add(index);
      volumeControls[index]?.setValue(100, false);
      return 100;
    });
    updateMixerAppearance();
    savePreferences();
    showToast("All voices at 100%");
  }

  function partPanIsSeparated(partIndex) {
    return Number.isInteger(partIndex) && partIndex >= 0 && partIndex < parts.length
      && parts.every((_, index) => trackPans[index] === (index === partIndex ? 100 : -100));
  }

  function updatePanHoldAppearance() {
    elements.mixer.querySelectorAll("[data-pan-index]").forEach((button) => {
      const index = Number(button.dataset.panIndex);
      const next = partPanIsSeparated(index) ? "center all parts" : "pan this part right and all others left";
      button.dataset.help = `Drag horizontally to adjust pan. Hold to ${next}. Shift+Enter does the same.`;
      button.title = `${parts[index].name} pan. ${button.dataset.help} Right-click to reset this part.`;
    });
  }

  function togglePartPanSeparation(partIndex) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) return;
    const center = partPanIsSeparated(partIndex);
    trackPans = parts.map((_, index) => center ? 0 : index === partIndex ? 100 : -100);
    panControls.forEach((control, index) => control.setValue(trackPans[index], false));
    engine?.updateMix(audibleTracks, trackVolumes, trackPans);
    updatePanHoldAppearance();
    savePreferences();
    showToast(center ? "All parts centered" : `${parts[partIndex].name} right; other parts left`);
  }

  function applyPracticeMix(mode, { toggle = true, partIndex = practicePartIndex } = {}) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) {
      elements.practicePart.focus();
      showToast("Choose your part first");
      return;
    }
    if (toggle && practiceMixPartIndex === partIndex && activePracticeMix === mode && practiceMixUndo && restorePracticeMix()) {
      updateMixerAppearance();
      savePreferences();
      showToast("Previous mix restored");
      return;
    }
    if (!activePracticeMix || !practiceMixUndo) practiceMixUndo = snapshotPracticeMix();
    activePracticeMix = mode;
    practiceMixPartIndex = partIndex;
    audibleTracks.clear();
    parts.forEach((_, index) => audibleTracks.add(index));
    trackVolumes = parts.map((_, index) => {
      const value = mode === "check"
        ? index === partIndex ? 20 : 100
        : index === partIndex ? 100 : 20;
      volumeControls[index]?.setValue(value, false);
      return value;
    });
    updateMixerAppearance();
    savePreferences();
    const partName = parts[partIndex].name;
    showToast(mode === "check" ? `${partName} reduced to 20%` : `${partName} emphasized; others at 20%`);
  }

  function setPracticePart(selected) {
    const mode = currentPracticeMix();
    practicePartIndex = Number.isInteger(selected) && selected >= 0 && selected < parts.length ? selected : null;
    selectedScorePartIndex = null;
    if (mode && practicePartIndex !== null) {
      // Follow the new singer without replacing the pre-preset mix snapshot.
      applyPracticeMix(mode, { toggle: false });
    } else {
      if (mode) restorePracticeMix();
      else cancelPracticeMixSession();
      updateMixerAppearance();
      savePreferences();
    }
    renderPitchTrace();
  }

  // Arriving with a part, from the first-visit chooser or from a link such as
  // #part=Alto or #part=S1&div=2, only says who is singing. Unlike the pager
  // it never retargets a hold preset or touches See, Hear, Vol or Pan, so a
  // returning singer's saved mix stays exactly as it was. Pitchbar view still
  // keeps the practice part visible, and the caller says so when that shows it.
  function choosePracticePart(index, divisi) {
    if (!Number.isInteger(index) || index < 0 || index >= parts.length) return null;
    const revealed = scoreView === "bars" && !visibleTracks.has(index);
    practicePartIndex = index;
    selectedScorePartIndex = null;
    if (divisi !== undefined) practiceDivisi[index] = divisi;
    practicePartPager?.setValue(index);
    updateMixerAppearance();
    updateNoteActionLabel();
    savePreferences();
    renderPitchTrace();
    if (scoreView === "bars") scheduleBarRender();
    return { revealed };
  }

  function practicePartLabel(index) {
    const line = practiceDivisi[index] ?? null;
    const option = practiceDivisiOptions(index).find((candidate) => candidate.value === line);
    return option && line !== null ? `${parts[index].name} ${option.label}` : parts[index].name;
  }

  function partChooserAnswered() {
    try {
      return Boolean(partChooserKey && localStorage.getItem(partChooserKey));
    } catch {
      return false;
    }
  }

  function rememberPartChooser(answer) {
    try {
      if (partChooserKey) localStorage.setItem(partChooserKey, answer);
    } catch {
      // Device-local preferences are optional.
    }
  }

  function showPartChooser({ only = null, note = "" } = {}) {
    if (parts.length < 2) return;
    const choices = (only || parts.map((part) => part.index)).map((index) => parts[index]);
    elements.partChooserOptions.replaceChildren(...choices.map((part) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "part-chooser-option";
      button.dataset.partIndex = String(part.index);
      button.style.setProperty("--part-color", part.color);
      button.textContent = part.name;
      return button;
    }));
    elements.partChooserNote.textContent = note || "You can change it later in settings, under Practice.";
    elements.partChooser.hidden = false;
  }

  function hidePartChooser() {
    if (elements.partChooser.hidden) return;
    const hadFocus = elements.partChooser.contains(document.activeElement);
    elements.partChooser.hidden = true;
    if (hadFocus) {
      const next = elements.settingsPanel.classList.contains("is-open") ? elements.practicePart : elements.settingsToggle;
      next.focus({ preventScroll: true });
    }
  }

  function dismissPartChooser() {
    rememberPartChooser("dismissed");
    hidePartChooser();
  }

  // Later fields win, so the hash overrides a ?part= query. Song names and
  // other fields are left for whoever owns them.
  function partLinkFields(...addresses) {
    const decode = (value) => {
      try {
        return decodeURIComponent(value.replace(/\+/gu, " "));
      } catch {
        return value;
      }
    };
    const fields = {};
    addresses.forEach((address) => String(address || "").replace(/^[#?]/u, "").split("&").forEach((token) => {
      const at = token.indexOf("=");
      if (at < 1) return;
      const key = decode(token.slice(0, at)).trim().toLowerCase();
      if (key === "part" || key === "div") fields[key] = decode(token.slice(at + 1)).trim();
    }));
    return fields;
  }

  const partLinkKey = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  // Exact names, short names and ids first ("Alto 1", "A1"), then a unique
  // beginning ("sop"). Anything that still fits several parts is offered as a
  // choice rather than guessed between.
  function partsForLink(text) {
    const wanted = partLinkKey(text);
    if (!wanted) return [];
    const names = parts.map((part) => [part.name, part.short, part.id].map(partLinkKey).filter(Boolean));
    const exact = parts.filter((part) => names[part.index].includes(wanted));
    const matches = exact.length ? exact
      : parts.filter((part) => names[part.index].some((name) => name.startsWith(wanted)));
    return matches.map((part) => part.index);
  }

  function divisiForLink(index, text) {
    if (text === undefined || text === "") return { value: undefined };
    const wanted = partLinkKey(text).replace(/^div/u, "");
    if (wanted === "all") return { value: null };
    const line = /^\d+$/u.test(wanted) ? Number(wanted) - 1 : NaN;
    return practiceDivisiOptions(index).some((option) => option.value === line)
      ? { value: line } : { value: undefined, missing: text };
  }

  // Returns whether the link said anything about parts at all.
  function applyPartLink(link) {
    if (!link || (link.part === undefined && link.div === undefined)) return false;
    if (!parts.length) {
      pendingPartLink = link;
      return true;
    }
    if (link.part === undefined && !Number.isInteger(practicePartIndex)) return false;
    const matches = link.part === undefined ? [practicePartIndex] : partsForLink(link.part);
    if (matches.length !== 1) {
      const quoted = `“${link.part}”`;
      if (matches.length) {
        showPartChooser({ only: matches, note: `The link’s ${quoted} could be ${matches.length === 2 ? "either" : "any"} of these.` });
      }
      else if (!Number.isInteger(practicePartIndex)) showPartChooser({ note: `This song has no part called ${quoted}.` });
      else showToast(`This song has no part called ${quoted}; still practising ${practicePartLabel(practicePartIndex)}`);
      return true;
    }
    const index = matches[0];
    const divisi = divisiForLink(index, link.div);
    const before = { part: practicePartIndex, divisi: [...practiceDivisi], visible: [...visibleTracks] };
    const { revealed } = choosePracticePart(index, divisi.value);
    rememberPartChooser("chosen");
    hidePartChooser();
    const changed = before.part !== index || before.divisi[index] !== practiceDivisi[index];
    const undo = changed && Number.isInteger(before.part) ? () => {
      practiceDivisi = before.divisi;
      visibleTracks.clear();
      before.visible.forEach((part) => visibleTracks.add(part));
      choosePracticePart(before.part);
      showToast(`Practising ${practicePartLabel(before.part)}`);
    } : null;
    const label = practicePartLabel(index);
    const message = divisi.missing ? `${parts[index].name} has no Div ${divisi.missing}; practising ${label}`
      : `Practising ${label}${Number.isInteger(before.part) && changed ? " from the link" : ""}`;
    showToast(`${message}${revealed ? " (shown in pitchbar view)" : ""}`, "", undo);
    return true;
  }

  // A link is followed once. Afterwards the remembered choice speaks for
  // itself, so a reload or bookmark cannot undo a later change of part.
  function consumePartLink() {
    try {
      const address = new URL(window.location.href);
      const keep = (text) => text.replace(/^[#?]/u, "").split("&")
        .filter((token) => token && !/^(part|div)=/iu.test(token)).join("&");
      address.search = keep(address.search);
      address.hash = keep(address.hash);
      window.history.replaceState(window.history.state, "", address.href);
    } catch {
      // An opaque or read-only address keeps its link; nothing depends on it.
    }
  }

  elements.partChooserOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-part-index]");
    if (!button) return;
    const index = Number(button.dataset.partIndex);
    const chosen = choosePracticePart(index);
    if (!chosen) return;
    rememberPartChooser("chosen");
    hidePartChooser();
    showToast(`Practising ${practicePartLabel(index)}${chosen.revealed ? " (shown in pitchbar view)" : ""}`);
    // Choosing is the natural moment to learn that holding the part's number
    // brings it forward. The tip waits for the mixer to be on screen.
    queueShortcutTip(shortcutHints.hold("vol", index, event.detail === 0 ? "keyboard" : "touch"));
  });
  elements.partChooserDismiss.addEventListener("click", dismissPartChooser);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || elements.partChooser.hidden || event.defaultPrevented) return;
    if (isTextEntryTarget(event.target) && !elements.partChooser.contains(event.target)) return;
    // Settings stay open; a second Escape reaches them.
    event.preventDefault();
    dismissPartChooser();
  });
  // A collection owns its own address and forwards the part fields it found
  // there, so the parts of this song decide what the name means.
  document.addEventListener("melete:deep-link", (event) => {
    const detail = event.detail || {};
    const field = (value) => typeof value === "string" ? value : undefined;
    applyPartLink({ part: field(detail.part), div: field(detail.div) });
  });
  window.addEventListener("hashchange", () => {
    const link = partLinkFields(window.location.hash);
    if (link.part === undefined && link.div === undefined) return;
    consumePartLink();
    applyPartLink(link);
  });

  function ensurePracticePartVisible() {
    if (scoreView === "bars" && Number.isInteger(practicePartIndex)
      && practicePartIndex >= 0 && practicePartIndex < parts.length) visibleTracks.add(practicePartIndex);
  }

  function updateMixerAppearance() {
    ensurePracticePartVisible();
    elements.mixer.querySelectorAll("[data-visible-index]").forEach((button) => {
      const index = Number(button.dataset.visibleIndex);
      const visible = visibleTracks.has(index);
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", `${parts[index].name} notation ${visible ? "shown" : "hidden"}`);
      button.dataset.help = scoreView === "bars" && index === practicePartIndex
        ? "Your practice part stays visible; hold to hide the others."
        : `${visible ? "Hide" : "Show"} ${parts[index].name} notation.`;
    });
    elements.mixer.querySelectorAll("[data-audio-index]").forEach((button) => {
      const index = Number(button.dataset.audioIndex);
      const audible = audibleTracks.has(index);
      button.setAttribute("aria-pressed", String(audible));
      button.setAttribute("aria-label", `${parts[index].name} audio ${audible ? "on" : "off"}`);
      button.dataset.help = audible ? `Silence ${parts[index].name}.` : `Hear ${parts[index].name}.`;
    });
    engine?.updateMix(audibleTracks, trackVolumes, trackPans);
    updatePracticeMixAppearance();
    updatePanHoldAppearance();
  }

  function setTrackVisibility(index, visible) {
    if (!visible && scoreView === "bars" && index === practicePartIndex) {
      showToast("Your practice part stays visible in pitchbar view");
      return;
    }
    if (!visible && visibleTracks.size <= 1 && visibleTracks.has(index)) {
      showToast("At least one part must remain visible");
      return;
    }
    if (visible) visibleTracks.add(index);
    else visibleTracks.delete(index);
    updateMixerAppearance();
    updateNoteActionLabel();
    savePreferences();
    scheduleRender();
  }

  function setTrackAudible(index, audible) {
    cancelPracticeMixSession();
    if (audible) audibleTracks.add(index);
    else audibleTracks.delete(index);
    updateMixerAppearance();
    savePreferences();
  }

  function aloneOnItsRow(row, partCount) {
    return Array.from({ length: partCount }, (_, part) => part)
      .every((part) => row.on(part) === (part === row.index || part === row.required));
  }

  function turnOnEveryPart(row, partCount) {
    for (let part = 0; part < partCount; part += 1) row.set(part, true);
  }

  function soloRow(row, partCount) {
    if (aloneOnItsRow(row, partCount)) return turnOnEveryPart(row, partCount);
    // The kept part goes on first: a row is not allowed to empty, so turning
    // the others off around a part that is itself off would be refused.
    row.set(row.index, true);
    for (let part = 0; part < partCount; part += 1) if (part !== row.index) row.set(part, false);
  }

  function pressRow(row, partCount) {
    if (aloneOnItsRow(row, partCount)) turnOnEveryPart(row, partCount);
    else row.set(row.index, !row.on(row.index));
  }

  // Press a part to toggle it, hold to leave only that part on — the gesture
  // Chordus uses on its clefs. The two rows are independent: soloing what you
  // can see never changes what you can hear. Holding the last part still
  // standing puts the others back, and so does a plain press on it, since a
  // row with nothing left on is never what anyone wants; that also gives the
  // hold a one-press way out. Dragging across the Hear row still paints it.
  function attachMixerGestures() {
    const rowAt = (cell) => {
      if (cell?.dataset.visibleIndex !== undefined) {
        return { name: "see", index: Number(cell.dataset.visibleIndex), selector: "[data-visible-index]",
          required: scoreView === "bars" ? practicePartIndex : null,
          key: "visibleIndex", on: (part) => visibleTracks.has(part), set: setTrackVisibility, paints: false };
      }
      if (cell?.dataset.audioIndex !== undefined) {
        return { name: "hear", index: Number(cell.dataset.audioIndex), selector: "[data-audio-index]",
          key: "audioIndex", on: (part) => audibleTracks.has(part), set: setTrackAudible, paints: true };
      }
      return null;
    };
    const press = (row, input) => {
      const before = parts.map((_, index) => row.on(index));
      pressRow(row, parts.length);
      queueShortcutTip(shortcutHints.toggle(row.name, row.index, before,
        parts.map((_, index) => row.on(index)), input));
    };
    let gesture = null;
    const clear = () => {
      if (!gesture) return;
      window.clearTimeout(gesture.timer);
      const { pointerId } = gesture;
      gesture = null;
      if (elements.mixer.hasPointerCapture(pointerId)) elements.mixer.releasePointerCapture(pointerId);
    };
    elements.mixer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const row = rowAt(event.target.closest("[data-visible-index], [data-audio-index]"));
      if (!row) return;
      clear();
      gesture = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        held: false, painting: false, painted: row.index, target: false };
      try { elements.mixer.setPointerCapture(event.pointerId); } catch {}
      gesture.timer = window.setTimeout(() => {
        if (!gesture) return;
        gesture.held = true;
        learnShortcut("isolate");
        soloRow(gesture.row, parts.length);
      }, MIXER_SOLO_HOLD_MS);
      event.preventDefault();
    });
    elements.mixer.addEventListener("pointermove", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId || gesture.held) return;
      if (!gesture.painting && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 10) return;
      window.clearTimeout(gesture.timer);
      const { row } = gesture;
      if (!row.paints) { clear(); return; }
      if (!gesture.painting) {
        gesture.painting = true;
        gesture.target = !row.on(row.index);
        row.set(row.index, gesture.target);
      }
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(row.selector);
      const part = cell && elements.mixer.contains(cell) ? Number(cell.dataset[row.key]) : null;
      if (part === null || Number.isNaN(part) || part === gesture.painted) return;
      gesture.painted = part;
      row.set(part, gesture.target);
    });
    elements.mixer.addEventListener("pointerup", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const { row, held, painting } = gesture;
      clear();
      if (!held && !painting) press(row, event.pointerType);
    });
    elements.mixer.addEventListener("pointercancel", clear);
    elements.mixer.addEventListener("lostpointercapture", clear);

    // Keyboard and assistive tech reach both actions through the button
    // itself, where a synthetic click carries no pointer detail.
    elements.mixer.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      const row = rowAt(event.target.closest("[data-visible-index], [data-audio-index]"));
      if (!row) return;
      if (event.shiftKey) {
        learnShortcut("isolate");
        soloRow(row, parts.length);
      } else press(row, "keyboard");
    });
  }

  function appendMixerLabel(text, mutate) {
    const label = document.createElement("span");
    label.className = "mixer-row-label";
    label.textContent = text;
    label.dataset.mixerRow = text.toLowerCase();
    elements.mixer.append(label);
    registerResetTarget(label, text, mutate, { labelTarget: true });
    return label;
  }

  // Always measure from the drag's starting mix so reversing restores it.
  // Volumes preserve their spacing at the limits; pans can saturate separately.
  function attachGroupDrag(label, controls, values, pixelsPerStep, { horizontal = false, clampIndividually = false } = {}) {
    const along = (event) => horizontal ? event.clientX : -event.clientY;
    const indicesNow = () => controls.map((control) => values.indexOf(nearestAllowed(control.value(), values)));
    const shift = (startIndices, steps) => {
      if (startIndices.some((index) => index < 0)) return;
      const room = clampIndividually ? steps
        : clamp(steps, -Math.min(...startIndices), values.length - 1 - Math.max(...startIndices));
      controls.forEach((control, part) => control.setValue(values[clamp(startIndices[part] + room, 0, values.length - 1)]));
    };

    let pointerId = null;
    let startPoint = 0;
    let startIndices = [];
    label.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !controls.length) return;
      pointerId = event.pointerId;
      startPoint = along(event);
      startIndices = indicesNow();
      try { label.setPointerCapture(pointerId); } catch {}
      event.preventDefault();
    });
    label.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !label.hasPointerCapture(pointerId)) return;
      shift(startIndices, Math.round((along(event) - startPoint) / pixelsPerStep));
    });
    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      if (label.hasPointerCapture(pointerId)) label.releasePointerCapture(pointerId);
      pointerId = null;
    };
    label.addEventListener("pointerup", release);
    label.addEventListener("pointercancel", release);
    label.addEventListener("lostpointercapture", () => { pointerId = null; });
    label.addEventListener("keydown", (event) => {
      const steps = ["ArrowUp", "ArrowRight"].includes(event.key) ? 1
        : ["ArrowDown", "ArrowLeft"].includes(event.key) ? -1 : 0;
      if (!steps) return;
      shift(indicesNow(), steps);
      event.preventDefault();
    });
  }

  function buildMixer() {
    elements.mixer.innerHTML = "";
    elements.mixer.removeAttribute("aria-busy");
    elements.mixer.style.setProperty("--part-count", String(parts.length));
    volumeControls.length = 0;
    panControls.length = 0;

    appendMixerLabel("See", (state) => { state.visible = parts.map(() => true); });
    parts.forEach((part, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "part-heading";
      button.style.setProperty("--part-color", part.color);
      button.dataset.visibleIndex = String(index);
      button.textContent = part.short;
      button.setAttribute("aria-label", `${part.name} notation`);
      button.dataset.help = `Show ${part.name}; hold for only this part.`;
      registerResetTarget(button, `${part.name} notation`, (state) => { state.visible[index] = true; },
        { holdToReset: false });
      elements.mixer.append(button);
    });

    appendMixerLabel("Hear", (state) => {
      state.audible = parts.map(() => true);
      state.practiceMixMode = null;
      state.practiceMixUndo = null;
    });
    parts.forEach((part, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "matrix-cell";
      button.style.setProperty("--part-color", part.color);
      button.dataset.audioIndex = String(index);
      button.setAttribute("aria-label", `${part.name} audio`);
      button.dataset.help = `Hear ${part.name}; hold for only this part.`;
      registerResetTarget(button, `${part.name} audio`, (state) => {
        state.audible[index] = true;
        state.practiceMixMode = null;
        state.practiceMixUndo = null;
      }, { holdToReset: false });
      elements.mixer.append(button);
    });

    const volumeLabel = appendMixerLabel("Vol", (state, defaults) => {
      state.volumes = [...defaults.volumes];
      state.practiceMixMode = null;
      state.practiceMixUndo = null;
    });
    volumeLabel.classList.add("is-group-drag");
    volumeLabel.dataset.help = "Drag vertically to change every part.";
    volumeLabel.setAttribute("aria-label", "All part volumes");
    parts.forEach((part, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "drag-number";
      button.dataset.value = String(trackVolumes[index]);
      button.dataset.volumeIndex = String(index);
      button.style.setProperty("--part-color", part.color);
      button.setAttribute("aria-keyshortcuts", "Shift+Enter");
      button.dataset.help = `${part.name} volume: drag vertically.`;
      button.setAttribute("aria-label", `${part.name} volume`);
      elements.mixer.append(button);
      const control = createDragNumber(button, {
        values: VOLUME_VALUES,
        defaultValue: () => preferenceDefaults().volumes[index],
        format: (value) => `${value}%`,
        aria: (value) => `${part.name} volume ${value} percent`,
        pixelsPerStep: 4,
        onHold: () => {
          learnShortcut("vol-hold");
          cyclePartVolumeMix(index);
        },
        onManualChange: (before, after, input) => queueShortcutTip(shortcutHints.adjust(
          "vol", index, before, after, preferenceDefaults().volumes[index], input)
          || shortcutHints.hold("vol", index, input)),
      });
      button.addEventListener("input", () => {
        cancelPracticeMixSession();
        trackVolumes[index] = control.value();
        engine?.updateMix(audibleTracks, trackVolumes, trackPans);
        updatePracticeMixAppearance();
        savePreferences();
      });
      registerResetTarget(button, `${part.name} volume`, (state, defaults) => {
        state.volumes[index] = defaults.volumes[index];
        state.practiceMixMode = null;
        state.practiceMixUndo = null;
      }, { holdToReset: false });
      volumeControls.push(control);
    });
    attachGroupDrag(volumeLabel, volumeControls, VOLUME_VALUES, 4);

    const panLabel = appendMixerLabel("Pan", (state, defaults) => { state.pans = [...defaults.pans]; });
    panLabel.classList.add("is-group-drag", "is-horizontal");
    panLabel.dataset.help = "Drag horizontally to pan every part.";
    panLabel.setAttribute("aria-label", "All part pans");
    parts.forEach((part, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pan-ring";
      button.style.setProperty("--part-color", part.color);
      button.dataset.value = String(trackPans[index]);
      button.dataset.panIndex = String(index);
      button.setAttribute("aria-keyshortcuts", "Shift+Enter");
      button.setAttribute("aria-label", `${part.name} stereo pan`);
      const ring = document.createElement("span");
      ring.className = "pan-arc";
      ring.setAttribute("aria-hidden", "true");
      const cap = document.createElement("span");
      cap.className = "pan-cap";
      const indicator = document.createElement("span");
      indicator.className = "pan-indicator";
      cap.append(indicator);
      ring.append(cap);
      button.append(ring);
      elements.mixer.append(button);
      const control = createPanRing(button, {
        name: part.name, defaultValue: () => preferenceDefaults().pans[index],
        onHold: () => {
          learnShortcut("pan-hold");
          togglePartPanSeparation(index);
        },
        onManualChange: (before, after, input) => queueShortcutTip(shortcutHints.adjust(
          "pan", index, before, after, preferenceDefaults().pans[index], input)
          || shortcutHints.hold("pan", index, input)),
      });
      button.addEventListener("input", () => {
        trackPans[index] = control.value();
        engine?.updateMix(audibleTracks, trackVolumes, trackPans);
        updatePanHoldAppearance();
        savePreferences();
      });
      registerResetTarget(button, `${part.name} pan`, (state, defaults) => { state.pans[index] = defaults.pans[index]; },
        { holdToReset: false });
      panControls.push(control);
    });
    // Same feel as a pan dial's own drag, which also steps every four pixels.
    attachGroupDrag(panLabel, panControls, PAN_VALUES, 4, { horizontal: true, clampIndividually: true });

    updateMixerAppearance();
  }

  function loadAnnotations() {
    annotations.clear();
    try {
      const adopted = storedValueFor(annotationKey, legacyAnnotationKeys);
      let source = adopted ? { key: annotationKey, value: adopted } : null;
      if (!source) {
        const embeddedAnnotations = portableStateForCurrentScore()?.annotations;
        if (embeddedAnnotations && typeof embeddedAnnotations === "object" && !Array.isArray(embeddedAnnotations)) {
          source = { key: "portable-state", value: JSON.stringify(embeddedAnnotations) };
        }
      }
      const stored = JSON.parse(source?.value || "null");
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
      const fallbackPartIndex = currentScorePartIndex();
      if (stored.version === 3 && Array.isArray(stored.items)) {
        stored.items.forEach((item) => {
          const tick = Math.round(Number(item?.tick));
          const partIndex = Number.isInteger(Number(item?.partIndex)) ? Number(item.partIndex) : fallbackPartIndex;
          const text = typeof item?.text === "string" ? item.text.trim().slice(0, 500) : "";
          if (Number.isFinite(tick) && tick >= 0 && tick < sequence.endTick && partIndex >= 0 && partIndex < parts.length && text) {
            annotations.set(annotationId(tick, partIndex), { tick, partIndex, text });
          }
        });
        if (source?.key !== annotationKey) saveAnnotations();
        return;
      }
      if (stored.version === 2 && Array.isArray(stored.items)) {
        stored.items.forEach((item) => {
          const tick = Math.round(Number(item?.tick));
          const note = typeof item?.text === "string" ? item.text.trim().slice(0, 500) : "";
          if (Number.isFinite(tick) && tick >= 0 && tick < sequence.endTick && note) {
            annotations.set(annotationId(tick, fallbackPartIndex), { tick, partIndex: fallbackPartIndex, text: note });
          }
        });
        if (annotations.size) saveAnnotations();
        return;
      }
      // Migrate the original measure-indexed note format to measure starts.
      Object.entries(stored).forEach(([measure, text]) => {
        const index = Number(measure);
        const note = typeof text === "string" ? text.trim().slice(0, 500) : "";
        const tick = sequence.measures[index]?.[0];
        if (Number.isInteger(index) && Number.isFinite(tick) && note) {
          annotations.set(annotationId(tick, fallbackPartIndex), { tick, partIndex: fallbackPartIndex, text: note });
        }
      });
      if (annotations.size) saveAnnotations();
    } catch {
      // Score notes are optional device-local state.
    }
  }

  function currentAnnotationState() {
    return {
      version: 3,
      items: [...annotations.values()]
        .sort((left, right) => left.tick - right.tick || left.partIndex - right.partIndex)
        .map(({ tick, partIndex, text }) => ({ tick, partIndex, text })),
    };
  }

  function saveAnnotations() {
    try {
      localStorage.setItem(annotationKey, JSON.stringify(currentAnnotationState()));
    } catch {
      showToast("This browser could not save the annotation", "error");
    }
  }

  function annotationId(tick, partIndex) {
    return `${partIndex}:${tick}`;
  }

  function scoreLocationAtTick(value) {
    const tick = clamp(Math.round(Number(value) || 0), 0, Math.max(0, sequence.endTick - 1));
    const measureIndex = measureIndexAtTick(tick);
    const [start, duration, rawBeats = 4, rawBeatType = 4] = sequence.measures[measureIndex];
    const beats = Math.max(1, Math.round(Number(rawBeats) || 4));
    const beatType = Math.max(1, Number(rawBeatType) || 4);
    const division = Math.max(1, Number(sequence.division) || 1);
    const nominalBeatDuration = division * 4 / beatType;
    const beatDuration = Number.isFinite(nominalBeatDuration) && nominalBeatDuration > 0
      ? nominalBeatDuration
      : Math.max(1, duration / beats);
    const offset = clamp(tick - start, 0, Math.max(0, duration - 1));
    const beatZeroIndex = clamp(Math.floor(offset / beatDuration), 0, beats - 1);
    const beatFraction = clamp((offset - beatZeroIndex * beatDuration) / beatDuration, 0, 0.999999);
    const thousandths = Math.min(999, Math.round(beatFraction * 1000));
    const fractionDigits = String(thousandths).padStart(3, "0").replace(/0+$/u, "") || "0";
    return `${measureIndex + 1}.${beatZeroIndex + 1}.${fractionDigits}`;
  }

  function currentScoreTick() {
    const playbackTick = engine ? engine.tickAtSeconds(engine.currentSeconds()) : 0;
    if (Number.isFinite(selectedScoreTick) && Math.abs(playbackTick - selectedScoreTick) <= 1) return selectedScoreTick;
    return clamp(Math.round(playbackTick), 0, Math.max(0, sequence.endTick - 1));
  }

  function currentScorePartIndex() {
    if (Number.isInteger(selectedScorePartIndex) && visibleTracks.has(selectedScorePartIndex)) return selectedScorePartIndex;
    if (Number.isInteger(practicePartIndex) && visibleTracks.has(practicePartIndex)) return practicePartIndex;
    return [...visibleTracks][0] ?? 0;
  }

  function updateNoteActionLabel() {
    const unavailable = scoreView === "bars";
    elements.noteMode.disabled = unavailable;
    if (unavailable) {
      elements.noteMode.setAttribute("aria-label", "Annotate is available in standard notation");
      elements.noteMode.dataset.help = "Available only in standard notation.";
      return;
    }
    if (!parts.length || !sequence?.measures?.length) return;
    const partIndex = currentScorePartIndex();
    const location = scoreLocationAtTick(currentScoreTick());
    const description = `${parts[partIndex]?.name || `Part ${partIndex + 1}`} at measure ${location}`;
    elements.noteMode.setAttribute("aria-label", `Add annotation for ${description}`);
    elements.noteMode.dataset.help = `Annotate ${parts[partIndex]?.name || `Part ${partIndex + 1}`} at ${location}.`;
  }

  function startInlineNoteEdit(scoreTick, scorePartIndex) {
    const tick = Math.round(Number(scoreTick));
    const partIndex = Number(scorePartIndex);
    if (!Number.isFinite(tick) || tick < 0 || tick >= sequence.endTick || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts.length) return;
    if (editingAnnotation) commitInlineNoteEdit();
    const id = annotationId(tick, partIndex);
    const existing = annotations.get(id);
    editingAnnotation = {
      id,
      tick,
      partIndex,
      draft: existing?.text || "",
      focusRequested: true,
    };
    renderAnnotations();
  }

  function commitInlineNoteEdit(cancel = false) {
    if (!editingAnnotation) return;
    const { id, tick, partIndex, draft } = editingAnnotation;
    const text = String(draft || "").trim().slice(0, 500);
    editingAnnotation = null;
    if (!cancel) {
      if (text) annotations.set(id, { tick, partIndex, text });
      else annotations.delete(id);
      saveAnnotations();
    }
    renderAnnotations();
  }

  function deleteAnnotation(tick, partIndex) {
    const id = annotationId(tick, partIndex);
    const deleted = annotations.get(id);
    if (!deleted) return;
    annotations.delete(id);
    saveAnnotations();
    renderAnnotations();
    const location = scoreLocationAtTick(tick);
    showToast(`Annotation at ${location} deleted`, "", () => {
      annotations.set(id, deleted);
      saveAnnotations();
      renderAnnotations();
      showToast(`Annotation at ${location} restored`);
    });
  }

  function resizeInlineNoteEditor(editor) {
    const lineCount = Math.max(1, String(editor.value || "").split(/\r\n?|\n/u).length);
    const computed = getComputedStyle(editor);
    const fontSize = Number.parseFloat(computed.fontSize) || 10;
    const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.3;
    editor.style.height = `${Math.max(13, Math.ceil(lineCount * lineHeight))}px`;
  }

  function renderSectionGuides() {
    elements.score.querySelectorAll('[data-section-measure="true"]').forEach((label) => {
      label.removeAttribute("data-section-measure");
    });
    if (!api || !sequence?.measures?.length) return;
    const chapterMeasures = new Set(autoChapters()
      .filter((chapter) => Number.isFinite(chapter.tick) && chapter.tick >= 0 && chapter.tick < sequence.endTick)
      .filter((chapter, index, all) => index === 0 || chapter.tick > all[index - 1].tick)
      .map((chapter) => measureIndexAtTick(chapter.tick) + 1));
    if (!chapterMeasures.size) return;

    // AlphaTab emits bar numbers as red Arial text nodes. Mark the existing
    // number instead of drawing a competing chapter line or duplicate label.
    elements.score.querySelectorAll(".at-surface-svg text").forEach((label) => {
      const text = label.textContent?.trim() || "";
      if (!/^\d+$/u.test(text)) return;
      const measure = Number(text);
      const fill = (label.getAttribute("fill") || "").toLowerCase();
      if (chapterMeasures.has(measure) && fill === "#c80000") {
        label.setAttribute("data-section-measure", "true");
      }
    });
  }

  function scheduleSectionGuides() {
    const generation = ++sectionGuideGeneration;
    let frame = 0;
    const markAfterPaint = () => {
      if (generation !== sectionGuideGeneration) return;
      renderSectionGuides();
      frame += 1;
      // AlphaTab can replace its SVG surfaces for several frames after
      // renderFinished, so reapply the lightweight text attributes until the
      // final surface is attached.
      if (frame < 8) requestAnimationFrame(markAfterPaint);
    };
    requestAnimationFrame(markAfterPaint);
  }

  function partIndexForTrack(track) {
    const identityIndex = scoreTracks.indexOf(track);
    if (identityIndex >= 0) return identityIndex;
    const modelIndex = Number(track?.index);
    return scoreTracks.findIndex((candidate) => Number(candidate?.index) === modelIndex);
  }

  function barBoundsForPart(masterBounds, partIndex) {
    return [...(masterBounds?.bars || [])].find((bounds) => partIndexForTrack(bounds?.bar?.staff?.track) === partIndex) || null;
  }

  function renderSelectedPartHighlight() {
    const existing = elements.score.querySelector(".score-selected-part");
    if (scoreView !== "standard" || !api || !Number.isInteger(selectedScorePartIndex)
      || !visibleTracks.has(selectedScorePartIndex) || !sequence?.measures?.length) {
      existing?.remove();
      return;
    }
    const tick = currentScoreTick();
    const measureIndex = measureIndexAtTick(tick);
    const lookup = api.boundsLookup || api.renderer?.boundsLookup;
    const masterBounds = lookup?.findMasterBarByIndex?.(measureIndex);
    const staffBounds = barBoundsForPart(masterBounds, selectedScorePartIndex);
    const box = staffBounds?.realBounds || staffBounds?.visualBounds;
    const x = Number(box?.x);
    const y = Number(box?.y);
    const width = Number(box?.w);
    const height = Number(box?.h);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
    const geometry = [x, y, width, height].map((value) => value.toFixed(3)).join("|");
    if (existing?.dataset.measureIndex === String(measureIndex)
      && existing.dataset.partIndex === String(selectedScorePartIndex)) {
      if (existing.dataset.geometry === geometry) return;
      existing.dataset.geometry = geometry;
      existing.style.left = `${x}px`;
      existing.style.top = `${y}px`;
      existing.style.width = `${width}px`;
      existing.style.height = `${height}px`;
      return;
    }
    existing?.remove();
    const highlight = document.createElement("div");
    highlight.className = "score-selected-part";
    highlight.dataset.measureIndex = String(measureIndex);
    highlight.dataset.partIndex = String(selectedScorePartIndex);
    highlight.dataset.geometry = geometry;
    highlight.style.setProperty("--part-color", parts[selectedScorePartIndex]?.color || partPaint(selectedScorePartIndex));
    highlight.style.left = `${x}px`;
    highlight.style.top = `${y}px`;
    highlight.style.width = `${width}px`;
    highlight.style.height = `${height}px`;
    elements.score.append(highlight);
  }

  function nearestPartIndexAtScoreY(measureIndex, scoreY, fallbackPartIndex) {
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    const masterBounds = lookup?.findMasterBarByIndex?.(measureIndex);
    const candidates = [...(masterBounds?.bars || [])].map((bounds) => {
      const partIndex = partIndexForTrack(bounds?.bar?.staff?.track);
      const box = bounds?.realBounds || bounds?.visualBounds;
      const top = Number(box?.y);
      const height = Number(box?.h);
      if (!visibleTracks.has(partIndex) || !Number.isFinite(top) || !Number.isFinite(height)) return null;
      const bottom = top + height;
      const distance = scoreY < top ? top - scoreY : scoreY > bottom ? scoreY - bottom : 0;
      return { partIndex, distance, centerDistance: Math.abs(scoreY - (top + bottom) / 2) };
    }).filter(Boolean).sort((left, right) => left.distance - right.distance || left.centerDistance - right.centerDistance);
    return candidates[0]?.partIndex ?? (visibleTracks.has(fallbackPartIndex) ? fallbackPartIndex : currentScorePartIndex());
  }

  function scoreNoteBoxWidth(text, location) {
    const canvas = scoreNoteBoxWidth.canvas || (scoreNoteBoxWidth.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (!context) return Math.max(120, 68 + String(text || "").length * 6);
    context.font = "650 10px Inter, ui-sans-serif, system-ui, sans-serif";
    const lines = String(text || "").split(/\r\n?|\n/u);
    const textWidth = Math.max(8, ...lines.map((line) => context.measureText(line || " ").width));
    const addressWidth = context.measureText(String(location || "1.1.0")).width;
    // 12px box padding + 18px delete button + two 5px flex gaps.
    return Math.max(120, Math.ceil(40 + addressWidth + textWidth + 3));
  }

  function standardScoreTargetAtClientPoint(clientX, clientY, fallbackPartIndex) {
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    if (!lookup?.findMasterBarByIndex || !sequence?.measures?.length) return null;
    const scoreBounds = elements.score.getBoundingClientRect();
    const scoreX = clientX - scoreBounds.left + elements.score.scrollLeft;
    const scoreY = clientY - scoreBounds.top + elements.score.scrollTop;
    const candidates = sequence.measures.map((_, measureIndex) => {
      const masterBounds = lookup.findMasterBarByIndex(measureIndex);
      const box = masterBounds?.realBounds || masterBounds?.visualBounds || masterBounds?.lineAlignedBounds;
      const x = Number(box?.x);
      const y = Number(box?.y);
      const width = Number(box?.w);
      const height = Number(box?.h);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      const horizontalDistance = scoreX < x ? x - scoreX : scoreX > x + width ? scoreX - x - width : 0;
      const verticalDistance = scoreY < y ? y - scoreY : scoreY > y + height ? scoreY - y - height : 0;
      return {
        measureIndex, x, width, masterBounds,
        distance: horizontalDistance * horizontalDistance + verticalDistance * verticalDistance,
        centerDistance: Math.abs(scoreY - (y + height / 2)),
      };
    }).filter(Boolean).sort((left, right) => left.distance - right.distance || left.centerDistance - right.centerDistance);
    const target = candidates[0];
    if (!target) return null;
    const [measureStart, measureDuration] = sequence.measures[target.measureIndex];
    const fraction = clamp((scoreX - target.x) / target.width, 0, 0.999999);
    const tick = clamp(
      Math.round(measureStart + measureDuration * fraction),
      measureStart,
      Math.max(measureStart, measureStart + measureDuration - 1),
    );
    const partIndex = nearestPartIndexAtScoreY(target.measureIndex, scoreY, fallbackPartIndex);
    const beatTick = beatTickAtScoreX(target.masterBounds, partIndex, scoreX);
    return {
      tick: beatTick === null ? tick : beatTick,
      exactTick: beatTick !== null,
      partIndex,
      snapStartTick: Number(measureStart) || 0,
      snapEndTick: (Number(measureStart) || 0) + (Number(measureDuration) || 0),
    };
  }

  function standardNoteAtClientPoint(clientX, clientY, nearest = false) {
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    if (!lookup?.findMasterBarByIndex) return null;
    const origin = elements.score.getBoundingClientRect();
    const x = clientX - origin.left + elements.score.scrollLeft;
    const y = clientY - origin.top + elements.score.scrollTop;
    let closest = null;
    for (let index = 0; index < (sequence?.measures?.length || 0); index++) {
      const master = lookup.findMasterBarByIndex(index);
      const system = master?.staffSystemBounds?.realBounds;
      if (nearest && system && (x < system.x || x > system.x + system.w
        || y < system.y || y > system.y + system.h)) continue;
      for (const bar of master?.bars || []) {
        const track = partIndexForTrack(bar.bar?.staff?.track);
        if (!visibleTracks.has(track)) continue;
        for (const beat of bar.beats || []) for (const bounds of beat.notes || []) {
          const box = bounds.noteHeadBounds;
          const key = Number(bounds.note?.realValue);
          if (!box || !Number.isFinite(key) || key < 0 || key > 127) continue;
          // Use the engraved notehead, not the beat's entire time/lyric column.
          const padding = 2;
          if (!nearest && (x < box.x - padding || x > box.x + box.w + padding
            || y < box.y - padding || y > box.y + box.h + padding)) continue;
          const distance = Math.hypot(x - box.x - box.w / 2, y - box.y - box.h / 2);
          if (!closest || distance < closest.distance) closest = {
            key, track, distance, tick: Number(beat.beat?.absolutePlaybackStart),
          };
        }
      }
    }
    return closest ? { key: closest.key, track: closest.track, tick: closest.tick } : null;
  }

  function chordNotesAtTick(tick) {
    return (sequence?.notes || []).filter(([track, start, end]) =>
      track >= 0 && track < parts.length && start <= tick && tick < end)
      .map(([track, , , key]) => ({ key, track }));
  }

  function performedScoreTick(tick) {
    const swing = sequence.swing;
    const unit = swing?.unit === "16th" ? sequence.division / 4
      : swing?.unit === "eighth" ? sequence.division / 2 : 0;
    if (!(unit > 0 && swing.ratio > 0 && swing.ratio < 100)) return tick;
    const pair = unit * 2, first = pair * swing.ratio / 100;
    const pairStart = Math.floor(tick / pair) * pair, offset = tick - pairStart;
    return Math.round(pairStart + (offset <= unit ? offset * first / unit
      : first + (offset - unit) * (pair - first) / unit));
  }

  function standardChordTargetAtClientPoint(clientX, clientY, stripOnly = true) {
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    if (!lookup?.findMasterBarByIndex) return null;
    const origin = elements.score.getBoundingClientRect();
    const x = clientX - origin.left + elements.score.scrollLeft;
    const y = clientY - origin.top + elements.score.scrollTop;
    for (let index = 0; index < (sequence?.measures?.length || 0); index++) {
      const master = lookup.findMasterBarByIndex(index);
      const box = master?.realBounds;
      const system = master?.staffSystemBounds?.realBounds || box;
      const top = master?.lineAlignedBounds?.y;
      if (!box || !system || !Number.isFinite(top) || x < box.x || x >= box.x + box.w) continue;
      if (stripOnly ? y < Math.max(system.y, top - 44) || y >= top - 2
        : y < system.y || y > system.y + system.h) continue;

      // Engraved spacing is not proportional to time. Interpolate between
      // notehead left edges, including rest columns between notes. Use performed
      // onset ticks when the sequence carries swing, not straight notation time.
      const [start, duration] = sequence.measures[index];
      const columns = new Map();
      for (const bar of master.bars || []) {
        if (!visibleTracks.has(partIndexForTrack(bar.bar?.staff?.track))) continue;
        for (const beat of bar.beats || []) {
          const tick = performedScoreTick(Number(beat.beat?.absolutePlaybackStart));
          const heads = (beat.notes || []).map((note) => note.noteHeadBounds?.x).filter(Number.isFinite);
          const hasHead = heads.length > 0;
          const position = hasHead ? Math.min(...heads) : beat.realBounds?.x;
          if (!Number.isFinite(tick) || !Number.isFinite(position)) continue;
          const previous = columns.get(tick);
          if (!previous || (hasHead && !previous.hasHead)
            || (hasHead === previous.hasHead && position < previous.x)) {
            columns.set(tick, { x: position, hasHead });
          }
        }
      }
      const anchors = [...columns].map(([tick, column]) => ({ tick, x: column.x }))
        .sort((a, b) => a.x - b.x);
      if (!anchors.length) anchors.push({ tick: start, x: box.x });
      anchors.push({ tick: start + duration, x: box.x + box.w });
      let tick = anchors[0].tick;
      for (let i = 1; i < anchors.length; i++) {
        const left = anchors[i - 1], right = anchors[i];
        if (x < left.x) break;
        const fraction = clamp((x - left.x) / Math.max(1, right.x - left.x), 0, 1);
        tick = left.tick + fraction * (right.tick - left.tick);
        if (x < right.x) break;
      }
      return { tick: clamp(Math.floor(tick), start, start + duration - 1), exactTick: true,
        partIndex: currentScorePartIndex() };
    }
    return null;
  }

  // Engraving spaces notes by musical convention, not in proportion to time: a
  // leading clef, key and time signature, and the padding around every barline,
  // all take horizontal room that carries no duration. Reading a tick from how
  // far across the bar a click landed therefore points past the note that was
  // clicked, by a whole beat in the first bar of a system. The renderer knows
  // where it put each beat, so use its own answer and that beat's own tick.
  function beatTickAtScoreX(masterBounds, partIndex, scoreX) {
    const beats = barBoundsForPart(masterBounds, partIndex)?.beats;
    if (!beats?.length) return null;
    let chosen = null;
    for (const bounds of beats) {
      const beatStart = Number(bounds?.realBounds?.x);
      if (!Number.isFinite(beatStart)) continue;
      // Before the first beat counts as the first beat; otherwise a beat owns
      // the strip from where it starts up to where the next one starts.
      if (chosen && beatStart > scoreX) break;
      chosen = bounds;
    }
    const tick = Number(chosen?.beat?.absolutePlaybackStart);
    return Number.isFinite(tick) ? tick : null;
  }

  function snapTickToEighth(rawTick, originTick = 0) {
    const eighthTicks = Math.max(1, (Number(sequence?.division) || 1) / 2);
    return originTick + Math.round((rawTick - originTick) / eighthTicks) * eighthTicks;
  }

  function applyScoreScrubTarget(target) {
    if (!target || !engine || !ready) return;
    cancelVerticalFollowAnimation(true);
    const rawTick = clamp(Math.round(Number(target.tick) || 0), 0, latestSeekTick());
    const requestedTick = target.exactTick ? rawTick : clamp(snapTickToEighth(
      rawTick,
      Number.isFinite(target.snapStartTick) ? target.snapStartTick : 0,
    ), 0, latestSeekTick());
    if (Number.isInteger(target.partIndex) && visibleTracks.has(target.partIndex)) {
      selectedScorePartIndex = target.partIndex;
      elements.score.dataset.selectedPart = String(selectedScorePartIndex);
      elements.barScore.dataset.selectedPart = String(selectedScorePartIndex);
    }
    // An explicit seek cancels AlphaTab's old cursor transition. A raw audio
    // clock jump looks like continuous playback, especially into the next bar.
    api.tickPosition = requestedTick;
    selectedScoreTick = engine.tickAtSeconds(engine.currentSeconds());
    playbackDetached = false;
    hidePlaybackReturn();
    updateNoteActionLabel();
    renderSelectedPartHighlight();
    updateBarPlayhead(requestedTick);
    scheduleCursorTrim();
  }

  function cancelScoreScrub(pointer = null) {
    if (!scoreScrub || (pointer !== null && scoreScrub.pointerId !== pointer)) return;
    const { controller, surface, pointerId } = scoreScrub;
    scoreScrub = null;
    controller.abort();
    surface.classList.remove("is-scrubbing-score");
    document.documentElement.classList.remove("is-scrubbing-score");
    try {
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
    } catch {
      // The browser can release capture first when the pointer leaves the tab.
    }
  }

  function beginScoreScrub(event, targetAtPointer) {
    if (event.button !== 0 || !ready || !engine || pinchActive || typeof targetAtPointer !== "function") return;
    const initialTarget = targetAtPointer(event);
    if (!initialTarget) return;
    cancelScoreScrub();
    const surface = event.currentTarget;
    const pointerId = event.pointerId;
    const controller = new AbortController();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerType = event.pointerType || "mouse";
    const pressedAt = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    let scrubbing = false;
    scoreScrub = { controller, surface, pointerId };

    const beginDragScrub = (moveEvent) => {
      scrubbing = true;
      surface.classList.add("is-scrubbing-score");
      document.documentElement.classList.add("is-scrubbing-score");
      document.getSelection()?.removeAllRanges();
      try { surface.setPointerCapture(pointerId); } catch {}
      moveEvent.preventDefault();
      applyScoreScrubTarget(targetAtPointer(moveEvent));
    };

    const move = (moveEvent) => {
      if (!scoreScrub || moveEvent.pointerId !== pointerId) return;
      if (!scrubbing) {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.hypot(deltaX, deltaY) < 8) return;
        const clearlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
        // A finger drag is primarily a reading gesture. In vertical layout,
        // reserve only an unmistakably horizontal gesture for scrubbing; in
        // horizontal layout, all finger drags remain native score scrolling.
        if (pointerType === "touch" && (flow === "continuous" || surface.classList.contains("has-horizontal-overflow") || !clearlyHorizontal)) {
          cancelScoreScrub();
          return;
        }
        beginDragScrub(moveEvent);
        return;
      }
      moveEvent.preventDefault();
      document.getSelection()?.removeAllRanges();
      applyScoreScrubTarget(targetAtPointer(moveEvent));
    };
    const finish = (finishEvent) => {
      if (!scoreScrub || finishEvent.pointerId !== pointerId) return;
      finishEvent.preventDefault();
      // A tap commits only on release, after it is known not to be a scroll.
      const releasedAt = Number.isFinite(finishEvent.timeStamp) ? finishEvent.timeStamp : performance.now();
      if (scrubbing || releasedAt - pressedAt < PITCH_AUDITION_HOLD_MS) {
        applyScoreScrubTarget(scrubbing ? targetAtPointer(finishEvent) : initialTarget);
      }
      cancelScoreScrub();
    };
    window.addEventListener("pointermove", move, { signal: controller.signal, passive: false });
    window.addEventListener("pointerup", finish, { signal: controller.signal, passive: false });
    window.addEventListener("pointercancel", (cancelEvent) => cancelScoreScrub(cancelEvent.pointerId), { signal: controller.signal });
    window.addEventListener("lostpointercapture", (lostEvent) => cancelScoreScrub(lostEvent.pointerId), { signal: controller.signal });
  }

  // A pitch bar is drawn two semitones tall, centred on its own pitch, so a
  // press is on it when it lands within a semitone of that centre. Bars of
  // neighbouring pitches overlap, so the nearest one wins; a tie goes to the
  // part the score is following.
  function barNoteAt(tick, pitch, nearest = false) {
    const selected = currentScorePartIndex();
    const under = (sequence.notes || []).filter(([track, start, end, key]) =>
      visibleTracks.has(track) && tick >= start && tick < end && (nearest || Math.abs(key - pitch) <= 1));
    under.sort((left, right) => Math.abs(left[3] - pitch) - Math.abs(right[3] - pitch)
      || (right[0] === selected) - (left[0] === selected));
    return under.length ? { key: under[0][3], track: under[0][0] } : null;
  }

  function cancelPitchAuditions() {
    for (const finish of pitchAuditions.values()) finish();
    keyboardAudition?.();
    keyboardAudition = null;
  }

  function stepScoreNote(direction) {
    if (!ready || !engine || !api) return;
    const track = currentScorePartIndex();
    const here = engine.currentSeconds();
    const notes = engine.notes.flatMap((note) => note.segments || [note])
      .filter((note) => note.track === track).sort((a, b) => a.start - b.start);
    const target = direction > 0 ? notes.find((note) => note.start > here + 0.002)
      : [...notes].reverse().find((note) => note.start < here - 0.002);
    if (!target) return;
    const from = playbackCursorPlace();
    engine.pauseTransport();
    cancelPitchAuditions();
    applyScoreScrubTarget({ tick: engine.tickAtSeconds(target.start), exactTick: true, partIndex: track });
    const keys = [...new Set(notes.filter((note) => Math.abs(note.start - target.start) < 1e-6).map((note) => note.key))];
    const voices = keys.map((key) => engine.holdNote(key, track));
    const finish = () => {
      window.clearTimeout(timer);
      for (const voice of voices) voice.release();
      if (keyboardAudition === finish) keyboardAudition = null;
    };
    const timer = window.setTimeout(finish, KEYBOARD_NOTE_PREVIEW_SECONDS * 1000);
    keyboardAudition = finish;
    followCursorFrom(from);
  }

  // The starting region fixes note/chord mode. Audio is immediate; only an
  // unmoved short release seeks. Blank-space drags use beginScoreScrub instead.
  function beginPitchAudition(event, note, notesAtPointer, targetAtPointer) {
    if (event.button !== 0 || !note || !engine || !ready || pinchActive) return false;
    cancelScoreScrub();
    pitchAuditions.get(event.pointerId)?.();
    const fullChord = Boolean(note.fullChord);
    const voices = new Map();
    const pointerId = event.pointerId;
    const surface = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const pressedAt = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    const initialTarget = targetAtPointer?.(event);
    const controller = new AbortController();
    let dragging = false;
    const sound = (preview) => {
      const notes = preview?.notes || (preview ? [preview] : []);
      const next = new Map(notes.map((n) => [`${n.track}:${n.key}`, n]));
      for (const [id, voice] of voices) if (!next.has(id)) { voice.release(); voices.delete(id); }
      for (const [id, n] of next) if (!voices.has(id)) {
        voices.set(id, engine.holdNote(n.key, n.track, { fullChord }));
      }
    };
    const finish = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      pitchAuditions.delete(pointerId);
      for (const voice of voices.values()) voice.release();
      voices.clear();
      surface?.classList.remove("is-auditioning-score");
      try { if (surface?.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId); } catch {}
    };
    pitchAuditions.set(pointerId, finish);
    try {
      sound(note);
      // A chord-area press on a rest still unlocks audio for the ensuing drag.
      if (!voices.size) { engine.ensureAudio(); void engine.context.resume().catch(finish); }
    } catch { finish(); return false; }
    window.addEventListener("pointermove", (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 8) return;
        if (event.pointerType === "touch" && (flow === "continuous" || surface?.classList.contains("has-horizontal-overflow") || Math.abs(dx) <= Math.abs(dy) * 1.25)) {
          finish();
          return;
        }
        dragging = true;
        surface?.classList.add("is-auditioning-score");
        try { surface?.setPointerCapture(pointerId); } catch {}
      }
      moveEvent.preventDefault();
      document.getSelection()?.removeAllRanges();
      try { sound(notesAtPointer?.(moveEvent) ?? null); } catch { finish(); }
    }, { signal: controller.signal, passive: false });
    window.addEventListener("pointerup", (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      upEvent.preventDefault();
      // Cold audio startup can delay dispatch of an already released pointer.
      // Classify the physical input interval, not time spent running JavaScript.
      const releasedAt = Number.isFinite(upEvent.timeStamp) ? upEvent.timeStamp : performance.now();
      const tap = !dragging && releasedAt - pressedAt < PITCH_AUDITION_HOLD_MS;
      finish();
      if (tap && initialTarget) {
        applyScoreScrubTarget(initialTarget);
      }
    }, { signal: controller.signal });
    window.addEventListener("pointercancel", (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) finish();
    }, { signal: controller.signal });
    window.addEventListener("lostpointercapture", (lostEvent) => {
      if (lostEvent.pointerId === pointerId && lostEvent.target === surface) finish();
    }, { signal: controller.signal });
    event.currentTarget?.addEventListener("contextmenu", (contextEvent) => contextEvent.preventDefault(),
      { signal: controller.signal });
    return true;
  }

  function moveAnnotationRecord(currentId, tick, partIndex) {
    const nextId = annotationId(tick, partIndex);
    if (nextId === currentId) return currentId;
    if (annotations.has(nextId)) return null;
    const stored = annotations.get(currentId);
    if (stored) {
      annotations.delete(currentId);
      annotations.set(nextId, { ...stored, tick, partIndex });
    }
    if (editingAnnotation?.id === currentId) {
      editingAnnotation.id = nextId;
      editingAnnotation.tick = tick;
      editingAnnotation.partIndex = partIndex;
      editingAnnotation.focusRequested = false;
    }
    return nextId;
  }

  function beginAnnotationDrag(event, noteBox, tick, partIndex) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let currentId = noteBox.dataset.annotationId;
    let currentTick = tick;
    let currentPartIndex = partIndex;
    let moved = false;
    const controller = new AbortController();
    annotationDragActive = true;
    document.documentElement.classList.add("is-dragging-annotation");
    if (editingAnnotation?.id === currentId) {
      editingAnnotation.draft = noteBox.querySelector(".score-note-editor")?.value || editingAnnotation.draft;
      editingAnnotation.focusRequested = false;
    }

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 3) return;
      const target = standardScoreTargetAtClientPoint(moveEvent.clientX, moveEvent.clientY, currentPartIndex);
      if (!target || (target.tick === currentTick && target.partIndex === currentPartIndex)) return;
      const nextId = moveAnnotationRecord(currentId, target.tick, target.partIndex);
      if (!nextId) return;
      currentId = nextId;
      currentTick = target.tick;
      currentPartIndex = target.partIndex;
      moved = true;
      renderAnnotations();
    };
    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      controller.abort();
      annotationDragActive = false;
      document.documentElement.classList.remove("is-dragging-annotation");
      if (!moved) return;
      saveAnnotations();
      if (editingAnnotation?.id === currentId) editingAnnotation.focusRequested = true;
      renderAnnotations();
      showToast(`Annotation moved to ${scoreLocationAtTick(currentTick)}`);
    };
    window.addEventListener("pointermove", move, { signal: controller.signal, passive: false });
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  }

  function renderAnnotations() {
    const previousEditor = elements.score.querySelector(".score-note-editor");
    if (editingAnnotation && previousEditor) {
      editingAnnotation.draft = previousEditor.value;
      if (!annotationDragActive && document.activeElement === previousEditor) editingAnnotation.focusRequested = true;
    }
    elements.score.querySelector(".score-note-layer")?.remove();
    if ((!annotations.size && !editingAnnotation) || !api) return;
    const lookup = api.boundsLookup || api.renderer?.boundsLookup;
    if (!lookup?.findMasterBarByIndex) return;
    const layer = document.createElement("div");
    layer.className = "score-note-layer";
    const scoreWidth = Math.max(elements.score.clientWidth, elements.score.scrollWidth);
    layer.style.width = `${scoreWidth}px`;
    layer.style.height = `${Math.max(elements.score.clientHeight, elements.score.scrollHeight)}px`;

    const renderedBeatBoundsAtTick = (tick, partIndex) => {
      const track = scoreTracks[partIndex];
      if (!track || !visibleTracks.has(partIndex)) return null;
      for (const staff of track.staves || []) {
        for (const bar of staff.bars || []) {
          for (const voice of bar.voices || []) {
            for (const beat of voice.beats || []) {
              if (Number(beat.absolutePlaybackStart) !== tick) continue;
              const beatBounds = lookup.findBeat?.(beat);
              if (beatBounds) return beatBounds;
            }
          }
        }
      }
      return null;
    };

    const items = [...annotations.values()]
      .filter((annotation) => annotationId(annotation.tick, annotation.partIndex) !== editingAnnotation?.id)
      .map((annotation) => ({ ...annotation, editing: false }));
    if (editingAnnotation) items.push({ ...editingAnnotation, text: editingAnnotation.draft, editing: true });
    items.sort((left, right) => left.tick - right.tick || left.partIndex - right.partIndex);

    items.forEach(({ id, tick, partIndex, text, editing }) => {
      if (!visibleTracks.has(partIndex)) return;
      const measureIndex = measureIndexAtTick(tick);
      const masterBounds = lookup.findMasterBarByIndex(measureIndex);
      const staffBounds = barBoundsForPart(masterBounds, partIndex);
      const box = staffBounds?.realBounds || staffBounds?.visualBounds;
      if (!box) return;
      const x = Number(box.x);
      const staffTop = Number(box.y);
      const width = Number(box.w);
      if (![x, staffTop, width].every(Number.isFinite)) return;
      const [measureStart, measureDuration] = sequence.measures[measureIndex];
      const fraction = measureDuration > 0 ? clamp((tick - measureStart) / measureDuration, 0, 1) : 0;
      const beatX = Number(renderedBeatBoundsAtTick(tick, partIndex)?.onNotesX);
      const anchorX = Number.isFinite(beatX) ? beatX : x + width * fraction;
      const anchorBottom = Math.max(6, staffTop - 5);
      const location = scoreLocationAtTick(tick);
      const partName = parts[partIndex]?.name || `Part ${partIndex + 1}`;
      const partColor = parts[partIndex]?.color || partPaint(partIndex);
      const noteText = String(text || "");
      const boxWidth = scoreNoteBoxWidth(noteText, location);
      const boxLeft = anchorX + 4;
      layer.style.width = `${Math.max(Number.parseFloat(layer.style.width) || scoreWidth, boxLeft + boxWidth + 8)}px`;

      const pin = document.createElement("span");
      pin.className = "score-note-pin";
      pin.style.setProperty("--part-color", partColor);
      pin.style.left = `${Math.max(0, anchorX)}px`;
      pin.style.top = `${anchorBottom}px`;
      pin.style.height = `${Math.max(5, staffTop - anchorBottom)}px`;
      layer.append(pin);

      const noteBox = document.createElement("div");
      noteBox.className = `score-note-box${editing ? " is-editing" : ""}`;
      noteBox.dataset.annotationId = id || annotationId(tick, partIndex);
      noteBox.dataset.partIndex = String(partIndex);
      noteBox.dataset.tick = String(tick);
      noteBox.style.setProperty("--part-color", partColor);
      noteBox.style.left = `${Math.max(2, boxLeft)}px`;
      noteBox.style.top = `${anchorBottom}px`;
      noteBox.style.width = `${boxWidth}px`;
      const address = document.createElement("button");
      address.type = "button";
      address.className = "score-note-location";
      address.textContent = location;
      address.title = `Drag to move ${partName} annotation`;
      address.setAttribute("aria-label", `Move ${partName} annotation at ${location}`);
      address.addEventListener("pointerdown", (event) => beginAnnotationDrag(event, noteBox, tick, partIndex));
      address.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "score-note-delete";
      deleteButton.title = `Delete ${partName} annotation at ${location}`;
      deleteButton.setAttribute("aria-label", `Delete ${partName} annotation at ${location}`);
      const deleteIcon = createSvgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" });
      deleteIcon.append(createSvgElement("path", { d: "M18 6 6 18M6 6l12 12" }));
      deleteButton.append(deleteIcon);
      deleteButton.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (editingAnnotation?.id === noteBox.dataset.annotationId) editingAnnotation = null;
        if (annotations.has(noteBox.dataset.annotationId)) deleteAnnotation(tick, partIndex);
        else renderAnnotations();
      });

      if (editing) {
        const editor = document.createElement("textarea");
        editor.className = "score-note-editor";
        editor.rows = 1;
        editor.wrap = "off";
        editor.maxLength = 500;
        editor.value = noteText;
        editor.setAttribute("aria-label", `Annotation for ${partName} at measure ${location}`);
        editor.addEventListener("pointerdown", (event) => event.stopPropagation());
        editor.addEventListener("input", () => {
          if (!editingAnnotation || editingAnnotation.id !== noteBox.dataset.annotationId) return;
          editingAnnotation.draft = editor.value;
          const nextWidth = scoreNoteBoxWidth(editor.value, location);
          noteBox.style.width = `${nextWidth}px`;
          layer.style.width = `${Math.max(scoreWidth, boxLeft + nextWidth + 8)}px`;
          resizeInlineNoteEditor(editor);
        });
        editor.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            commitInlineNoteEdit(true);
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            editingAnnotation.draft = editor.value;
            commitInlineNoteEdit();
          }
        });
        editor.addEventListener("blur", () => {
          if (!editingAnnotation || editingAnnotation.id !== noteBox.dataset.annotationId) return;
          editingAnnotation.draft = editor.value;
          commitInlineNoteEdit();
        });
        noteBox.append(deleteButton, address, editor);
        requestAnimationFrame(() => {
          resizeInlineNoteEditor(editor);
          if (!editingAnnotation?.focusRequested || editingAnnotation.id !== noteBox.dataset.annotationId) return;
          editingAnnotation.focusRequested = false;
          editor.focus();
          editor.setSelectionRange(editor.value.length, editor.value.length);
        });
      } else {
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "score-note-edit";
        const message = document.createElement("span");
        message.className = "score-note-message";
        message.textContent = noteText;
        editButton.append(message);
        editButton.title = `Edit ${partName} annotation at ${location}`;
        editButton.setAttribute("aria-label", `Edit ${partName} annotation at ${location}: ${noteText}`);
        editButton.addEventListener("click", (event) => {
          event.stopPropagation();
          startInlineNoteEdit(tick, partIndex);
        });
        noteBox.append(deleteButton, address, editButton);
      }
      layer.append(noteBox);
    });
    elements.score.append(layer);
  }

  function centerFullMeasureRests() {
    if (!api || !sequence?.measures?.length) return;
    const lookup = api.boundsLookup || api.renderer?.boundsLookup;
    if (!lookup?.findMasterBarByIndex) return;

    const targets = new Map();
    let barCount = 0;
    sequence.measures.forEach((_, index) => {
      const bounds = lookup.findMasterBarByIndex(index);
      if (!bounds) return;
      barCount += 1;
      for (const bar of bounds.bars || []) for (const beat of bar.beats || []) {
        if (!beat.beat.isFullBarRest || beat.beat.isEmpty) continue;
        const box = beat.realBounds;
        if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.w) || box.w <= 0) continue;
        // Beat bounds exclude the clef, key/time signature and closing barline.
        // Centering in the entire bar can put a rest on top of the time signature.
        targets.set(`b${beat.beat.id}`, {index, x: box.x + box.w / 2});
      }
    });
    elements.score.dataset.fullRestBarCount = String(barCount);

    const scoreRect = elements.score.getBoundingClientRect();
    const localPoint = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left - scoreRect.left + elements.score.scrollLeft + rect.width / 2,
        y: rect.top - scoreRect.top + elements.score.scrollTop + rect.height / 2,
      };
    };
    let glyphCount = 0;
    let centeredCount = 0;
    elements.score.querySelectorAll(".at-surface-svg text").forEach((rest) => {
      // SMuFL restWhole (U+E4E3). AlphaTab recognizes MusicXML measure rests,
      // but v1.8.4 places their glyph at beat zero instead of the bar center.
      if (rest.textContent !== "\uE4E3") return;
      glyphCount += 1;
      const group = rest.parentElement;
      if (!group) return;
      let target;
      for (let owner = group; owner && owner !== elements.score; owner = owner.parentElement) {
        const id = [...(owner.classList || [])].find(name => targets.has(name));
        if (id) { target = targets.get(id); break; }
      }
      if (!target) return;
      if (group.dataset.fullRestOriginalTransform === undefined) {
        group.dataset.fullRestOriginalTransform = group.getAttribute("transform") || "";
      }
      group.setAttribute("transform", group.dataset.fullRestOriginalTransform);
      const point = localPoint(rest);
      const targetX = target.x;
      const deltaX = (targetX - point.x) / (group.getScreenCTM()?.a || 1);
      group.setAttribute("transform", `${group.dataset.fullRestOriginalTransform} translate(${deltaX} 0)`);
      group.dataset.fullRestCentered = "true";
      group.dataset.fullRestMeasure = String(target.index + 1);
      group.dataset.fullRestTargetX = String(targetX);
      centeredCount += 1;
    });
    elements.score.dataset.fullRestGlyphCount = String(glyphCount);
    elements.score.dataset.fullRestCenteredCount = String(centeredCount);
  }

  function scheduleFullMeasureRestCentering() {
    const generation = ++fullRestCenterGeneration;
    let frame = 0;
    const centerAfterPaint = () => {
      if (generation !== fullRestCenterGeneration) return;
      centerFullMeasureRests();
      frame += 1;
      // AlphaTab's renderFinished event can precede replacement SVG attachment
      // by several frames during reflow. Repeating is safe because each pass
      // restores the original transform before calculating a fresh offset.
      if (frame < 8) requestAnimationFrame(centerAfterPaint);
    };
    requestAnimationFrame(centerAfterPaint);
  }

  function measureIndexAtTick(tick) {
    if (!sequence?.measures?.length) return 0;
    let low = 0;
    let high = sequence.measures.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence.measures[middle][0] <= tick) low = middle + 1;
      else high = middle;
    }
    return clamp(low - 1, 0, sequence.measures.length - 1);
  }

  function currentMeasureIndex() {
    if (!engine) return 0;
    const tick = engine.tickAtSeconds(engine.currentSeconds());
    // Both loop controls include the selected measure, including its downbeat.
    // Tolerate roundoff when converting a clicked tick through playback seconds.
    return measureIndexAtTick(tick + 1e-6);
  }

  function updateLoopState({ persist = false } = {}) {
    const hasStart = Number.isInteger(loopStartMeasure);
    const hasEnd = Number.isInteger(loopEndMeasure);
    elements.loopStart.classList.toggle("is-set", hasStart);
    elements.loopEnd.classList.toggle("is-set", hasEnd);
    elements.loopStart.textContent = hasStart ? String(loopStartMeasure + 1) : "Start";
    elements.loopEnd.textContent = hasEnd ? String(loopEndMeasure + 1) : "End";
    elements.loopStart.setAttribute("aria-label", hasStart ? `Set loop start to selected measure; currently measure ${loopStartMeasure + 1}` : "Set loop start to selected measure");
    elements.loopEnd.setAttribute("aria-label", hasEnd ? `Set loop end to selected measure; currently measure ${loopEndMeasure + 1}` : "Set loop end to selected measure");
    elements.loopStart.dataset.help = hasStart ? `Move loop start; currently measure ${loopStartMeasure + 1}.` : "Set loop start at selected measure. Shortcut: [";
    elements.loopEnd.dataset.help = hasEnd ? `Move loop end; currently measure ${loopEndMeasure + 1}.` : "Set loop end at selected measure. Shortcut: ]";
    [elements.loopStart, elements.loopEnd].forEach((button) => {
      button.dataset.help += " Hold to clear the loop.";
      button.title = button.dataset.help;
    });
    // A closing repeat with no opening one repeats from the top, the way it
    // does in print, so an End on its own is a complete loop. An opening one
    // alone is not: there is nothing yet to come back from.
    elements.loopControls.classList.toggle("has-partial-loop", hasStart && !hasEnd);
    elements.loopControls.classList.toggle("has-complete-loop", hasEnd);

    if (hasEnd) {
      const start = hasStart ? sequence.measures[loopStartMeasure][0] : 0;
      const endMeasure = sequence.measures[loopEndMeasure];
      const end = endMeasure[0] + endMeasure[1];
      engine?.setLoop(start, end);
      const left = clamp((start / sequence.endTick) * 100, 0, 100);
      const right = clamp((end / sequence.endTick) * 100, left, 100);
      elements.loopBand.style.left = `${left}%`;
      elements.loopBand.style.width = `${right - left}%`;
      elements.loopBand.classList.add("is-active");
    } else {
      engine?.setLoop(null, null);
      elements.loopBand.classList.remove("is-active");
    }
    if (scoreView === "bars" && sequence?.measures?.length) scheduleBarRender();
    if (persist) savePreferences();
  }

  function setLoopPoint(kind) {
    const current = currentMeasureIndex();
    if (kind === "start") {
      loopStartMeasure = current;
      if (Number.isInteger(loopEndMeasure) && Number.isInteger(loopStartMeasure) && loopStartMeasure > loopEndMeasure) loopEndMeasure = null;
    } else {
      loopEndMeasure = current;
      if (Number.isInteger(loopStartMeasure) && Number.isInteger(loopEndMeasure) && loopEndMeasure < loopStartMeasure) loopStartMeasure = null;
    }
    updateLoopState({ persist: true });
    if (Number.isInteger(loopStartMeasure) && Number.isInteger(loopEndMeasure)) {
      showToast(`Looping measures ${loopStartMeasure + 1}–${loopEndMeasure + 1}`);
    }
  }

  function clearLoop() {
    loopStartMeasure = null;
    loopEndMeasure = null;
    updateLoopState({ persist: true });
  }

  function autoChapters() {
    const explicit = Array.isArray(config.chapters) && config.chapters.length ? config.chapters : sequence.chapters;
    if (Array.isArray(explicit) && explicit.length) {
      return explicit.map((chapter, index) => ({
        tick: Number(chapter.tick ?? sequence.measures?.[Math.max(0, Number(chapter.measure || 1) - 1)]?.[0] ?? 0),
        label: String(chapter.label || chapter.name || `Section ${index + 1}`),
      })).sort((left, right) => left.tick - right.tick);
    }
    const groupSize = sequence.measures.length > 48 ? 8 : 4;
    return sequence.measures.filter((_, index) => index % groupSize === 0).map((measure, index) => ({
      tick: measure[0],
      label: `Measure ${index * groupSize + 1}`,
    }));
  }

  function buildTimelineSegments() {
    elements.timelineSegments.innerHTML = "";
    const listed = autoChapters()
      .filter((chapter) => Number.isFinite(chapter.tick) && chapter.tick >= 0 && chapter.tick < sequence.endTick)
      .filter((chapter, index, all) => index === 0 || chapter.tick > all[index - 1].tick);
    const chapters = listed[0]?.tick === 0 ? listed : [{ tick: 0, label: "Start" }, ...listed];
    const chapterTimes = chapters.map((chapter) => engine.secondsAtTick(chapter.tick) * 1000);
    const durationMilliseconds = engine.duration * 1000;
    chapterSeekMilliseconds = [...new Set([
      0,
      ...chapterTimes.map((milliseconds) => Math.round(milliseconds)),
      Math.round(durationMilliseconds),
    ])].sort((left, right) => left - right);
    const boundaries = [...chapterTimes, durationMilliseconds];
    chapters.forEach((chapter, index) => {
      const span = document.createElement("span");
      span.className = "timeline-segment is-chapter";
      span.style.flexGrow = String(Math.max(1, boundaries[index + 1] - chapterTimes[index]));
      span.dataset.chapterMilliseconds = String(Math.round(chapterTimes[index]));
      span.title = chapter.label;
      elements.timelineSegments.append(span);
    });
  }

  function snapSeekMilliseconds(milliseconds) {
    const maximum = Number(elements.seek.max) || Math.round((engine?.duration || 0) * 1000) || 1;
    const value = clamp(Number(milliseconds) || 0, 0, maximum);
    // Every snap point attracts anything within a measure of it, so leaving the
    // end of the piece in would swallow the whole final bar and there would be
    // no way to place the playhead inside it. It is not a section to practise
    // from either; End still goes there directly.
    const points = (chapterSeekMilliseconds.length ? chapterSeekMilliseconds : [0, maximum])
      .filter((point) => point < maximum);
    const nearest = points.reduce((best, point) => {
      const [lower, upper] = chapterSnapBoundsMilliseconds(point);
      if (value < lower || value > upper) return best;
      const distance = Math.abs(point - value);
      return !best || distance < best.distance ? { point, distance } : best;
    }, null);
    return nearest?.point ?? value;
  }

  function chapterSnapBoundsMilliseconds(chapterMilliseconds) {
    if (!engine || !sequence?.measures?.length) return [chapterMilliseconds, chapterMilliseconds];
    const chapterTick = clamp(engine.tickAtSeconds(chapterMilliseconds / 1000), 0, sequence.endTick);
    const referenceTick = Math.min(chapterTick, Math.max(0, sequence.endTick - 1));
    const measure = sequence.measures[measureIndexAtTick(referenceTick)];
    const measureDurationTicks = Math.max(1, Number(measure?.[1]) || engine.division * 4);
    const lowerTick = Math.max(0, chapterTick - measureDurationTicks);
    const upperTick = Math.min(sequence.endTick, chapterTick + measureDurationTicks);
    return [engine.secondsAtTick(lowerTick) * 1000, engine.secondsAtTick(upperTick) * 1000];
  }

  function adjacentChapterMilliseconds(milliseconds, direction) {
    const value = Number(milliseconds) || 0;
    if (direction > 0) return chapterSeekMilliseconds.find((point) => point > value + 1) ?? chapterSeekMilliseconds.at(-1) ?? value;
    return [...chapterSeekMilliseconds].reverse().find((point) => point < value - 1) ?? chapterSeekMilliseconds[0] ?? value;
  }

  // Seeking too close to the score's last tick reads as past the end to the
  // player, which answers by rewinding to the beginning. Measured on this
  // build the last tick that behaves is two short of the end, so stop a
  // sixty-fourth short: far too little to hear, and it does not depend on
  // where exactly the player draws that line.
  function latestSeekTick() {
    const endTick = Number(sequence?.endTick) || 1;
    const division = Number(sequence?.division) || 960;
    return Math.max(0, endTick - Math.max(1, Math.round(division / 16)));
  }

  function seekTickFor(milliseconds) {
    return clamp(Math.round(engine.tickAtSeconds(Number(milliseconds) / 1000)), 0, latestSeekTick());
  }

  function restorePlaybackPosition(milliseconds) {
    if (!ready || !engine || !api || typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return false;
    // Collection restoration is an exact location, not a chapter-scrubbing gesture.
    api.tickPosition = seekTickFor(milliseconds);
    return true;
  }

  // The timeline's section names were only ever hover titles, which a touch
  // screen never shows. While a finger scrubs, the section under the thumb
  // sits on the rail, where sliding the finger down reveals it, and goes on
  // release. Nothing is added to the header between gestures.
  let scrubLabelPointer = null;

  function chapterLabelAt(milliseconds) {
    let label = "";
    // A song without sections has only its "Start", which says nothing.
    if (elements.timelineSegments.children.length < 2) return label;
    for (const segment of elements.timelineSegments.children) {
      if (Number(segment.dataset.chapterMilliseconds) > milliseconds + 1) break;
      label = segment.title;
    }
    return label;
  }

  function showScrubLabel(milliseconds) {
    const label = chapterLabelAt(milliseconds);
    if (!label) {
      elements.scrubLabel.hidden = true;
      return;
    }
    elements.scrubLabel.textContent = label;
    elements.scrubLabel.hidden = false;
    const rail = elements.timelineRail.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(elements.timelineRail).getPropertyValue("--seek-thumb-size")) || 16;
    const fraction = clamp(milliseconds / (Number(elements.seek.max) || 1), 0, 1);
    const x = rail.left + thumb / 2 + (rail.width - thumb) * fraction;
    const box = elements.scrubLabel.getBoundingClientRect();
    elements.scrubLabel.style.left = `${clamp(x - box.width / 2, 8, Math.max(8, window.innerWidth - box.width - 8))}px`;
    elements.scrubLabel.style.top = `${rail.top + rail.height / 2 - box.height / 2}px`;
  }

  function hideScrubLabel() {
    scrubLabelPointer = null;
    elements.scrubLabel.hidden = true;
  }

  function previewSeek(milliseconds, updateScore = false) {
    const value = snapSeekMilliseconds(milliseconds);
    elements.seek.value = String(value);
    elements.currentTime.textContent = formatTime(value);
    updateSeekAppearance(value);
    if (updateScore && ready && engine && api) {
      cancelVerticalFollowAnimation(true);
      api.tickPosition = seekTickFor(value);
    }
    return value;
  }

  // Firefox on macOS only. Opening a microphone there rebuilds the page's
  // audio graph on a private aggregate device whose first outputs belong to
  // the microphone, so a USB mic with its own headphone jack silently takes
  // every sound the page makes for as long as it is open. Firefox keeps one
  // graph per sample rate and the microphone always joins the native-rate
  // one, so playback on any other rate stays on the system output.
  function isolatedPlaybackRate(AudioContextClass) {
    const agent = navigator.userAgent;
    if (!/\bFirefox\//.test(agent) || !/Macintosh/.test(agent)) return 0;
    try {
      const probe = new AudioContextClass();
      const nativeRate = probe.sampleRate;
      void probe.close();
      return nativeRate === 44100 ? 48000 : 44100;
    } catch {
      return 0;
    }
  }

  class GuideEngine {
    constructor(data) {
      this.division = data.division;
      this.endTick = data.endTick;
      this.tempoSegments = this.buildTempoSegments(data.tempos || []);
      this.duration = this.secondsAtTick(this.endTick);
      const raw = data.notes.map(([track, startTick, endTick, key, velocity]) => ({
        track,
        key,
        velocity,
        start: this.secondsAtTick(startTick),
        end: this.secondsAtTick(endTick),
      }));
      const joined = new Set(), phrases = [];
      for (const chain of data.legato || []) {
        const segments = chain.map((index) => raw[index]);
        if (segments.length < 2 || new Set(chain).size !== chain.length || chain.some((index) => joined.has(index)) ||
            segments.some((note, i) => !note || note.end <= note.start || (i &&
              (note.track !== segments[0].track || Math.abs(segments[i - 1].end - note.start) > 1e-6)))) continue;
        phrases.push({ ...segments[0], end: segments.at(-1).end, segments });
        chain.forEach((index) => joined.add(index));
      }
      this.notes = [...phrases, ...raw.filter((_, index) => !joined.has(index))]
        .filter((note) => note.end > note.start).sort((left, right) => left.start - right.start || left.track - right.track);
      this.clicks = this.buildMetronomeEvents(data.measures || []);
      this.rate = 1;
      this.basePosition = 0;
      this.anchorTime = 0;
      this.playing = false;
      this.starting = false;
      this.startRequest = 0;
      this.preparing = false;
      this.transportRequest = 0;
      this.onPreparationChanged = null;
      this.context = null;
      this.playbackIsolated = false;
      this.master = null;
      this.transition = null;
      this.trackStrips = [];
      this.wave = null;
      this.timer = 0;
      this.nextNoteIndex = 0;
      this.nextClickIndex = 0;
      this.scheduled = new Set();
      this.held = new Set();
      this.output = null;
      this.api = null;
      this.metronomeVolume = 0;
      this.loopStartSeconds = null;
      this.loopEndSeconds = null;
    }

    buildTempoSegments(raw) {
      const deduped = new Map();
      raw.forEach(([tick, bpm]) => deduped.set(Number(tick), Number(bpm)));
      if (!deduped.has(0)) deduped.set(0, Number(config.writtenTempo) || 120);
      const ordered = [...deduped].sort((left, right) => left[0] - right[0]);
      let seconds = 0;
      return ordered.map(([tick, bpm], index) => {
        if (index) {
          const [previousTick, previousBpm] = ordered[index - 1];
          seconds += ((tick - previousTick) * 60) / (previousBpm * this.division);
        }
        return { tick, bpm: Math.max(1, bpm), seconds };
      });
    }

    secondsAtTick(tick) {
      let low = 0;
      let high = this.tempoSegments.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (this.tempoSegments[middle].tick <= tick) low = middle + 1;
        else high = middle;
      }
      const segment = this.tempoSegments[Math.max(0, low - 1)];
      return segment.seconds + ((tick - segment.tick) * 60) / (segment.bpm * this.division);
    }

    tickAtSeconds(seconds) {
      let low = 0;
      let high = this.tempoSegments.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (this.tempoSegments[middle].seconds <= seconds) low = middle + 1;
        else high = middle;
      }
      const segment = this.tempoSegments[Math.max(0, low - 1)];
      return segment.tick + ((seconds - segment.seconds) * segment.bpm * this.division) / 60;
    }

    buildMetronomeEvents(measures) {
      const events = [];
      measures.forEach(([startTick, duration, numerator, denominator]) => {
        let count = Number(numerator) || 4;
        let beatTicks = (this.division * 4) / (Number(denominator) || 4);
        if (count > 3 && count % 3 === 0 && Number(denominator) === 8) {
          count /= 3;
          beatTicks *= 3;
        }
        for (let beat = 0; beat < count; beat += 1) {
          const tick = Math.min(Number(startTick) + Number(duration), Number(startTick) + beat * beatTicks);
          events.push({ tick, time: this.secondsAtTick(tick), downbeat: beat === 0 });
        }
      });
      return events.sort((left, right) => left.time - right.time);
    }

    attach(apiInstance) {
      this.api = apiInstance;
      this.output = apiInstance.player?.output || null;
      if (!this.output) throw new Error("External playback output is unavailable");
      const engineInstance = this;
      this.output.handler = {
        get backingTrackDuration() { return engineInstance.duration * 1000; },
        get playbackRate() { return engineInstance.rate; },
        set playbackRate(value) { engineInstance.setRate(value); },
        get masterVolume() { return 1; },
        set masterVolume(_value) {},
        seekTo(milliseconds) {
          const alphaTabRate = clamp(Number(engineInstance.api?.playbackSpeed) || engineInstance.rate, 0.25, 1.5);
          if (Math.abs(alphaTabRate - engineInstance.rate) > 0.000001) return;
          engineInstance.seek((milliseconds / 1000) * alphaTabRate);
        },
        play() { void engineInstance.play(); },
        pause() { engineInstance.pause(); },
      };
    }

    ensureAudio() {
      if (this.context) return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable");
      const isolatedRate = isolatedPlaybackRate(AudioContextClass);
      try {
        this.context = new AudioContextClass(isolatedRate
          ? { latencyHint: "interactive", sampleRate: isolatedRate }
          : { latencyHint: "interactive" });
      } catch { this.context = new AudioContextClass(); }
      this.playbackIsolated = isolatedRate > 0 && this.context.sampleRate === isolatedRate;

      this.master = this.context.createGain();
      this.master.gain.value = 0.92;
      this.transition = this.context.createGain();
      this.transition.gain.value = 1;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 14;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.16;
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.08;
      this.master.connect(this.transition).connect(compressor).connect(limiter).connect(this.context.destination);

      this.trackStrips = parts.map(() => {
        const gain = this.context.createGain();
        const panner = typeof this.context.createStereoPanner === "function" ? this.context.createStereoPanner() : null;
        if (panner) gain.connect(panner).connect(this.master);
        else gain.connect(this.master);
        return { gain, panner };
      });
      const real = new Float32Array([0, 0, 0, 0, 0, 0]);
      const imaginary = new Float32Array([0, 1, 0.44, 0.20, 0.10, 0.04]);
      this.wave = this.context.createPeriodicWave(real, imaginary, { disableNormalization: false });
      this.updateMix(audibleTracks, trackVolumes, trackPans, true);
    }

    currentSeconds() {
      if (!this.playing || !this.context) return this.basePosition;
      return clamp(this.basePosition + (this.context.currentTime - this.anchorTime) * this.rate, 0, this.duration);
    }

    async prepareAudio() {
      this.ensureAudio();
      if (this.context.state !== "running") await this.context.resume();
      if (this.context.state !== "running") throw new Error("Audio output is not running");
    }

    async startTransport() {
      if (!this.api || this.playing || this.starting || this.preparing) return;
      const request = ++this.transportRequest;
      this.preparing = true;
      this.onPreparationChanged?.();
      try {
        // Activate inside the gesture, before AlphaTab marks playback started.
        await this.prepareAudio();
        if (request === this.transportRequest) {
          if (this.basePosition >= this.duration - 0.005) this.api.tickPosition = 0;
          this.api.play();
        }
      } catch (error) {
        if (request !== this.transportRequest) return;
        console.error(error);
        showToast("Audio could not start", "error");
      } finally {
        if (request === this.transportRequest) {
          this.preparing = false;
          this.onPreparationChanged?.();
        }
      }
    }

    pauseTransport() {
      // AlphaTab can still be stopped while audio preparation is pending.
      this.pause();
      this.api?.pause();
    }

    toggleTransport() {
      if (this.playing || this.starting || this.preparing) this.pauseTransport();
      else void this.startTransport();
    }

    async play() {
      if (this.playing || this.starting) return;
      const request = ++this.startRequest;
      this.starting = true;
      try {
        await this.prepareAudio();
        if (request !== this.startRequest) return;
        // AlphaTab's initial cursor can land ~1 ms past zero. That rounding
        // offset must not make the scheduler discard every opening note.
        if (this.basePosition <= 0.002 || this.basePosition >= this.duration - 0.005) this.basePosition = 0;
        // Pressing play with a loop set plays the loop, wherever the playhead was.
        if (this.hasLoop() && !this.withinLoop(this.basePosition)) this.basePosition = this.loopStartSeconds;
        this.loopArmed = this.withinLoop(this.basePosition);
        this.playing = true;
        this.anchorTime = this.context.currentTime;
        this.resetScheduler();
        window.clearInterval(this.timer);
        this.timer = window.setInterval(() => this.update(), SCHEDULER_INTERVAL_MS);
        this.update();
      } catch (error) {
        if (request !== this.startRequest) return;
        console.error(error);
        showToast("Audio could not start", "error");
        this.api?.pause();
      } finally {
        if (request === this.startRequest) this.starting = false;
      }
    }

    pause() {
      ++this.startRequest;
      ++this.transportRequest;
      this.starting = false;
      if (this.preparing) {
        this.preparing = false;
        this.onPreparationChanged?.();
      }
      if (this.playing) this.basePosition = this.currentSeconds();
      this.playing = false;
      window.clearInterval(this.timer);
      this.timer = 0;
      this.stopVoices();
    }

    seek(seconds) {
      // A seek goes where it was asked to go, even past the loop end: moving
      // out there is how the loop's end gets moved further out. Playback only
      // wraps once it has been inside the loop, so landing beyond it plays on
      // instead of snapping straight back.
      const requested = clamp(seconds, 0, this.duration);
      this.basePosition = requested;
      this.loopArmed = this.withinLoop(requested);
      if (this.context) this.anchorTime = this.context.currentTime;
      this.stopVoices();
      if (this.playing) this.resetScheduler();
      this.pushPosition();
    }

    setRate(nextRate) {
      const next = clamp(Number(nextRate) || 1, 0.25, 1.5);
      if (Math.abs(next - this.rate) < 0.000001) return;
      this.basePosition = this.currentSeconds();
      this.rate = next;
      if (this.context) this.anchorTime = this.context.currentTime;
      if (this.playing && this.context && this.transition) {
        const now = this.context.currentTime;
        this.transition.gain.cancelScheduledValues(now);
        this.transition.gain.setValueAtTime(Math.max(0.0001, this.transition.gain.value), now);
        this.transition.gain.linearRampToValueAtTime(0.0001, now + 0.018);
        this.stopVoices(0.018);
        this.resetScheduler(0.045, { carryHeldNotes: true });
        this.transition.gain.setValueAtTime(0.0001, now + 0.026);
        this.transition.gain.linearRampToValueAtTime(1, now + 0.075);
      }
      this.pushPosition();
    }

    setMetronome(value) {
      this.metronomeVolume = clamp(Number(value) || 0, 0, 100) / 100;
      if (this.playing) this.nextClickIndex = this.findNext(this.clicks, this.currentSeconds(), "time");
    }

    setPracticeDivisi(track, line) {
      const key = Number.isInteger(track) && Number.isInteger(line) ? `${track}:${line}` : "all";
      if (this.divisiPlaybackKey === key) return;
      this.divisiPlaybackKey = key;
      this.playbackNotes = divisiPlaybackNotes(this.notes, track, line, (tick) => this.secondsAtTick(tick));
      if (this.playing && this.context) {
        this.basePosition = this.currentSeconds();
        this.anchorTime = this.context.currentTime;
        this.stopVoices(0.018);
        this.resetScheduler(0.028, { carryHeldNotes: true });
      }
    }

    setLoop(startTick, endTick) {
      if (!Number.isFinite(startTick) || !Number.isFinite(endTick) || endTick <= startTick) {
        this.loopStartSeconds = null;
        this.loopEndSeconds = null;
        return;
      }
      this.loopStartSeconds = this.secondsAtTick(startTick);
      this.loopEndSeconds = this.secondsAtTick(endTick);
      this.loopArmed = this.withinLoop(this.currentSeconds());
      if (this.playing && (this.currentSeconds() < this.loopStartSeconds || this.currentSeconds() >= this.loopEndSeconds)) this.seek(this.loopStartSeconds);
    }

    hasLoop() { return Number.isFinite(this.loopStartSeconds) && Number.isFinite(this.loopEndSeconds); }

    withinLoop(position) {
      return this.hasLoop() && position >= this.loopStartSeconds && position < this.loopEndSeconds;
    }

    updateMix(audible, volumes, pans, immediate = false) {
      if (!this.context || !this.trackStrips.length) return;
      const now = this.context.currentTime;
      this.trackStrips.forEach((strip, index) => {
        const target = audible.has(index) ? clamp((Number(volumes[index]) || 0) / 100, 0, 1.5) : 0;
        strip.gain.gain.cancelScheduledValues(now);
        if (immediate) strip.gain.gain.setValueAtTime(target, now);
        else strip.gain.gain.setTargetAtTime(target, now, 0.012);
        if (strip.panner) {
          const pan = clamp((Number(pans[index]) || 0) / 100, -1, 1);
          strip.panner.pan.cancelScheduledValues(now);
          if (immediate) strip.panner.pan.setValueAtTime(pan, now);
          else strip.panner.pan.setTargetAtTime(pan, now, 0.018);
        }
      });
    }

    findNext(items, position, field) {
      // Tick-to-time conversions can round an exact onset slightly into the past.
      const boundary = position - 0.000001;
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (items[middle][field] < boundary) low = middle + 1;
        else high = middle;
      }
      return low;
    }

    // Earlier held notes stay silent on a fresh start, except a slurred phrase:
    // its later written notes must still sound when seeking inside it.
    // Speed/mix changes carry all held notes without changing the transport.
    resetScheduler(minimumLead = SCHEDULER_LEAD_SECONDS, { carryHeldNotes = false } = {}) {
      const position = this.basePosition;
      const notes = this.playbackNotes || this.notes;
      this.nextNoteIndex = this.findNext(notes, position, "start");
      this.nextClickIndex = this.findNext(this.clicks, position, "time");
      notes.slice(0, this.nextNoteIndex).forEach((note) => {
        if ((carryHeldNotes || note.segments) && note.end > position) this.scheduleNote(note, position, minimumLead);
      });
      this.scheduleAhead(minimumLead);
    }

    scheduleAhead(minimumLead = SCHEDULER_LEAD_SECONDS) {
      if (!this.playing || !this.context) return;
      const position = this.currentSeconds();
      const limit = this.hasLoop() ? Math.min(this.loopEndSeconds, position + SCHEDULER_HORIZON_SECONDS * this.rate) : position + SCHEDULER_HORIZON_SECONDS * this.rate;
      const notes = this.playbackNotes || this.notes;
      while (this.nextNoteIndex < notes.length && notes[this.nextNoteIndex].start <= limit) {
        this.scheduleNote(notes[this.nextNoteIndex], position, minimumLead);
        this.nextNoteIndex += 1;
      }
      if (this.metronomeVolume > 0) {
        while (this.nextClickIndex < this.clicks.length && this.clicks[this.nextClickIndex].time <= limit) {
          this.scheduleClick(this.clicks[this.nextClickIndex], position, minimumLead);
          this.nextClickIndex += 1;
        }
      }
    }

    scheduleNote(note, position, minimumLead) {
      if (!this.context || note.end <= position || (this.hasLoop() && note.start >= this.loopEndSeconds)) return;
      const noteStart = Math.max(note.start, position);
      const noteEnd = this.hasLoop() ? Math.min(note.end, this.loopEndSeconds) : note.end;
      const startDelay = Math.max(minimumLead, (noteStart - position) / this.rate);
      const endDelay = (noteEnd - position) / this.rate;
      if (endDelay <= startDelay + 0.001) return;
      const start = this.context.currentTime + startDelay;
      const end = this.context.currentTime + endDelay;
      const audibleFrom = position + startDelay * this.rate;
      const segments = note.segments?.filter(segment => segment.end > audibleFrom && segment.start < noteEnd)
        .map(segment => ({ ...segment, start: segment.start / this.rate, end: Math.min(segment.end, noteEnd) / this.rate }));
      if (segments && !segments.length) return;
      note = { ...note, ...(segments ? segments[0] : {}), start: noteStart / this.rate, end: noteEnd / this.rate, segments };
      const frequency = n => 440 * 2 ** ((n.key - 69) / 12);

      const oscillator = this.context.createOscillator();
      oscillator.setPeriodicWave(this.wave);
      this.pitchContour(oscillator.frequency, note, start, end, frequency);
      const vibrato = this.context.createOscillator();
      const vibratoDepth = this.context.createGain();
      vibrato.frequency.value = 5.05 + note.track * 0.08;
      vibratoDepth.gain.value = 3.8;
      vibrato.connect(vibratoDepth).connect(oscillator.detune);

      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      this.pitchContour(filter.frequency, note, start, end, n => clamp(frequency(n) * 5.2, 900, 5200));
      filter.Q.value = 0.48;
      const envelope = this.context.createGain();
      const levelFor = n => 0.112 * 10 ** (clamp((55 - n.key) * 0.72, 0, 9) / 20)
        * clamp((n.velocity || 84) / 84, 0.45, 1.28);
      const level = levelFor(note);
      const firstEnd = segments?.length > 1 ? end - (note.end - segments[0].end) : end;
      const lastDuration = segments ? segments.at(-1).end - segments.at(-1).start : end - start;
      const attackEnd = start + Math.min(0.026, (firstEnd - start) * 0.22);
      const releaseStart = Math.max(attackEnd, end - Math.min(0.058, lastDuration * 0.28));
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(level, attackEnd);
      if (segments) {
        const sustainAt = Math.min(releaseStart, attackEnd + Math.min(0.02, (firstEnd - attackEnd) * 0.25));
        this.sustainPhrase(envelope.gain, note, sustainAt, releaseStart, end, n => levelFor(n) * 0.88);
      } else envelope.gain.setValueAtTime(level * 0.88, releaseStart);
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(filter).connect(envelope).connect(this.trackStrips[note.track]?.gain || this.master);

      const voice = { oscillator, vibrato, envelope };
      this.scheduled.add(voice);
      oscillator.addEventListener("ended", () => this.scheduled.delete(voice), { once: true });
      vibrato.start(start);
      oscillator.start(start);
      vibrato.stop(end + 0.01);
      oscillator.stop(end + 0.01);
    }

    pitchContour(parameter, note, start, end, valueFor) {
      let value = valueFor(note), previousAt = start;
      parameter.setValueAtTime(value, start);
      for (const segment of (note.segments || []).slice(1)) {
        const at = end - (note.end - segment.start);
        // Get It Right's 3 ms glide arrives on the written onset, with no new attack.
        parameter.setValueAtTime(value, Math.max(previousAt, at - 0.003));
        value = valueFor(segment);
        parameter.exponentialRampToValueAtTime(value, at);
        previousAt = at;
      }
    }

    sustainPhrase(gain, note, from, until, end, levelFor) {
      let level = levelFor(note);
      gain.linearRampToValueAtTime(level, from);
      for (const segment of (note.segments || []).slice(1)) {
        const at = Math.max(from, Math.min(until, end - (note.end - segment.start)));
        gain.setValueAtTime(level, Math.max(from, at - 0.012));
        level = levelFor(segment);
        gain.linearRampToValueAtTime(level, at);
      }
      gain.setValueAtTime(level, until);
    }

    holdNote(key, track, { fullChord = false } = {}) {
      this.ensureAudio();
      const resuming = this.context.state === "running" ? null : this.context.resume();
      const start = this.context.currentTime;
      const frequency = 440 * 2 ** ((key - 69) / 12);
      const oscillator = this.context.createOscillator();
      oscillator.setPeriodicWave(this.wave);
      oscillator.frequency.setValueAtTime(frequency, start);
      const vibrato = this.context.createOscillator();
      const vibratoDepth = this.context.createGain();
      vibrato.frequency.value = 5.05 + track * 0.08;
      vibratoDepth.gain.value = 3.8;
      vibrato.connect(vibratoDepth).connect(oscillator.detune);
      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = clamp(frequency * 5.2, 900, 5200);
      filter.Q.value = 0.48;
      const envelope = this.context.createGain();
      const level = 0.112 * 10 ** (clamp((55 - key) * 0.72, 0, 9) / 20)
        / (fullChord ? Math.sqrt(Math.max(1, parts.length)) : 1);
      const attackEnd = start + 0.026;
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(level, attackEnd);
      // The audition follows the part's own volume and pan, but a part turned
      // down to silence would otherwise have nothing to listen to, so that one
      // goes straight to the master instead. Full chords bypass vocal levels
      // and mutes while retaining pan, without changing the saved practice mix.
      const strip = this.trackStrips[track]?.gain;
      oscillator.connect(filter).connect(envelope)
        .connect(fullChord ? this.trackStrips[track]?.panner || this.master
          : strip && strip.gain.value > 0.0005 ? strip : this.master);

      const voice = { oscillator, vibrato, envelope };
      this.held.add(voice);
      oscillator.start(start);
      vibrato.start(start);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.held.delete(voice);
        const now = this.context.currentTime;
        if (this.context.state !== "running") {
          // A released cold-start preview must not sound after resume resolves.
          try { oscillator.stop(now); } catch {}
          try { vibrato.stop(now); } catch {}
          return;
        }
        const gain = envelope.gain;
        // Preserve the attack's current level before canceling automation.
        const current = Math.max(0.0001, Number(gain.value) || 0.0001);
        if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
        else {
          gain.cancelScheduledValues(now);
          // Canceling its future endpoint also removes an unfinished attack.
          if (now < attackEnd) gain.exponentialRampToValueAtTime(current, now);
        }
        // A completed attack may leave no automation event at `now`. Anchor
        // the release explicitly so it cannot ramp from the old attack time.
        gain.setValueAtTime(current, now);
        gain.exponentialRampToValueAtTime(0.0001, now + PITCH_AUDITION_RELEASE_SECONDS);
        const silent = now + PITCH_AUDITION_RELEASE_SECONDS + 0.03;
        try { oscillator.stop(silent); } catch {}
        try { vibrato.stop(silent); } catch {}
      };
      if (resuming) void resuming.catch(release);
      return { release };
    }

    scheduleClick(click, position, minimumLead) {
      if (!this.context || click.time < position - 0.002) return;
      const start = this.context.currentTime + Math.max(minimumLead, (click.time - position) / this.rate);
      const duration = click.downbeat ? 0.052 : 0.036;
      const oscillator = this.context.createOscillator();
      oscillator.type = "triangle";
      const pitch = click.downbeat ? 1550 : 940;
      oscillator.frequency.setValueAtTime(pitch, start);
      oscillator.frequency.exponentialRampToValueAtTime(pitch * 0.58, start + duration);
      const band = this.context.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = pitch;
      band.Q.value = 1.1;
      const envelope = this.context.createGain();
      const level = this.metronomeVolume * (click.downbeat ? 0.20 : 0.13);
      envelope.gain.setValueAtTime(Math.max(0.0001, level), start);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(band).connect(envelope).connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.005);
    }

    stopVoices(release = 0.024) {
      if (!this.context) return;
      const now = this.context.currentTime;
      const stopAt = now + release + 0.006;
      this.scheduled.forEach(({ oscillator, vibrato, envelope }) => {
        const gain = envelope.gain;
        if (typeof gain.cancelAndHoldAtTime === "function") gain.cancelAndHoldAtTime(now);
        else {
          const current = Math.max(0.0001, Number(gain.value) || 0.0001);
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(current, now);
        }
        gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.006, release));
        try { oscillator.stop(stopAt); } catch {}
        try { vibrato.stop(stopAt); } catch {}
      });
      this.scheduled.clear();
    }

    pushPosition() {
      // AlphaTab rewinds when handed the exact end. Keep its cursor on the
      // final chord while our own clock and elapsed-time display reach the end.
      const last = this.secondsAtTick(Math.max(0, this.endTick - Math.max(1, this.division / 16)));
      this.output?.updatePosition((Math.min(this.currentSeconds(), last) / this.rate) * 1000);
    }

    update() {
      if (!this.playing) return;
      const position = this.currentSeconds();
      if (!this.loopArmed) this.loopArmed = this.withinLoop(position);
      if (this.loopArmed && this.hasLoop() && position >= this.loopEndSeconds - 0.002) {
        this.basePosition = this.loopStartSeconds;
        this.anchorTime = this.context.currentTime;
        this.stopVoices(0.012);
        this.resetScheduler(0.032);
        this.pushPosition();
        return;
      }
      if (position >= this.duration - 0.004) {
        this.playing = false;
        window.clearInterval(this.timer);
        this.timer = 0;
        this.stopVoices();
        this.api?.pause();
        // Pausing AlphaTab seeks its external output to the last beat onset.
        // Restore the completed audio clock after that callback, not before it.
        this.basePosition = this.duration;
        this.pushPosition();
        return;
      }
      this.scheduleAhead();
      this.pushPosition();
    }
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function firstLyricLetterRange(text) {
    const source = String(text || "");
    const letterMatch = source.match(/[\p{L}\p{N}]/u);
    const fallbackMatch = source.match(/\S/u);
    const match = letterMatch || fallbackMatch;
    if (!match) return { index: 0, length: Math.min(1, source.length) };
    const character = Array.from(source.slice(match.index))[0] || "";
    return { index: match.index, length: character.length };
  }

  function measuredSvgTextLength(element, start, length) {
    try {
      const measured = start === undefined
        ? element.getComputedTextLength()
        : element.getSubStringLength(start, length);
      if (Number.isFinite(measured)) return measured;
    } catch {
      // Fall through to a conservative estimate for unusual SVG engines.
    }
    const text = element.textContent || "";
    const portion = start === undefined ? text : text.slice(start, start + length);
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || LYRIC_FONT_SIZE;
    return portion.length * fontSize * 0.52;
  }

  function alignPitchBarLyricsToFirstLetter(systems) {
    systems.forEach(({ svg }) => {
      svg.querySelectorAll(".bar-lyric-text").forEach((lyricText) => {
        const text = lyricText.textContent || "";
        const onsetX = Number(lyricText.dataset.onsetX);
        const { index, length } = firstLyricLetterRange(text);
        const firstLetterWidth = measuredSvgTextLength(lyricText, index, length);
        const throughFirstLetterWidth = measuredSvgTextLength(lyricText, 0, index + length);
        const left = onsetX - (throughFirstLetterWidth - firstLetterWidth / 2);
        lyricText.setAttribute("x", String(left));
      });
    });
  }

  // A syllable is drawn on its note's onset, so wherever notes come quickly the
  // words run into each other. Holding the view wider would override the
  // Stretch setting across the whole score for the sake of a few crowded bars,
  // so a syllable that cannot fit beside its neighbour drops to the next line
  // instead and only the crowded places pay for it. Lanes are filled greedily
  // in reading order, which keeps everything on the first line wherever it
  // fits and lets a run of three crowded syllables use three lines rather than
  // ping-pong between two. The system grows by whatever lines it ends up using.
  // First fit, in reading order: a syllable takes the topmost line whose last
  // word ends far enough to its left, so everything stays on one line wherever
  // it fits and a crowded run steps down as far as it must.
  function assignLyricLanes(syllables, gap) {
    const laneEnds = [];
    const lanes = syllables.map((syllable) => {
      let lane = laneEnds.findIndex((end) => end + gap <= syllable.left);
      if (lane < 0) lane = laneEnds.push(-Infinity) - 1;
      laneEnds[lane] = syllable.left + syllable.width;
      return lane;
    });
    return { lanes, lineCount: Math.max(1, laneEnds.length) };
  }

  // A word-splitting hyphen only earns its width when the syllables it joins
  // are far enough apart to read as separate words anyway. Measured from the
  // last letter, the dash needs room for itself and as much again to sit in;
  // any tighter and it is about to touch what follows, so it goes, and
  // "Fa mil iar" on one line reads better than "Fa- iar" with "mil-" stranded
  // underneath. This runs before lanes are handed out, so the packing sees the
  // width the dashes give back.
  function relaxLyricHyphens(syllables) {
    syllables.forEach((syllable, index) => {
      const next = syllables[index + 1];
      if (!next || !syllable.hyphenWidth) return;
      const reach = next.left - (syllable.left + syllable.width - syllable.hyphenWidth);
      if (reach >= syllable.hyphenWidth * PITCH_BAR_HYPHEN_LEEWAY) return;
      syllable.width -= syllable.hyphenWidth;
      syllable.trimmed = true;
    });
  }

  // Dropping the hyphen does not always buy enough room, and a word broken
  // across two lines needs its dash back to still read as one word. Lanes are
  // settled by now, so a hyphen can return whenever its own lane has room for
  // it; where it does not, the overlap would be worse than the missing dash.
  // Keep the same readable gap when restoring a dash on an occupied lane.
  function restoreSplitWordHyphens(syllables, lanes, gap = 0) {
    const nextOnLane = new Map();
    const previousOnLane = new Map();
    syllables.forEach((syllable, index) => {
      const earlier = previousOnLane.get(lanes[index]);
      if (earlier !== undefined) nextOnLane.set(earlier, syllable);
      previousOnLane.set(lanes[index], index);
    });
    syllables.forEach((syllable, index) => {
      if (!syllable.trimmed || lanes[index + 1] === lanes[index]) return;
      const follower = nextOnLane.get(index);
      const limit = follower ? follower.left - gap : Infinity;
      if (syllable.left + syllable.width + syllable.hyphenWidth > limit) return;
      syllable.width += syllable.hyphenWidth;
      syllable.trimmed = false;
    });
  }

  function packPitchBarLyrics(systems) {
    systems.forEach(({ svg, lyricTop, lyricLineHeight, lyricVerses }) => {
      if (!lyricVerses?.length || !Number.isFinite(lyricTop)) return;
      const byVerse = new Map();
      svg.querySelectorAll(".bar-lyric-text").forEach((text) => {
        const verse = Number(text.dataset.verse) || 0;
        const written = text.dataset.syllable ?? text.textContent ?? "";
        const hyphenated = written.length > 1 && written.endsWith("-");
        text.dataset.syllable = written;
        text.textContent = written;
        let left = Number(text.getAttribute("x")) || 0;
        let width = measuredSvgTextLength(text);
        try {
          // Italic ink can extend past its advance, especially before a capital A.
          const ink = text.getBBox();
          if (Number.isFinite(ink.x) && Number.isFinite(ink.width) && ink.width > 0) {
            const right = Math.max(left + width, ink.x + ink.width);
            left = Math.min(left, ink.x);
            width = right - left;
          }
        } catch { /* Detached SVGs retain the conservative advance estimate. */ }
        if (!byVerse.has(verse)) byVerse.set(verse, []);
        byVerse.get(verse).push({
          text,
          written,
          left,
          width,
          hyphenWidth: hyphenated ? measuredSvgTextLength(text, written.length - 1, 1) : 0,
        });
      });

      let usedLines = 0;
      lyricVerses.forEach((verse) => {
        const syllables = (byVerse.get(verse) || []).sort((left, right) => left.left - right.left);
        const gap = lyricLineHeight * 0.15;
        relaxLyricHyphens(syllables);
        const { lanes, lineCount } = assignLyricLanes(syllables, gap);
        restoreSplitWordHyphens(syllables, lanes, gap);
        syllables.forEach((syllable, index) => {
          if (syllable.trimmed) syllable.text.textContent = syllable.written.slice(0, -1);
          syllable.text.setAttribute("y", String(lyricTop + (usedLines + lanes[index]) * lyricLineHeight));
        });
        usedLines += lineCount;
      });

      const box = (svg.getAttribute("viewBox") || "").split(" ").map(Number);
      if (box.length !== 4 || !box.every(Number.isFinite)) return;
      svg.setAttribute("viewBox", `${box[0]} ${box[1]} ${box[2]} ${lyricTop + usedLines * lyricLineHeight + 3}`);
    });
  }

  function pitchLabel(midi) {
    const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function pitchesOfClassInRange(minPitch, maxPitch, pitchClass) {
    const first = Math.ceil((minPitch - pitchClass) / 12) * 12 + pitchClass;
    const pitches = [];
    for (let pitch = first; pitch <= maxPitch; pitch += 12) pitches.push(pitch);
    return pitches;
  }

  function pitchGuideRange(baseMinPitch, baseMaxPitch) {
    const priorities = [
      { kind: "tonic", pitchClass: scoreKeyPitchClasses.tonic },
      { kind: "dominant", pitchClass: scoreKeyPitchClasses.dominant },
      { kind: "third", pitchClass: scoreKeyPitchClasses.third },
    ];
    const middle = (baseMinPitch + baseMaxPitch) / 2;
    for (const priority of priorities) {
      const available = pitchesOfClassInRange(baseMinPitch, baseMaxPitch, priority.pitchClass);
      if (!available.length) continue;
      const referencePitch = available.sort((left, right) =>
        Math.abs(left - middle) - Math.abs(right - middle) || left - right)[0];
      return { minPitch: baseMinPitch, maxPitch: baseMaxPitch, referencePitch, referenceKind: priority.kind };
    }

    // A very narrow range can miss all three harmonic anchors. Expand only
    // as far as needed to include the nearest tonic, fifth, or third; class
    // priority breaks equal-distance ties without wasting vertical space.
    const candidates = priorities.flatMap((priority, priorityIndex) =>
      pitchesOfClassInRange(baseMinPitch - 12, baseMaxPitch + 12, priority.pitchClass).map((pitch) => ({
        ...priority,
        pitch,
        priorityIndex,
        rangeDistance: pitch < baseMinPitch ? baseMinPitch - pitch : pitch > baseMaxPitch ? pitch - baseMaxPitch : 0,
        centerDistance: Math.abs(pitch - middle),
      })));
    candidates.sort((left, right) => left.rangeDistance - right.rangeDistance
      || left.priorityIndex - right.priorityIndex
      || left.centerDistance - right.centerDistance
      || left.pitch - right.pitch);
    const reference = candidates[0];
    return {
      minPitch: Math.min(baseMinPitch, reference.pitch),
      maxPitch: Math.max(baseMaxPitch, reference.pitch),
      referencePitch: reference.pitch,
      referenceKind: reference.kind,
    };
  }

  // A key signature names two keys, a major and its relative minor, and
  // MuseScore often exports the signature without saying which. Autumn is in
  // A minor but exports as bare "no sharps or flats", so the guides would
  // otherwise centre on C. The music decides: whichever of the two tonics the
  // piece actually dwells on, measured by how long its pitch class sounds.
  // Major keeps the benefit of the doubt unless the minor is clearly ahead.
  function soundsMinor(majorTonic) {
    const weights = new Map();
    for (const [, startTick, endTick, key] of sequence?.notes || []) {
      const pitchClass = ((key % 12) + 12) % 12;
      weights.set(pitchClass, (weights.get(pitchClass) || 0) + Math.max(0, endTick - startTick));
    }
    const major = weights.get(majorTonic) || 0;
    const relativeMinor = weights.get((majorTonic + 9) % 12) || 0;
    return relativeMinor > major * 1.2;
  }

  function configurePitchGuides(xml) {
    try {
      const documentXml = new DOMParser().parseFromString(xml, "application/xml");
      const fifths = Number([...documentXml.getElementsByTagName("*")]
        .find((element) => element.localName === "fifths")?.textContent || 0);
      // An absent mode is not a declaration of major; it is the question the
      // music has to answer below.
      const mode = String([...documentXml.getElementsByTagName("*")]
        .find((element) => element.localName === "mode")?.textContent || "").toLowerCase();
      const majorTonic = ((7 * fifths) % 12 + 12) % 12;
      const declared = mode.includes("minor") ? "minor" : mode.includes("major") ? "major" : null;
      const minor = declared ? declared === "minor" : soundsMinor(majorTonic);
      const tonic = minor ? (majorTonic + 9) % 12 : majorTonic;
      scoreKeyPitchClasses = {
        tonic,
        dominant: (tonic + 7) % 12,
        third: (tonic + (minor ? 3 : 4)) % 12,
      };
    } catch {
      scoreKeyPitchClasses = { tonic: 0, dominant: 7, third: 4 };
    }
  }

  function shortestPitchBarNoteTicks(xml, playback) {
    const documentXml = new DOMParser().parseFromString(xml, "application/xml");
    let shortest = Infinity;
    // Use written durations, not MIDI gate lengths or time borrowed by grace
    // notes. Scan every part once so visibility and practice-part changes do
    // not change the horizontal scale.
    for (const part of documentXml.querySelectorAll("score-partwise > part")) {
      let divisions = 0;
      for (const measure of part.children) {
        for (const element of measure.children) {
          if (element.localName === "attributes") {
            const next = Number(element.querySelector("divisions")?.textContent);
            if (Number.isFinite(next) && next > 0) divisions = next;
          }
          if (element.localName !== "note" || !divisions
            || element.querySelector("rest, grace")) continue;
          const duration = Number(element.querySelector("duration")?.textContent);
          const ticks = duration / divisions * playback.division;
          if (Number.isFinite(ticks) && ticks > 0) shortest = Math.min(shortest, ticks);
        }
      }
    }
    if (Number.isFinite(shortest)) return shortest;
    for (const [, start, end] of playback.notes || []) {
      const duration = end - start;
      if (Number.isFinite(duration) && duration > 0) shortest = Math.min(shortest, duration);
    }
    return Number.isFinite(shortest) ? shortest : playback.division || 960;
  }

  function pitchBarRows(measures, pixelsPerTick, availableWidth, continuous) {
    const rows = [];
    let first = 0;
    while (first < measures.length) {
      const startTick = measures[first][0];
      let last = first;
      while (last + 1 < measures.length) {
        const next = measures[last + 1];
        if (!continuous && (next[0] + next[1] - startTick) * pixelsPerTick > availableWidth) break;
        last += 1;
      }
      const endTick = measures[last][0] + measures[last][1];
      rows.push({ first, measures: measures.slice(first, last + 1), startTick, endTick,
        plotWidth: (endTick - startTick) * pixelsPerTick });
      first = last + 1;
    }
    return rows;
  }

  function visiblePitchNotes() {
    return (sequence?.notes || []).filter(([track, startTick, endTick]) =>
      visibleTracks.has(track) && endTick > startTick);
  }

  function buildPitchSegments(rawNotes) {
    const byPitch = new Map();
    rawNotes.forEach(([track, startTick, endTick, pitch]) => {
      const events = byPitch.get(pitch) || new Map();
      const event = (tick) => {
        if (!events.has(tick)) events.set(tick, { starts: [], ends: [] });
        return events.get(tick);
      };
      event(startTick).starts.push(track);
      event(endTick).ends.push(track);
      byPitch.set(pitch, events);
    });
    const segments = [];
    byPitch.forEach((events, pitch) => {
      const active = new Map();
      const ticks = [...events.keys()].sort((left, right) => left - right);
      for (let index = 0; index < ticks.length - 1; index += 1) {
        const tick = ticks[index];
        events.get(tick).ends.forEach((track) => {
          const count = (active.get(track) || 0) - 1;
          if (count > 0) active.set(track, count);
          else active.delete(track);
        });
        events.get(tick).starts.forEach((track) => active.set(track, (active.get(track) || 0) + 1));
        const endTick = ticks[index + 1];
        if (active.size && endTick > tick) {
          segments.push({ pitch, startTick: tick, endTick, tracks: [...active.keys()].sort((a, b) => a - b) });
        }
      }
    });
    return segments.sort((left, right) => left.startTick - right.startTick || left.pitch - right.pitch);
  }

  function buildPitchReattacks(rawNotes) {
    const endings = new Set(rawNotes.map(([track, , endTick, pitch]) => `${track}:${pitch}:${endTick}`));
    return rawNotes.flatMap(([track, startTick, , pitch]) =>
      endings.has(`${track}:${pitch}:${startTick}`) ? [{ track, tick: startTick, pitch }] : []);
  }

  function pitchBarLyrics() {
    if (!Number.isInteger(practicePartIndex) || practicePartIndex < 0 || practicePartIndex >= parts.length) return [];
    const track = practicePartIndex;
    const hidden = lyricsMode === "changes" ? sharedNotationTools.repeatedLyrics(sequence.lyrics || []) : new Set();
    return (sequence.lyrics || []).flatMap((lyric) => {
      if (lyric[0] !== track || hidden.has(lyric)) return [];
      const text = String(lyric[3] || "").trim();
      const normalized = /^doo?m?$/iu.test(text) ? "doo" : text;
      const key = Number(lyric[2]) || 0;
      return [[track, Number(lyric[1]), key, normalized]];
    });
  }

  // Every beat boundary strictly inside a span, each with the weight of the
  // beat it falls on: the downbeat, the middle of the bar where the meter has
  // one, then the rest. The grid is the bar's and never the note's, so a
  // syncopated note's first tick comes wherever the next pulse falls rather
  // than a beat after its onset: these are for feeling the pulse, not for
  // counting off a note's own length. Anything shorter than a beat has none, so only notes
  // worth counting are marked, and nothing below the beat is marked at all —
  // a long note is counted in beats and bars, not in its subdivisions.
  // Compound meters count in dotted beats, the way they are conducted, rather
  // than in their notated eighths.
  function beatTicksWithin(fromTick, toTick) {
    const ticks = [];
    for (let index = measureIndexAtTick(fromTick); index < sequence.measures.length; index += 1) {
      const [measureStart, measureDuration, beats, beatType] = sequence.measures[index];
      if (measureStart >= toTick) break;
      const unit = (sequence.division * 4) / (beatType || 4);
      const step = beatType >= 8 && beats > 3 && beats % 3 === 0 ? unit * 3 : unit;
      const middle = measureStart + measureDuration / 2;
      for (let tick = measureStart; tick < measureStart + measureDuration; tick += step) {
        if (tick <= fromTick || tick >= toTick) continue;
        ticks.push({ tick, level: tick === measureStart ? 0 : (beats % 2 === 0 && tick === middle ? 1 : 2) });
      }
    }
    return ticks;
  }

  // A part's divisi, worked out from the notes: the build folds both encodings
  // — a second voice, and a chord inside one voice — into a single track, so
  // what is left to go on is how many pitches the part sounds at once. Lines
  // are numbered from the top, the way divisi are labelled.
  function analysePartDivisi() {
    return parts.map((_, track) => {
      const notes = (sequence.notes || []).filter((note) => note[0] === track);
      const edges = [...new Set(notes.flatMap((note) => [note[1], note[2]]))].sort((a, b) => a - b);
      const spans = [];
      let maxLines = 1;
      for (let index = 0; index < edges.length - 1; index += 1) {
        const [start, end] = [edges[index], edges[index + 1]];
        const pitches = [...new Set(notes.filter((note) => note[1] <= start && note[2] >= end).map((note) => note[3]))]
          .sort((a, b) => b - a);
        if (!pitches.length) continue;
        maxLines = Math.max(maxLines, pitches.length);
        const previous = spans.at(-1);
        // One span per stack, so a held chord is not chopped at its neighbours'
        // edges.
        if (previous && previous.end === start && previous.pitches.join() === pitches.join()) previous.end = end;
        else spans.push({ start, end, pitches });
      }
      return { maxLines, spans };
    });
  }

  // Which line to sing where the part divides into fewer lines than the singer
  // chose from. The position is kept proportional, so a middle voice stays in
  // the middle instead of being pushed to the floor and leaving the middle line
  // unsung; a singer who falls exactly between two lines goes to the lower one,
  // which is the side that wants the extra body.
  function divisiLineFor(chosen, maxLines, available) {
    if (available <= 1 || maxLines <= 1) return 0;
    const position = clamp(chosen, 0, maxLines - 1) / (maxLines - 1);
    return clamp(Math.round(position * (available - 1)), 0, available - 1);
  }

  function divisiPlaybackNotes(notes, track, line, secondsAtTick) {
    const analysis = partDivisi[track];
    if (!Number.isInteger(track) || !Number.isInteger(line) || !analysis
      || analysis.maxLines < 2 || line < 0 || line >= analysis.maxLines) return notes;
    const spans = analysis.spans.map((span) => ({
      start: secondsAtTick(span.start), end: secondsAtTick(span.end),
      key: span.pitches[divisiLineFor(line, analysis.maxLines, span.pitches.length)],
    }));
    return notes.flatMap((note) => {
      if (note.track !== track) return [note];
      const source = note.segments || [note];
      const kept = [];
      // Split held notes only where the selected line changes. Keep contiguous
      // slur segments together so filtering does not replace legato with attacks.
      for (const segment of source) {
        let previous = null;
        for (const span of spans) {
          const start = Math.max(segment.start, span.start);
          const end = Math.min(segment.end, span.end);
          if (span.key !== segment.key || end - start <= 1e-7) continue;
          if (previous && Math.abs(previous.end - start) < 1e-7) previous.end = end;
          else {
            previous = { ...segment, start, end };
            kept.push(previous);
          }
        }
      }
      if (kept.length === source.length && kept.every((segment, index) =>
        Math.abs(segment.start - source[index].start) < 1e-7
        && Math.abs(segment.end - source[index].end) < 1e-7)) return [note];
      const groups = [];
      for (const segment of kept) {
        const group = groups.at(-1);
        if (group && Math.abs(group.at(-1).end - segment.start) < 1e-7) group.push(segment);
        else groups.push([segment]);
      }
      return groups.map((segments) => segments.length === 1 ? segments[0]
        : { ...segments[0], end: segments.at(-1).end, segments });
    }).sort((left, right) => left.start - right.start || left.track - right.track);
  }

  function divisiSpanAt(track, tick) {
    const spans = partDivisi[track]?.spans || [];
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (spans[middle].end <= tick) low = middle + 1;
      else high = middle;
    }
    const span = spans[low];
    return span && span.start <= tick ? span : null;
  }

  function pitchStripe(defs, systemIndex, tracks, cache) {
    if (tracks.length === 1) return parts[tracks[0]]?.color || partPaint(tracks[0]);
    const key = tracks.join("-");
    if (cache.has(key)) return cache.get(key);
    const id = `pitch-stripe-${systemIndex}-${key}`;
    const pattern = createSvgElement("pattern", { id, width: tracks.length * 6, height: 6, patternUnits: "userSpaceOnUse" });
    tracks.forEach((track, index) => {
      const stripe = createSvgElement("rect", { x: index * 6, y: 0, width: 6, height: 6 });
      stripe.style.fill = parts[track]?.color || partPaint(track);
      pattern.append(stripe);
    });
    defs.append(pattern);
    const fill = `url(#${id})`;
    cache.set(key, fill);
    return fill;
  }

  // The pitch a singer is meant to be on. With a part chosen there is a real
  // answer, so it is graded against that part alone, and against the chosen
  // line where the part divides: singing the other line, or another part
  // altogether, is exactly what a singer wants to be told about. With no part
  // chosen there is no "mine", so the nearest note on screen stands in.
  function expectedPitchAt(tick, line = null) {
    const mine = Number.isInteger(practicePartIndex);
    const pool = (sequence.notes || []).filter(([track]) => mine ? track === practicePartIndex : visibleTracks.has(track));
    let candidates = pool.filter(([, startTick, endTick]) => tick >= startTick && tick < endTick);
    // A contour recorded on one line is judged against that line, so drifting
    // onto the other one reads as the wrong note rather than as a second take.
    if (mine && candidates.length > 1 && Number.isInteger(line)) {
      const span = divisiSpanAt(practicePartIndex, tick);
      const lines = partDivisi[practicePartIndex]?.maxLines || 1;
      if (span && span.pitches.length > 1 && lines > 1) {
        const wanted = span.pitches[divisiLineFor(line, lines, span.pitches.length)];
        const onThatLine = candidates.filter((note) => note[3] === wanted);
        if (onThatLine.length) candidates = onThatLine;
      }
    }
    if (!candidates.length) {
      // Between phrases, hold the last note of whatever is being graded rather
      // than letting the trace drift to some other part's note.
      const latestEnd = pool.reduce((latest, [, , endTick]) => endTick <= tick ? Math.max(latest, endTick) : latest, -1);
      if (latestEnd >= 0) candidates = pool.filter(([, , endTick]) => endTick === latestEnd);
    }
    return candidates;
  }

  function expectedPitchErrorCents(tick, pitchCents, line = null) {
    const candidates = expectedPitchAt(tick, line);
    if (!candidates.length) return null;
    return candidates.reduce((best, note) => {
      const error = pitchCents - note[3] * 100;
      return best === null || Math.abs(error) < Math.abs(best) ? error : best;
    }, null);
  }

  function pitchTraceColor(errorCents) {
    if (!Number.isFinite(errorCents)) return "rgb(255 0 0)";
    const distance = clamp(
      (Math.abs(errorCents) - PITCH_TRACE_GREEN_TOLERANCE_CENTS) /
        (PITCH_TRACE_RED_CENTS - PITCH_TRACE_GREEN_TOLERANCE_CENTS),
      0,
      1,
    );
    const red = Math.round(distance * 255);
    return `rgb(${red} ${255 - red} 0)`;
  }

  function pitchTraceBinTicks() {
    return Math.max(1, Math.round((Number(sequence?.division) || 1) / PITCH_TRACE_BINS_PER_QUARTER));
  }

  function pitchTraceBinCount() {
    return Math.max(1, Math.ceil((Number(sequence?.endTick) || 0) / pitchTraceBinTicks()) + 1);
  }

  function pitchTraceBinAtTick(tick) {
    return clamp(Math.round((Number(tick) || 0) / pitchTraceBinTicks()), 0, pitchTraceBinCount() - 1);
  }

  function pitchTraceLane(line, { create = false } = {}) {
    const existing = pitchTraceLanes.get(line);
    if (existing || !create) return existing || null;
    const bins = pitchTraceBinCount();
    const lane = { pitches: new Uint16Array(bins), breaks: new Uint8Array(bins) };
    pitchTraceLanes.set(line, lane);
    return lane;
  }

  const pitchTraceLaneList = () => [...pitchTraceLanes.entries()].sort(([left], [right]) => left - right);

  // Which line a sung sample belongs to, decided sample by sample. Both lines
  // of a divisi are real music, so which one is being sung is the singer's to
  // change whenever they like — mid-note included — and each line keeps its own
  // contour rather than the first one claiming the passage.
  function pitchTraceLaneAt(tick, cents) {
    if (!Number.isInteger(practicePartIndex)) return 0;
    const lines = partDivisi[practicePartIndex]?.maxLines || 1;
    if (lines < 2) return 0;
    const span = divisiSpanAt(practicePartIndex, tick);
    if (!span || span.pitches.length < 2) return 0;
    let nearest = 0;
    let smallest = Infinity;
    span.pitches.forEach((pitch, index) => {
      const error = Math.abs(cents - pitch * 100);
      if (error < smallest) {
        smallest = error;
        nearest = index;
      }
    });
    // The nearest pitch is a position in this passage's stack; the lane is the
    // line that position stands for where the part divides furthest.
    return span.pitches.length === lines
      ? nearest
      : clamp(Math.round((nearest / (span.pitches.length - 1)) * (lines - 1)), 0, lines - 1);
  }

  function pitchTraceTickAtBin(bin) {
    return clamp(bin * pitchTraceBinTicks(), 0, Number(sequence?.endTick) || 0);
  }

  function resetPitchTraceGrid() {
    pitchTraceLanes.clear();
    pitchTraceCount = 0;
  }

  function previousOccupiedPitchBin(lane, bin) {
    for (let index = Math.min(bin - 1, lane.pitches.length - 1); index >= 0; index -= 1) {
      if (lane.pitches[index]) return index;
    }
    return -1;
  }

  function nextOccupiedPitchBin(lane, bin) {
    for (let index = Math.max(0, bin + 1); index < lane.pitches.length; index += 1) {
      if (lane.pitches[index]) return index;
    }
    return -1;
  }

  // Bounds are in score pixels, including clefs, octave transpositions and
  // accidentals. Keep a written staff position separate from sounding pitch.
  function buildStaffTraceSystems(lookup) {
    const rows = new Map();
    const references = new Map();
    sequence.measures.forEach(([startTick, duration], measureIndex) => {
      const master = lookup?.findMasterBarByIndex?.(measureIndex);
      const source = master?.staffSystemBounds;
      const box = source?.realBounds;
      if (!box || !(box.w > 0 && box.h > 0)) return;
      if (!rows.has(source.index)) rows.set(source.index, {
        box, startTick, endTick: startTick + duration, measures: new Map(), references,
      });
      const system = rows.get(source.index);
      system.endTick = startTick + duration;
      const measure = { startTick, endTick: startTick + duration, parts: new Map() };
      const columns = new Map();
      system.measures.set(measureIndex, measure);
      for (const bounds of master.bars || []) {
        const track = partIndexForTrack(bounds.bar?.staff?.track);
        const staff = bounds.bar?.staff;
        const staffBox = bounds.visualBounds;
        if (!visibleTracks.has(track) || staff?.isPercussion || !staffBox?.h) continue;
        const lineCount = Number(staff.standardNotationLineCount) || 5;
        if (lineCount < 2) continue;
        const step = staffBox.h / (2 * (lineCount - 1));
        for (const beat of bounds.beats || []) {
          const tick = performedScoreTick(Number(beat.beat?.absolutePlaybackStart));
          if (!Number.isFinite(tick)) continue;
          const notes = (beat.notes || []).filter((note) => note.noteHeadBounds
            && Number.isFinite(note.note?.realValue));
          const x = notes.length ? Math.min(...notes.map((note) => note.noteHeadBounds.x)) : beat.realBounds?.x;
          const previous = columns.get(tick);
          const hasHead = notes.length > 0;
          if (Number.isFinite(x) && (!previous || hasHead && !previous.hasHead
            || hasHead === previous.hasHead && x < previous.x)) {
            columns.set(tick, { tick, x, hasHead });
          }
          for (const note of notes) {
            const head = note.noteHeadBounds;
            const key = `${track}:${note.note.realValue}`;
            if (!references.has(key)) references.set(key, []);
            references.get(key).push({
              tick, staffIndex: staff.index,
              staffPosition: (head.y + head.h / 2 - staffBox.y) / step,
            });
          }
        }
        if (!measure.parts.has(track)) measure.parts.set(track, new Map());
        measure.parts.get(track).set(staff.index, { top: staffBox.y, step });
      }
      measure.anchors = [...columns.values()].sort((a, b) => a.tick - b.tick);
      if (!measure.anchors.length) measure.anchors.push({ tick: startTick, x: master.realBounds.x });
      measure.anchors.push({ tick: startTick + duration, x: master.realBounds.x + master.realBounds.w });
    });
    references.forEach((notes) => notes.sort((a, b) => a.tick - b.tick));
    return [...rows.values()];
  }

  function staffTracePoint(system, tick, cents, line) {
    if (tick < system.startTick || tick >= system.endTick) return null;
    const measure = system.measures.get(measureIndexAtTick(tick));
    const target = expectedPitchAt(tick, line).filter(([track]) => measure?.parts.has(track))
      .sort((a, b) => Math.abs(cents - a[3] * 100) - Math.abs(cents - b[3] * 100))[0];
    if (!target) return null;
    const [track, , , pitch] = target;
    const notes = system.references.get(`${track}:${pitch}`) || [];
    let low = 0, high = notes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (notes[middle].tick <= tick) low = middle + 1;
      else high = middle;
    }
    const reference = notes[low - 1];
    const staff = reference && measure.parts.get(track)?.get(reference.staffIndex);
    if (!staff) return null;
    const anchors = measure.anchors;
    let x = anchors[0].x;
    for (let index = 1; index < anchors.length; index++) {
      const left = anchors[index - 1], right = anchors[index];
      const fraction = clamp((tick - left.tick) / Math.max(1, right.tick - left.tick), 0, 1);
      x = left.x + fraction * (right.x - left.x);
      if (tick < right.tick) break;
    }
    const error = cents - pitch * 100;
    return { x, y: staff.top + (reference.staffPosition - error / STAFF_TRACE_CENTS_PER_STEP) * staff.step,
      track, error };
  }

  function renderStaffPitchTrace() {
    if (scoreView !== "standard" || notationRenderInFlight) return;
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    staffTraceSystems = buildStaffTraceSystems(lookup);
    elements.score.querySelectorAll(":scope > .score-pitch-trace").forEach((layer) => layer.remove());
    const fragment = document.createDocumentFragment();
    staffTraceSystems.forEach((system) => {
      const { x, y, w, h } = system.box;
      const svg = createSvgElement("svg", {
        class: "score-pitch-trace", viewBox: `${x} ${y} ${w} ${h}`,
        width: w, height: h, "aria-hidden": "true",
      });
      svg.style.left = `${x}px`;
      svg.style.top = `${y}px`;
      system.traceLayer = createSvgElement("g", { class: "bar-pitch-trace-layer" });
      system.traceEdges = new Map();
      system.traceEdgesByBin = new Map();
      system.pointAtPitch = (tick, cents, line) => staffTracePoint(system, tick, cents, line);
      svg.append(system.traceLayer);
      fragment.append(svg);
    });
    elements.score.append(fragment);
    renderPitchTrace(staffTraceSystems);
  }

  function occupiedPitchBinsForSystem(lane, system) {
    const first = clamp(Math.ceil(system.startTick / pitchTraceBinTicks()), 0, lane.pitches.length - 1);
    const last = clamp(Math.floor(system.endTick / pitchTraceBinTicks()), first, lane.pitches.length - 1);
    const bins = [];
    for (let bin = first; bin <= last; bin += 1) {
      if (lane.pitches[bin]) bins.push(bin);
    }
    return bins;
  }

  function pitchTraceBinIsInSystem(system, bin) {
    const tick = pitchTraceTickAtBin(bin);
    return tick >= system.startTick && tick <= system.endTick;
  }

  function removePitchTraceEdge(system, key) {
    const edge = system.traceEdges?.get(key);
    if (!edge) return;
    const fromBin = Number(edge.dataset.fromBin);
    const toBin = Number(edge.dataset.toBin);
    edge.remove();
    system.traceEdges.delete(key);
    const line = edge.dataset.line;
    [fromBin, toBin].forEach((bin) => {
      const keys = system.traceEdgesByBin.get(`${line}:${bin}`);
      keys?.delete(key);
      if (!keys?.size) system.traceEdgesByBin.delete(`${line}:${bin}`);
    });
  }

  function removePitchTraceEdgesAtBin(system, line, bin) {
    [...(system.traceEdgesByBin?.get(`${line}:${bin}`) || [])].forEach((key) => removePitchTraceEdge(system, key));
  }

  function appendPitchTraceEdge(system, line, lane, fromBin, toBin) {
    const key = `${line}:${fromBin}:${toBin}`;
    if (system.traceEdges?.has(key)) return;
    const fromCents = lane.pitches[fromBin];
    const toCents = lane.pitches[toBin];
    if (!fromCents || !toCents || lane.breaks[toBin]) return;
    const fromTick = pitchTraceTickAtBin(fromBin);
    const toTick = pitchTraceTickAtBin(toBin);
    const gap = Math.abs(engine.secondsAtTick(toTick) - engine.secondsAtTick(fromTick));
    if (gap > PITCH_TRACE_MAX_DRAW_GAP_SECONDS || Math.abs(toCents - fromCents) > PITCH_TRACE_RENDER_JUMP_CENTS) return;
    let from, to;
    if (system.pointAtPitch) {
      from = system.pointAtPitch(fromTick, fromCents, line);
      to = system.pointAtPitch(toTick, toCents, line);
      if (!from || !to || from.track !== to.track) return;
    } else {
      const startPitch = fromCents / 100;
      const endPitch = toCents / 100;
      if (Math.max(startPitch, endPitch) < system.minPitch - 1 || Math.min(startPitch, endPitch) > system.maxPitch + 1) return;
      from = { x: system.xAtTick(fromTick), y: system.yAtPitch(startPitch) };
      to = { x: system.xAtTick(toTick), y: system.yAtPitch(endPitch),
        error: expectedPitchErrorCents(toTick, toCents, line) };
    }
    const { x: x1, y: y1 } = from;
    const { x: x2, y: y2 } = to;
    const traceColor = pitchTraceColor(to.error);
    const edge = createSvgElement("g", {
      class: "bar-pitch-trace-edge",
      "data-line": line,
      "data-from-bin": fromBin,
      "data-to-bin": toBin,
      "aria-hidden": "true",
    });
    edge.append(
      createSvgElement("line", { class: "bar-pitch-trace-halo", x1, y1, x2, y2 }),
      createSvgElement("line", { class: "bar-pitch-trace", x1, y1, x2, y2, stroke: traceColor }),
    );
    system.traceLayer.append(edge);
    system.traceEdges.set(key, edge);
    [fromBin, toBin].forEach((bin) => {
      const indexKey = `${line}:${bin}`;
      if (!system.traceEdgesByBin.has(indexKey)) system.traceEdgesByBin.set(indexKey, new Set());
      system.traceEdgesByBin.get(indexKey).add(key);
    });
  }

  function renderPitchTrace(systems = [...barSystems, ...staffTraceSystems]) {
    systems.forEach((system) => {
      system.traceLayer.replaceChildren();
      system.traceEdges.clear();
      system.traceEdgesByBin.clear();
      pitchTraceLaneList().forEach(([line, lane]) => {
        const bins = occupiedPitchBinsForSystem(lane, system);
        for (let index = 1; index < bins.length; index += 1) {
          appendPitchTraceEdge(system, line, lane, bins[index - 1], bins[index]);
        }
      });
    });
    updatePitchCaptureAppearance();
  }

  // `changed` maps a line to the bins that moved in it, so a take of one line
  // never redraws — or erases — another line's contour.
  function updatePitchTraceIncrementally(changed) {
    const systems = scoreView === "bars" ? barSystems : staffTraceSystems;
    if (!changed?.size || !systems.length) {
      updatePitchCaptureAppearance();
      return;
    }
    changed.forEach((bins, line) => {
      const lane = pitchTraceLane(line);
      if (!lane) return;
      const affected = new Set(bins);
      bins.forEach((bin) => {
        const previous = previousOccupiedPitchBin(lane, bin);
        const next = nextOccupiedPitchBin(lane, bin);
        if (previous >= 0) affected.add(previous);
        if (next >= 0) affected.add(next);
      });
      systems.forEach((system) => {
        affected.forEach((bin) => removePitchTraceEdgesAtBin(system, line, bin));
        affected.forEach((bin) => {
          if (!lane.pitches[bin] || !pitchTraceBinIsInSystem(system, bin)) return;
          const previous = previousOccupiedPitchBin(lane, bin);
          const next = nextOccupiedPitchBin(lane, bin);
          if (previous >= 0 && pitchTraceBinIsInSystem(system, previous)) appendPitchTraceEdge(system, line, lane, previous, bin);
          if (next >= 0 && pitchTraceBinIsInSystem(system, next)) appendPitchTraceEdge(system, line, lane, bin, next);
        });
      });
    });
    updatePitchCaptureAppearance();
  }

  // ||: and :|| drawn the way they are engraved — thick bar, thin bar, two
  // dots facing the music they enclose — sized to sit beside a measure number
  // without crowding it. `facing` is +1 for an opening sign drawn rightward
  // from the barline, -1 for a closing one drawn leftward.
  function pitchBarRepeatSign(barlineX, baseline, height, facing) {
    const thick = Math.max(1.1, height * 0.2);
    const thin = Math.max(0.55, height * 0.085);
    const gap = Math.max(0.9, height * 0.14);
    const dot = Math.max(0.6, height * 0.095);
    const top = baseline - height;
    const from = (offset, width) => facing > 0 ? barlineX + offset : barlineX - offset - width;
    const group = createSvgElement("g", { class: "bar-repeat-sign" });
    group.append(
      createSvgElement("rect", { x: from(0, thick), y: top, width: thick, height }),
      createSvgElement("rect", { x: from(thick + gap, thin), y: top, width: thin, height }),
    );
    const dotX = from(thick + gap + thin + gap, dot * 2) + dot;
    group.append(
      createSvgElement("circle", { cx: dotX, cy: top + height * 0.3, r: dot }),
      createSvgElement("circle", { cx: dotX, cy: top + height * 0.7, r: dot }),
    );
    return { group, width: thick + gap + thin + gap + dot * 2 };
  }

  function renderBarScore() {
    if (!sequence?.measures?.length || !elements.barScore.clientWidth) return;
    cancelPitchAuditions();
    cancelScoreScrub();
    const rawNotes = visiblePitchNotes();
    const segments = buildPitchSegments(rawNotes);
    const reattacks = buildPitchReattacks(rawNotes);
    const lyrics = pitchBarLyrics();
    const chapters = new Set(autoChapters().map((chapter) => measureIndexAtTick(chapter.tick)));
    const continuous = flow === "continuous";
    const availableWidth = elements.barScore.clientWidth;
    const pixelsPerTick = PITCH_BAR_UNIT_WIDTH * horizontalControl.value() / 100 / pitchBarUnitTicks;
    const typographyScale = verticalControl.value() / 100;
    const pitchStep = clamp(5.5 * typographyScale, 3, 10);
    const lyricFontSize = LYRIC_FONT_SIZE * typographyScale;
    const lyricLineHeight = 17.5 * typographyScale;
    const measureFontSize = 11 * typographyScale;
    const repeatSignHeight = measureFontSize * 0.78;
    const leftPad = 34;
    // Leave a gutter for the next-line pitch cues beyond the closing barline.
    const rightPad = pitchStep * 2 + 2;
    const rows = pitchBarRows(sequence.measures, pixelsPerTick, availableWidth - leftPad - rightPad, continuous);
    elements.barScore.classList.toggle("has-horizontal-overflow",
      rows.some((row) => row.plotWidth + leftPad + rightPad > availableWidth));
    elements.barScore.style.setProperty("--bar-measure-font-size", `${measureFontSize}px`);
    elements.barScore.style.setProperty("--bar-lyric-font-size", `${lyricFontSize}px`);
    const fragment = document.createDocumentFragment();
    const nextSystems = [];

    for (const [systemIndex, row] of rows.entries()) {
      const { first, measures: rowMeasures, startTick, endTick, plotWidth } = row;
      const rowSegments = segments.filter((segment) => segment.endTick > startTick && segment.startTick < endTick);
      const rowPitches = rowSegments.map((segment) => segment.pitch);
      // Where each part goes at the line break. A leap is only readable if you
      // can see both ends of it, so the pitch it lands on is marked at the end
      // of the line it leaves, and counts towards this line's pitch range so it
      // is never off the top or bottom. Only parts singing on this line are
      // marked: without a note to leap from there is no leap to show, and an
      // entry from another register would stretch the line for nothing.
      const nextEndTick = rows[systemIndex + 1]?.endTick ?? endTick;
      const continuations = [...new Set(rowSegments.flatMap((segment) => segment.tracks))].flatMap((track) => {
        const next = segments.find((segment) => segment.tracks.includes(track)
          && segment.endTick > endTick && segment.startTick < nextEndTick);
        return next ? [{ track, pitch: next.pitch }] : [];
      });
      const reachPitches = continuations.map((continuation) => continuation.pitch);
      const baseMinPitch = (rowPitches.length ? Math.min(...rowPitches, ...reachPitches) : 60) - 1;
      const baseMaxPitch = (rowPitches.length ? Math.max(...rowPitches, ...reachPitches) : 60) + 1;
      const { minPitch, maxPitch, referencePitch } = pitchGuideRange(baseMinPitch, baseMaxPitch);
      const topPad = 18;
      const plotHeight = (maxPitch - minPitch + 2) * pitchStep;
      const rowLyrics = lyrics.filter((lyric) => lyric[1] >= startTick && lyric[1] < endTick);
      const lyricVerses = [...new Set(rowLyrics.map((lyric) => lyric[2]))].sort((a, b) => a - b);
      const lyricLane = new Map(lyricVerses.map((verse, index) => [verse, index]));
      const lyricTop = topPad + plotHeight + lyricFontSize + 2;
      const viewHeight = lyricTop + (lyricVerses.length ? lyricVerses.length * lyricLineHeight + 3 : 2);
      const viewWidth = leftPad + plotWidth + rightPad;
      const xAtTick = (tick) => leftPad + clamp((tick - startTick) / Math.max(1, endTick - startTick), 0, 1) * plotWidth;
      const yAtPitch = (pitch) => topPad + (maxPitch - pitch + 1) * pitchStep;

      const shell = document.createElement("div");
      shell.className = "bar-system";
      shell.dataset.startTick = String(startTick);
      shell.dataset.endTick = String(endTick);
      shell.style.width = `${viewWidth}px`;
      const svg = createSvgElement("svg", {
        viewBox: `0 0 ${viewWidth} ${viewHeight}`,
        role: "img",
        "aria-label": `Measures ${first + 1} through ${first + rowMeasures.length}, pitch range ${pitchLabel(minPitch)} through ${pitchLabel(maxPitch)}`,
        preserveAspectRatio: "xMinYMin meet",
      });
      const defs = createSvgElement("defs");
      const clipId = `pitch-trace-clip-${systemIndex}`;
      const clip = createSvgElement("clipPath", { id: clipId });
      clip.append(createSvgElement("rect", { x: leftPad, y: topPad, width: plotWidth, height: plotHeight }));
      defs.append(clip);
      svg.append(defs, createSvgElement("rect", { class: "bar-system-background", x: leftPad, y: topPad, width: plotWidth, height: plotHeight }));

      // The closing sign is what makes a loop; an opening one is drawn only
      // when the repeat starts somewhere other than the top, exactly as it is
      // printed.
      const hasLoop = Number.isInteger(loopEndMeasure);
      const hasOpening = hasLoop && Number.isInteger(loopStartMeasure);

      rowMeasures.forEach((measure, offset) => {
        const x = xAtTick(measure[0]);
        const number = first + offset + 1;
        svg.append(createSvgElement("line", {
          class: `bar-measure-line${offset === 0 ? " is-system-edge" : ""}`,
          x1: x, x2: x, y1: topPad, y2: topPad + plotHeight,
        }));
        // Both signs stand on the barlines they belong to, the way they are
        // engraved: the opening one just before its measure's number, the
        // closing one at the end of the last measure the loop covers.
        let numberX = x + 3;
        if (hasOpening && first + offset === loopStartMeasure) {
          const sign = pitchBarRepeatSign(x + 1, 11, repeatSignHeight, 1);
          svg.append(sign.group);
          numberX = x + sign.width + 4;
        }
        const label = createSvgElement("text", {
          class: `bar-measure-number${chapters.has(first + offset) ? " is-chapter" : ""}`,
          x: numberX, y: 11,
        });
        label.textContent = String(number);
        svg.append(label);
        if (hasLoop && first + offset === loopEndMeasure) {
          svg.append(pitchBarRepeatSign(xAtTick(measure[0] + measure[1]) - 1, 11, repeatSignHeight, -1).group);
        }
      });
      svg.append(createSvgElement("line", {
        class: "bar-measure-line is-system-edge", x1: leftPad + plotWidth, x2: leftPad + plotWidth,
        y1: topPad, y2: topPad + plotHeight,
      }));

      // A triangle, not a bar: nothing in the score is that shape, so it cannot
      // be mistaken for a note to sing, and it points on to where the note
      // really is. Its vertical edge stands on the closing barline at a bar
      // note's height, it is as wide as it is tall, and its apex marks the
      // pitch.
      continuations.forEach(({ track, pitch }) => {
        const edge = leftPad + plotWidth;
        const middle = topPad + (maxPitch - pitch + 1) * pitchStep;
        const cue = createSvgElement("polygon", {
          class: "bar-next-pitch",
          points: `${edge},${middle - pitchStep} ${edge + pitchStep * 2},${middle} ${edge},${middle + pitchStep}`,
        });
        cue.style.fill = parts[track]?.color || partPaint(track);
        svg.append(cue);
      });

      const guidePitches = [];
      for (let pitch = minPitch; pitch <= maxPitch; pitch += 1) {
        const pitchClass = ((pitch % 12) + 12) % 12;
        if (Object.values(scoreKeyPitchClasses).includes(pitchClass)) guidePitches.push(pitch);
      }
      [...new Set([...guidePitches, referencePitch])].forEach((pitch) => {
        const pitchClass = ((pitch % 12) + 12) % 12;
        const kind = pitchClass === scoreKeyPitchClasses.tonic ? "tonic"
          : pitchClass === scoreKeyPitchClasses.dominant ? "dominant"
            : pitchClass === scoreKeyPitchClasses.third ? "third" : "reference";
        const y = yAtPitch(pitch);
        svg.append(createSvgElement("line", { class: `pitch-guide is-${kind}`, x1: leftPad, x2: leftPad + plotWidth, y1: y, y2: y }));
        if (pitch === referencePitch) {
          const label = createSvgElement("text", { class: "pitch-guide-label", x: leftPad - 4, y: y + 3, "text-anchor": "end" });
          label.textContent = pitchLabel(pitch);
          svg.append(label);
        }
      });

      const patternCache = new Map();
      rowSegments.forEach((segment) => {
        const x = xAtTick(Math.max(startTick, segment.startTick));
        const endX = xAtTick(Math.min(endTick, segment.endTick));
        const note = createSvgElement("rect", {
          class: "bar-note", x, y: topPad + (maxPitch - segment.pitch) * pitchStep,
          width: Math.max(0.8, endX - x), height: pitchStep * 2,
        });
        note.style.fill = pitchStripe(defs, systemIndex, segment.tracks, patternCache);
        svg.append(note);
      });

      // Counted from the notes rather than the drawn bars: a bar splits wherever
      // another part joins or leaves the same pitch, and a note is a note either
      // way. Two parts in unison therefore ask for the same tick twice.
      const drawnBeatTicks = new Set();
      rawNotes.forEach(([, noteStart, noteEnd, pitch]) => {
        if (noteEnd <= startTick || noteStart >= endTick) return;
        const top = topPad + (maxPitch - pitch) * pitchStep;
        beatTicksWithin(noteStart, noteEnd).forEach(({ tick, level }) => {
          if (tick <= startTick || tick >= endTick) return;
          const key = `${pitch}:${tick}`;
          if (drawnBeatTicks.has(key)) return;
          drawnBeatTicks.add(key);
          svg.append(createSvgElement("line", {
            class: "bar-beat-tick", x1: xAtTick(tick), x2: xAtTick(tick),
            y1: top + pitchStep * 2 * (1 - BEAT_TICK_HEIGHTS[level]), y2: top + pitchStep * 2,
          }));
        });
      });

      rowLyrics.forEach(([track, tick, verse, text]) => {
        const onsetX = xAtTick(tick);
        const lyric = createSvgElement("text", {
          class: "bar-lyric-text", x: onsetX, y: lyricTop + (lyricLane.get(verse) || 0) * lyricLineHeight,
          "data-track": track, "data-tick": tick, "data-verse": verse, "data-onset-x": onsetX,
          "text-anchor": "start",
        });
        lyric.textContent = text;
        svg.append(lyric);
      });

      const traceLayer = createSvgElement("g", { class: "bar-pitch-trace-layer", "clip-path": `url(#${clipId})`, "aria-hidden": "true" });
      svg.append(traceLayer);

      reattacks.filter((marker) => marker.tick >= startTick && marker.tick < endTick).forEach((marker) => {
        const y = topPad + (maxPitch - marker.pitch) * pitchStep;
        svg.append(createSvgElement("line", {
          class: "bar-reattack-line", x1: xAtTick(marker.tick), x2: xAtTick(marker.tick), y1: y, y2: y + pitchStep * 2,
        }));
      });

      const cursor = createSvgElement("line", {
        class: "bar-playhead", x1: leftPad, x2: leftPad, y1: topPad, y2: topPad + plotHeight, visibility: "hidden",
      });
      svg.append(cursor);
      const system = {
        shell, svg, cursor, traceLayer, startTick, endTick, leftPad, plotWidth, minPitch, maxPitch, xAtTick, yAtPitch,
        lyricTop, lyricLineHeight, lyricVerses,
        traceEdges: new Map(), traceEdgesByBin: new Map(),
      };
      const pointAt = (pointerEvent) => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return null;
        const point = svg.createSVGPoint();
        point.x = pointerEvent.clientX;
        point.y = pointerEvent.clientY;
        const local = point.matrixTransform(matrix.inverse());
        const ratio = clamp((local.x - leftPad) / plotWidth, 0, 0.999999);
        return {
          tick: clamp(Math.round(startTick + ratio * (endTick - startTick)), startTick, Math.max(startTick, endTick - 1)),
          pitch: maxPitch + 1 - (local.y - topPad) / pitchStep,
          above: local.y >= 0 && local.y < topPad && local.x >= leftPad && local.x <= leftPad + plotWidth,
          inside: local.x >= leftPad && local.x <= leftPad + plotWidth && local.y >= 0 && local.y <= viewHeight,
        };
      };
      const sounding = (at) => (sequence.notes || []).filter(([track, noteStart, noteEnd]) =>
        visibleTracks.has(track) && at.tick >= noteStart && at.tick < noteEnd);
      const scrubTarget = (pointerEvent) => {
        const at = pointAt(pointerEvent);
        if (!at) return null;
        const active = sounding(at)
          .sort((left, right) => Math.abs(left[3] - at.pitch) - Math.abs(right[3] - at.pitch));
        return {
          tick: at.tick,
          partIndex: active[0]?.[0] ?? currentScorePartIndex(),
          snapStartTick: startTick,
          snapEndTick: endTick,
        };
      };
      const barUnder = (pointerEvent, nearest = false) => {
        const at = pointAt(pointerEvent);
        return at?.inside ? barNoteAt(at.tick, at.pitch, nearest) : null;
      };
      svg.addEventListener("pointerdown", (event) => {
        const at = pointAt(event), note = barUnder(event);
        const fullChord = !note && at?.above;
        const preview = note || (fullChord ? { notes: chordNotesAtTick(at.tick), fullChord: true } : null);
        const follow = (pointer) => {
          const next = pointAt(pointer);
          return fullChord ? next?.inside ? { notes: chordNotesAtTick(next.tick) } : null : barUnder(pointer, true);
        };
        if (!beginPitchAudition(event, preview, follow, scrubTarget)) beginScoreScrub(event, scrubTarget);
      });

      shell.append(svg);
      fragment.append(shell);
      nextSystems.push(system);
    }

    elements.barScore.replaceChildren(fragment);
    barSystems = nextSystems;
    activeBarSystemIndex = -1;
    alignPitchBarLyricsToFirstLetter(nextSystems);
    packPitchBarLyrics(nextSystems);
    renderPitchTrace(nextSystems);
    updateBarPlayhead(engine ? engine.tickAtSeconds(engine.currentSeconds()) : 0);
  }

  function scheduleBarRender() {
    cancelAnimationFrame(barRenderFrame);
    barRenderFrame = requestAnimationFrame(renderBarScore);
  }

  function updateBarPlayhead(tick) {
    if (!barSystems.length) return;
    let nextActive = -1;
    barSystems.forEach((system, index) => {
      const active = tick >= system.startTick && (tick < system.endTick || (index === barSystems.length - 1 && tick <= system.endTick));
      system.cursor.setAttribute("visibility", active ? "visible" : "hidden");
      if (!active) return;
      nextActive = index;
      const x = system.xAtTick(tick);
      system.cursor.setAttribute("x1", String(x));
      system.cursor.setAttribute("x2", String(x));
    });
    activeBarSystemIndex = nextActive;
  }

  function pitchCaptureSupported() {
    return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.Pitchy?.PitchDetector);
  }

  function pitchCaptureEnabled() {
    return pitchCaptureState === "armed" || pitchCaptureState === "recording";
  }

  function updatePitchCaptureAppearance() {
    const requesting = pitchCaptureState === "requesting";
    const armed = pitchCaptureEnabled();
    const recording = pitchCaptureState === "recording";
    elements.pitchCapture.disabled = !ready;
    elements.pitchCapture.setAttribute("aria-pressed", String(armed));
    elements.pitchCapture.setAttribute("aria-busy", String(requesting));
    elements.pitchCapture.classList.toggle("is-recording", recording);
    elements.pitchCapture.setAttribute("aria-label", requesting
      ? "Cancel microphone request"
      : armed ? "Turn off microphone pitch tracking" : "Turn on microphone pitch tracking");
    elements.pitchCapture.dataset.help = !pitchCaptureSupported()
      ? "Microphone requires HTTPS or localhost."
      : requesting ? "Waiting for microphone access."
        : recording ? "Recording sung pitch."
          : armed ? "Microphone ready; press play." : "Enable sung-pitch tracing.";
    elements.pitchCapture.dataset.help += " Hold to clear the trace.";
    elements.pitchCapture.title = elements.pitchCapture.dataset.help;
    elements.settingsToggle.classList.toggle("has-active-microphone", armed);
  }

  // What a saved contour must match is the music it was sung against, not the
  // build that produced the page: rebuilding the same score should not throw
  // practice away. The playback hash covers the notes and their timing.
  function pitchTraceFingerprint() {
    return String(buildMetadata.build?.playbackSha256
      || buildMetadata.build?.fingerprint || buildMetadata.fingerprint || config.slug || config.title || "score");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function packedPitchTraceBreaks(breaks) {
    const packed = new Uint8Array(Math.ceil(breaks.length / 8));
    breaks.forEach((value, index) => {
      if (value) packed[index >> 3] |= 1 << (index & 7);
    });
    return packed;
  }

  function unpackPitchTraceBreaks(bytes, length) {
    const unpacked = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) unpacked[index] = (bytes[index >> 3] >> (index & 7)) & 1;
    return unpacked;
  }

  function readPitchTraceLane(line, source, length) {
    if (typeof source?.pitches !== "string" || typeof source?.breaks !== "string") return false;
    const pitchBytes = base64ToBytes(source.pitches);
    const breakBytes = base64ToBytes(source.breaks);
    if (pitchBytes.byteLength !== length * Uint16Array.BYTES_PER_ELEMENT
      || breakBytes.byteLength !== Math.ceil(length / 8)) return false;
    const pitches = new Uint16Array(pitchBytes.buffer.slice(
      pitchBytes.byteOffset,
      pitchBytes.byteOffset + pitchBytes.byteLength,
    ));
    const breaks = unpackPitchTraceBreaks(breakBytes, length);
    let kept = 0;
    pitches.forEach((cents, index) => {
      if (cents >= 2000 && cents <= 11000) kept += 1;
      else {
        pitches[index] = 0;
        breaks[index] = 0;
      }
    });
    if (!kept) return true;
    pitchTraceLanes.set(line, { pitches, breaks });
    pitchTraceCount += kept;
    return true;
  }

  function loadPitchTraceV3(stored) {
    if (stored.binTicks !== pitchTraceBinTicks() || stored.length !== pitchTraceBinCount()
      || !Array.isArray(stored.lanes)) return false;
    return stored.lanes.every((source) =>
      readPitchTraceLane(clamp(Math.round(Number(source?.line) || 0), 0, 15), source, stored.length));
  }

  // A contour saved before lines existed is one voice's worth of singing, so it
  // becomes the top line.
  function loadPitchTraceV2(stored) {
    if (stored.binTicks !== pitchTraceBinTicks() || stored.length !== pitchTraceBinCount()) return false;
    return readPitchTraceLane(0, stored, stored.length);
  }

  function migratePitchTraceV1(stored) {
    if (!Array.isArray(stored.samples)) return false;
    resetPitchTraceGrid();
    const lane = pitchTraceLane(0, { create: true });
    let previousSegment = null;
    stored.samples.map((sample) => Array.isArray(sample) ? sample.map(Number) : [])
      .filter(([tick, cents, clarity, segment]) => Number.isInteger(tick) && tick >= 0 && tick <= sequence.endTick
        && Number.isInteger(cents) && cents >= 2000 && cents <= 11000
        && Number.isInteger(clarity) && clarity >= 0 && clarity <= 255
        && Number.isInteger(segment) && segment >= 0)
      .sort((left, right) => left[0] - right[0] || left[3] - right[3])
      .forEach(([tick, cents, , segment]) => {
        const bin = pitchTraceBinAtTick(tick);
        if (!lane.pitches[bin]) pitchTraceCount += 1;
        lane.pitches[bin] = cents;
        if (previousSegment !== null && segment !== previousSegment) lane.breaks[bin] = 1;
        previousSegment = segment;
      });
    return true;
  }

  // A trace carries the fingerprint of the music it was sung against, so one
  // saved under any older name still belongs to this song when they match.
  // Adoption by name only rescues a trace this same build wrote; this rescues
  // the ones whose key named a build that no longer exists, which is every
  // trace recorded before the names carried the song's slug.
  function adoptedPitchTrace() {
    const named = storedValueFor(pitchTraceKey, legacyPitchTraceKeys);
    if (named !== null) return named;
    const wanted = pitchTraceFingerprint();
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith("choir-practice:") || !key.includes("pitch-trace")) continue;
        const value = localStorage.getItem(key);
        // Cheap reject before parsing what can be a megabyte of samples.
        if (!value?.includes(wanted) || JSON.parse(value)?.fingerprint !== wanted) continue;
        localStorage.setItem(pitchTraceKey, value);
        localStorage.removeItem(key);
        return value;
      }
    } catch {
      // Device-local storage is optional.
    }
    return null;
  }

  function loadPitchTrace() {
    resetPitchTraceGrid();
    try {
      const stored = JSON.parse(adoptedPitchTrace() || "null");
      if (!stored || stored.fingerprint !== pitchTraceFingerprint()) return;
      if (stored.version === PITCH_TRACE_STORAGE_VERSION && loadPitchTraceV3(stored)) return;
      if (stored.version === 2 && loadPitchTraceV2(stored)) {
        savePitchTraceNow();
        return;
      }
      if (stored.version === 1 && migratePitchTraceV1(stored)) savePitchTraceNow();
    } catch {
      // Pitch traces are optional device-local practice data.
    }
  }

  function savePitchTraceNow() {
    clearTimeout(pitchTraceSaveTimer);
    pitchTraceSaveTimer = 0;
    try {
      if (!pitchTraceCount) localStorage.removeItem(pitchTraceKey);
      else localStorage.setItem(pitchTraceKey, JSON.stringify({
        version: PITCH_TRACE_STORAGE_VERSION,
        fingerprint: pitchTraceFingerprint(),
        binTicks: pitchTraceBinTicks(),
        length: pitchTraceBinCount(),
        lanes: pitchTraceLaneList().map(([line, lane]) => ({
          line,
          pitches: bytesToBase64(new Uint8Array(
            lane.pitches.buffer,
            lane.pitches.byteOffset,
            lane.pitches.byteLength,
          )),
          breaks: bytesToBase64(packedPitchTraceBreaks(lane.breaks)),
        })),
      }));
    } catch {
      showToast("Pitch contour could not be saved on this device", "error");
    }
  }

  function schedulePitchTraceSave() {
    clearTimeout(pitchTraceSaveTimer);
    pitchTraceSaveTimer = window.setTimeout(savePitchTraceNow, PITCH_TRACE_SAVE_DELAY_MS);
  }

  function clearPitchTrace() {
    resetPitchTraceGrid();
    pitchCapturePreviousTick = null;
    try { localStorage.removeItem(pitchTraceKey); } catch {}
    renderPitchTrace();
    updatePitchCaptureAppearance();
    showToast("Pitch contour cleared");
  }

  function pitchFrequencyIsValid(frequency) {
    return Number.isFinite(frequency) && frequency >= PITCH_CAPTURE_MIN_FREQUENCY && frequency <= PITCH_CAPTURE_MAX_FREQUENCY;
  }

  function centsForFrequency(frequency) {
    return Math.round((69 + 12 * Math.log2(frequency / 440)) * 100);
  }

  function resolvePitchCandidate(input, sampleRate) {
    const primary = pitchCaptureDetector.findPitch(input, sampleRate);
    if (!pitchFrequencyIsValid(primary[0]) || !Number.isFinite(pitchLastAcceptedCents)) return primary;
    const change = Math.abs(centsForFrequency(primary[0]) - pitchLastAcceptedCents);
    if (change < 900 || change > 1300) return primary;
    let alternate;
    try {
      pitchCaptureDetector.clarityThreshold = 0.98;
      alternate = pitchCaptureDetector.findPitch(input, sampleRate);
    } finally {
      pitchCaptureDetector.clarityThreshold = 0.9;
    }
    if (!pitchFrequencyIsValid(alternate?.[0]) || Number(alternate?.[1]) < 0.6) return primary;
    return Math.abs(centsForFrequency(alternate[0]) - pitchLastAcceptedCents) <= 120 ? alternate : primary;
  }

  function resetPitchEvidence() {
    pitchLastAcceptedCents = null;
    pitchPendingEvidence = null;
    pitchCaptureMisses = 0;
  }

  function acceptPitchEvidence(pitchCents, clarity, seconds, backfill = null, breakBefore = false) {
    pitchLastAcceptedCents = pitchCents;
    pitchPendingEvidence = null;
    pitchCaptureMisses = 0;
    return { accepted: true, pitchCents, clarity, seconds, backfill, breakBefore };
  }

  function evaluatePitchEvidence(frequency, clarity, seconds, frame) {
    const threshold = PITCH_CONFIDENCE_THRESHOLD;
    const evidenceThreshold = Math.min(threshold, Math.max(0.4, threshold - 0.3));
    if (!pitchFrequencyIsValid(frequency) || !Number.isFinite(clarity) || clarity < evidenceThreshold) {
      pitchCaptureMisses += 1;
      if (pitchCaptureMisses >= 5) resetPitchEvidence();
      return { accepted: false };
    }
    pitchCaptureMisses = 0;
    const cents = centsForFrequency(frequency);
    const matchesPending = pitchPendingEvidence
      && seconds - pitchPendingEvidence.seconds >= 0
      && seconds - pitchPendingEvidence.seconds <= 0.3
      && Math.abs(cents - pitchPendingEvidence.cents) <= 100;
    const stable = Number.isFinite(pitchLastAcceptedCents) && Math.abs(cents - pitchLastAcceptedCents) <= 180;
    if (stable && (clarity >= threshold || Math.abs(cents - pitchLastAcceptedCents) <= 100)) {
      return acceptPitchEvidence(cents, clarity, seconds);
    }
    const required = clarity >= threshold ? 2 : 3;
    const count = matchesPending ? pitchPendingEvidence.count + 1 : 1;
    const previous = matchesPending ? pitchPendingEvidence : null;
    pitchPendingEvidence = { cents, clarity, seconds, count, frame };
    if (count < required) return { accepted: false };
    const backfill = previous ? { ...previous.frame, pitchCents: previous.cents, clarity: previous.clarity } : null;
    return acceptPitchEvidence(cents, clarity, seconds, backfill, Number.isFinite(pitchLastAcceptedCents));
  }

  function replacePitchTraceWindows(frames) {
    const accepted = frames.filter((frame) => frame && Number.isFinite(frame.pitchCents));
    if (!accepted.length) return;
    const changed = new Map();
    const binTicks = pitchTraceBinTicks();
    const mark = (line, bin) => {
      if (!changed.has(line)) changed.set(line, new Set());
      changed.get(line).add(bin);
    };
    // Grouped by the line each frame was sung on, so re-singing the upper line
    // replaces the upper contour and leaves the lower one where it was.
    const byLine = new Map();
    accepted.forEach((frame) => {
      const line = pitchTraceLaneAt(frame.tick, frame.pitchCents);
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(frame);
    });
    byLine.forEach((lineFrames, line) => {
      const lane = pitchTraceLane(line, { create: true });
      lineFrames.forEach((frame) => {
        const first = clamp(Math.ceil(frame.startTick / binTicks), 0, lane.pitches.length - 1);
        const last = clamp(Math.floor(frame.endTick / binTicks), first, lane.pitches.length - 1);
        for (let bin = first; bin <= last; bin += 1) {
          if (lane.pitches[bin]) pitchTraceCount -= 1;
          lane.pitches[bin] = 0;
          lane.breaks[bin] = 0;
          mark(line, bin);
        }
        const next = nextOccupiedPitchBin(lane, last);
        if (next >= 0) {
          lane.breaks[next] = 1;
          mark(line, next);
        }
      });
      const updates = new Map();
      lineFrames.sort((left, right) => left.tick - right.tick).forEach((frame) => {
        const bin = pitchTraceBinAtTick(frame.tick);
        const previous = updates.get(bin);
        updates.set(bin, {
          cents: Math.round(frame.pitchCents),
          breakBefore: Boolean(frame.breakBefore || previous?.breakBefore),
        });
      });
      updates.forEach(({ cents, breakBefore }, bin) => {
        if (!lane.pitches[bin]) pitchTraceCount += 1;
        lane.pitches[bin] = clamp(cents, 2000, 11000);
        lane.breaks[bin] = breakBefore ? 1 : 0;
        mark(line, bin);
      });
    });
    updatePitchTraceIncrementally(changed);
    schedulePitchTraceSave();
  }

  function beginPitchCapturePass() {
    pitchCapturePreviousTick = null;
    pitchCapturePreviousSeconds = null;
    pitchCaptureWasSilent = true;
    resetPitchEvidence();
  }

  function capturePitchSample() {
    if (!pitchCaptureEnabled() || !playing || !engine?.playing || !engine.context
      || !pitchCaptureAnalyser || !pitchCaptureDetector || !pitchCaptureBuffer) return;
    pitchCaptureAnalyser.getFloatTimeDomainData(pitchCaptureBuffer);
    const context = engine.context;
    const captureRate = pitchCaptureAnalyser.context.sampleRate;
    const inputLatency = Math.max(0, Number(pitchCaptureStream?.getAudioTracks()[0]?.getSettings?.().latency) || 0);
    const analysisLatency = PITCH_CAPTURE_BUFFER_SIZE / (2 * captureRate);
    const outputLatency = Math.max(0, (Number(context.baseLatency) || 0) + (Number(context.outputLatency) || 0));
    const scoreSeconds = clamp(engine.currentSeconds() - (analysisLatency + inputLatency + outputLatency) * engine.rate, 0, engine.duration);
    const tick = clamp(Math.round(engine.tickAtSeconds(scoreSeconds)), 0, sequence.endTick);
    if (pitchCapturePreviousTick !== null && (tick < pitchCapturePreviousTick - 2
      || pitchCapturePreviousSeconds === null || scoreSeconds - pitchCapturePreviousSeconds > 0.5)) {
      beginPitchCapturePass();
    }
    const halfWindow = PITCH_CAPTURE_INTERVAL_MS / 2000 * engine.rate;
    const frame = {
      tick,
      startTick: clamp(Math.floor(engine.tickAtSeconds(Math.max(0, scoreSeconds - halfWindow))), 0, sequence.endTick),
      endTick: clamp(Math.ceil(engine.tickAtSeconds(Math.min(engine.duration, scoreSeconds + halfWindow))), 0, sequence.endTick),
    };
    const [frequency, clarity] = resolvePitchCandidate(pitchCaptureBuffer, captureRate);
    const decision = evaluatePitchEvidence(frequency, clarity, context.currentTime, frame);
    if (decision.accepted) {
      const startsStroke = pitchCaptureWasSilent || decision.breakBefore;
      pitchCaptureWasSilent = false;
      replacePitchTraceWindows([
        decision.backfill ? { ...decision.backfill, breakBefore: startsStroke } : null,
        { ...frame, pitchCents: decision.pitchCents, breakBefore: startsStroke && !decision.backfill },
      ]);
    } else if (pitchCaptureMisses >= 5) pitchCaptureWasSilent = true;
    pitchCapturePreviousTick = tick;
    pitchCapturePreviousSeconds = scoreSeconds;
  }

  function stopPitchSampling() {
    clearTimeout(pitchCaptureTimer);
    pitchCaptureTimer = 0;
    if (pitchCaptureEnabled()) pitchCaptureState = "armed";
    savePitchTraceNow();
    updatePitchCaptureAppearance();
  }

  function runPitchSampling() {
    pitchCaptureTimer = 0;
    if (!pitchCaptureEnabled() || !playing) return;
    const started = performance.now();
    try { capturePitchSample(); }
    catch (error) {
      console.error(error);
      disablePitchCapture(false);
      showToast("Microphone pitch tracking stopped unexpectedly", "error");
      return;
    }
    const elapsed = performance.now() - started;
    const interval = elapsed > PITCH_CAPTURE_INTERVAL_MS * 0.55 ? PITCH_CAPTURE_FALLBACK_INTERVAL_MS : PITCH_CAPTURE_INTERVAL_MS;
    pitchCaptureTimer = window.setTimeout(runPitchSampling, Math.max(4, interval - elapsed));
  }

  function startPitchSampling() {
    if (!pitchCaptureEnabled() || !pitchCaptureStream || !playing || pitchCaptureTimer) return;
    beginPitchCapturePass();
    pitchCaptureState = "recording";
    updatePitchCaptureAppearance();
    pitchCaptureTimer = window.setTimeout(runPitchSampling, PITCH_CAPTURE_INTERVAL_MS);
  }

  function disablePitchCapture(announce = true) {
    if (pitchCaptureState === "off") return;
    pitchCaptureRequestGeneration += 1;
    stopPitchSampling();
    pitchCaptureState = "off";
    try { pitchCaptureSource?.disconnect(); } catch {}
    pitchCaptureStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    if (pitchCaptureContext && pitchCaptureContext !== engine?.context) void pitchCaptureContext.suspend();
    updatePitchCaptureAppearance();
    savePreferences();
    if (announce) showToast("Microphone off");
  }

  function activateCachedPitchCapture() {
    pitchCaptureStream.getAudioTracks().forEach((track) => { track.enabled = true; });
    pitchCaptureSource.connect(pitchCaptureAnalyser);
    pitchCaptureState = playing ? "recording" : "armed";
    if (playing) startPitchSampling();
    else beginPitchCapturePass();
    updatePitchCaptureAppearance();
    savePreferences();
    showToast(playing ? "Microphone on · recording pitch" : "Microphone on · press play to record");
  }

  async function startPitchCapture({ quiet = false } = {}) {
    if (!pitchCaptureSupported() || !engine) {
      if (!quiet) showToast("Microphone pitch tracking is unavailable here", "error");
      return;
    }
    const cachedTrack = pitchCaptureStream?.getAudioTracks()[0];
    if (cachedTrack?.readyState === "live" && pitchCaptureSource && pitchCaptureAnalyser && pitchCaptureDetector) {
      try {
        engine.ensureAudio();
        await Promise.all([engine.context.resume(), pitchCaptureContext?.resume()]);
        activateCachedPitchCapture();
      } catch {
        if (!quiet) showToast("Microphone pitch tracking could not resume", "error");
      }
      return;
    }
    const generation = ++pitchCaptureRequestGeneration;
    pitchCaptureState = "requesting";
    updatePitchCaptureAppearance();
    try {
      engine.ensureAudio();
      // An isolated playback graph must not host the microphone, or Firefox
      // would move it onto the microphone's device along with the input.
      if (!pitchCaptureContext) {
        pitchCaptureContext = engine.playbackIsolated
          ? new (window.AudioContext || window.webkitAudioContext)()
          : engine.context;
      }
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: { ideal: 1 }, echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false }, autoGainControl: { ideal: false },
        } }),
        engine.context.resume(),
        pitchCaptureContext.resume(),
      ]);
      if (generation !== pitchCaptureRequestGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getAudioTracks().forEach((track) => {
        try { if ("contentHint" in track) track.contentHint = "music"; } catch {}
      });
      pitchCaptureStream = stream;
      pitchCaptureAnalyser = pitchCaptureContext.createAnalyser();
      pitchCaptureAnalyser.fftSize = PITCH_CAPTURE_BUFFER_SIZE;
      pitchCaptureAnalyser.smoothingTimeConstant = 0;
      pitchCaptureSource = pitchCaptureContext.createMediaStreamSource(stream);
      pitchCaptureDetector = window.Pitchy.PitchDetector.forFloat32Array(PITCH_CAPTURE_BUFFER_SIZE);
      pitchCaptureDetector.clarityThreshold = 0.9;
      pitchCaptureDetector.minVolumeAbsolute = 0;
      pitchCaptureBuffer = new Float32Array(PITCH_CAPTURE_BUFFER_SIZE);
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        pitchCaptureState = "off";
        pitchCaptureStream = null;
        updatePitchCaptureAppearance();
        showToast("The microphone was disconnected", "error");
      }, { once: true });
      activateCachedPitchCapture();
    } catch (error) {
      if (generation !== pitchCaptureRequestGeneration) return;
      console.error(error);
      pitchCaptureState = "off";
      if (pitchCaptureContext && pitchCaptureContext !== engine?.context) void pitchCaptureContext.suspend();
      updatePitchCaptureAppearance();
      if (!quiet) showToast(error?.name === "NotAllowedError" ? "Microphone access was blocked" : "Microphone pitch tracking could not start", "error");
    }
  }

  function togglePitchCapture() {
    if (pitchCaptureEnabled() || pitchCaptureState === "requesting") disablePitchCapture();
    else void startPitchCapture();
  }

  function restoreScoreRenderStyleLock() {
    if (!scoreRenderStyleLock) return;
    const { height, overflow } = scoreRenderStyleLock;
    elements.score.style.height = height;
    elements.score.style.overflow = overflow;
    elements.score.classList.remove("is-rendering-score");
    elements.score.removeAttribute("aria-busy");
    scoreRenderStyleLock = null;
  }

  function discardScoreRenderSnapshot() {
    window.clearTimeout(scoreRenderSnapshotTimer);
    scoreRenderSnapshotTimer = 0;
    scoreRenderSnapshot?.remove();
    scoreRenderSnapshot = null;
    restoreScoreRenderStyleLock();
  }

  function retainCurrentScoreFrame() {
    if (scoreRenderSnapshot?.classList.contains("is-revealing")) {
      discardScoreRenderSnapshot();
    } else if (scoreRenderSnapshot) {
      return true;
    }
    if (!elements.score.querySelector(".at-surface-svg")) return false;

    const shellBounds = elements.scoreShell.getBoundingClientRect();
    const scoreBounds = elements.score.getBoundingClientRect();
    if (!scoreBounds.width || !scoreBounds.height) return false;

    const snapshot = document.createElement("div");
    snapshot.className = "score-render-snapshot";
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.inert = true;
    snapshot.style.left = `${scoreBounds.left - shellBounds.left}px`;
    snapshot.style.top = `${scoreBounds.top - shellBounds.top}px`;
    snapshot.style.width = `${scoreBounds.width}px`;
    snapshot.style.height = `${scoreBounds.height}px`;

    const frame = elements.score.cloneNode(true);
    frame.removeAttribute("id");
    frame.removeAttribute("aria-label");
    frame.removeAttribute("aria-busy");
    frame.classList.remove("is-rendering-score");
    frame.classList.add("score-render-frame");
    frame.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    frame.querySelectorAll(".score-note-editor").forEach((editor) => editor.remove());
    frame.style.width = `${Math.max(elements.score.scrollWidth, elements.score.clientWidth)}px`;
    frame.style.transform = `translateX(${-elements.score.scrollLeft}px)`;
    snapshot.append(frame);
    elements.scoreShell.append(snapshot);
    scoreRenderSnapshot = snapshot;

    scoreRenderStyleLock = {
      height: elements.score.style.height,
      overflow: elements.score.style.overflow,
    };
    elements.score.style.height = `${scoreBounds.height}px`;
    elements.score.style.overflow = "hidden";
    elements.score.classList.add("is-rendering-score");
    elements.score.setAttribute("aria-busy", "true");
    return true;
  }

  function releaseScoreRenderSnapshot() {
    restoreScoreRenderStyleLock();
    const snapshot = scoreRenderSnapshot;
    if (!snapshot) return;
    // The snapshot is a deep clone, so as it fades out across the live score
    // every translucent overlay is painted twice and its tint visibly darkens
    // for the length of the fade. Notation is opaque and cross-fades cleanly;
    // the highlights are not, so drop them here and let the live ones, which
    // are already in the right place for the new layout, show through alone.
    snapshot.querySelectorAll(".at-cursor-bar, .at-cursor-beat, .at-selection, .score-selected-part, .score-pitch-trace")
      .forEach((overlay) => overlay.remove());
    snapshot.classList.add("is-revealing");
    const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 130;
    scoreRenderSnapshotTimer = window.setTimeout(() => {
      if (scoreRenderSnapshot !== snapshot) return;
      snapshot.remove();
      scoreRenderSnapshot = null;
      scoreRenderSnapshotTimer = 0;
    }, delay);
  }

  function clearNotationRenderTimeout() {
    window.clearTimeout(notationRenderTimeout);
    notationRenderTimeout = 0;
  }

  function beginNotationRenderTimeout() {
    clearNotationRenderTimeout();
    notationRenderTimeout = window.setTimeout(handleNotationRenderTimeout, NOTATION_RENDER_TIMEOUT_MS);
  }

  function finishFailedNotationReload() {
    if (!pendingNotationReload) return;
    const shouldResume = pendingNotationReload.resume;
    pendingNotationReload = null;
    if (shouldResume) void engine?.startTransport();
  }

  function handleNotationRenderTimeout() {
    notationRenderTimeout = 0;
    if (!notationRenderInFlight || scoreView !== "standard") return;
    notationRenderInFlight = false;
    notationRenderQueued = false;
    discardScoreRenderSnapshot();

    const current = horizontalControl.value();
    const next = STANDARD_HORIZONTAL_VALUES.find((value) => value > current);
    if (next === undefined || !scoreTracks.length) {
      notationRenderFailed = true;
      finishFailedNotationReload();
      syncScoreLoadingVisibility();
      showToast("Standard notation could not be engraved", "error");
      return;
    }

    horizontalControl.setValue(next, false);
    savePreferences();
    setNotationLoadingMessage(`Trying ${next}% Stretch…`);
    showToast(`Notation retrying at ${next}% Stretch`);
    requestAnimationFrame(performNotationRender);
  }

  function performNotationRender() {
    if (!api || !scoreTracks.length || scoreView !== "standard") return;
    if (notationRenderInFlight) {
      notationRenderQueued = true;
      return;
    }
    cancelPitchAuditions();
    cancelScoreScrub();
    notationRenderInFlight = true;
    notationRenderQueued = false;
    notationRenderFailed = false;
    syncScoreLoadingVisibility();
    retainCurrentScoreFrame();
    try {
      api.settings.display.layoutMode = flow === "continuous" ? window.alphaTab.LayoutMode.Horizontal : window.alphaTab.LayoutMode.Page;
      api.settings.display.scale = verticalControl.value() / 100;
      api.settings.display.stretchForce = horizontalControl.value() / 100;
      applyMeasureNumberSettings();
      api.updateSettings();
      beginNotationRenderTimeout();
      api.renderTracks(scoreTracks.filter((_, index) => visibleTracks.has(index)));
    } catch (error) {
      clearNotationRenderTimeout();
      notationRenderInFlight = false;
      notationRenderQueued = false;
      discardScoreRenderSnapshot();
      console.error(error);
      showToast("Score display could not update", "error");
    }
  }

  function finishScheduledNotationRender() {
    if (!notationRenderInFlight) return true;
    clearNotationRenderTimeout();
    notationRenderInFlight = false;
    if (notationRenderQueued && scoreView === "standard") {
      notationRenderQueued = false;
      requestAnimationFrame(performNotationRender);
      return false;
    }
    notationRenderQueued = false;
    requestAnimationFrame(() => requestAnimationFrame(releaseScoreRenderSnapshot));
    return true;
  }

  function syncNotationOverflow() {
    let width = elements.score.clientWidth;
    if (flow !== "continuous") for (let i = 0; i < (api?.score?.masterBars.length || 0); i++) {
      const box = api.boundsLookup?.findMasterBarByIndex(i)?.realBounds;
      if (box) {
        width = Math.max(width, Math.ceil(box.x + box.w + 12));
        const system = api.boundsLookup.findMasterBarByIndex(i).staffSystemBounds.realBounds;
        system.w = Math.max(system.w, box.x + box.w - system.x);
      }
    }
    const overflow = flow !== "continuous" && width > elements.score.clientWidth + 2;
    elements.score.classList.toggle("has-horizontal-overflow", overflow);
    elements.score.style.setProperty("--notation-content-width", `${width}px`);
  }

  function scheduleRender() {
    if (scoreView === "bars") {
      scheduleBarRender();
      return;
    }
    if (!api || !scoreTracks.length) return;
    notationRenderFailed = false;
    syncScoreLoadingVisibility();
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(performNotationRender, 80);
  }

  function touchDistance(touches) {
    if (touches.length < 2) return 0;
    return Math.hypot(
      touches[1].clientX - touches[0].clientX,
      touches[1].clientY - touches[0].clientY,
    );
  }

  function beginScorePinch(event) {
    if (event.touches.length !== 2) return;
    cancelScoreScrub();
    cancelPitchAuditions();
    pinchStartDistance = touchDistance(event.touches);
    if (pinchStartDistance <= 0) return;
    pinchActive = true;
    pinchSurface = event.currentTarget;
    pinchStartScale = verticalControl.value();
    pinchTargetScale = pinchStartScale;
    const bounds = pinchSurface.getBoundingClientRect();
    const centerX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - bounds.left + pinchSurface.scrollLeft;
    const centerY = (event.touches[0].clientY + event.touches[1].clientY) / 2 - bounds.top;
    pinchSurface.classList.add("is-pinching");
    pinchSurface.style.transformOrigin = `${centerX}px ${centerY}px`;
    event.preventDefault();
  }

  function updateScorePinch(event) {
    if (!pinchActive || event.touches.length !== 2) return;
    const distance = touchDistance(event.touches);
    if (distance <= 0) return;
    const minimum = VERTICAL_VALUES[0];
    const maximum = VERTICAL_VALUES.at(-1);
    const continuousTarget = clamp(pinchStartScale * distance / pinchStartDistance, minimum, maximum);
    pinchTargetScale = nearestAllowed(continuousTarget, VERTICAL_VALUES);
    pinchSurface.style.transform = `scale(${continuousTarget / pinchStartScale})`;
    event.preventDefault();
  }

  function finishScorePinch(event) {
    if (!pinchActive || event.touches.length >= 2) return;
    pinchActive = false;
    pinchSurface?.classList.remove("is-pinching");
    pinchSurface?.style.removeProperty("transform");
    pinchSurface?.style.removeProperty("transform-origin");
    pinchSurface = null;
    verticalControl.setValue(pinchTargetScale, false);
    savePreferences();
    scheduleRender();
  }

  function updateSeekAppearance(milliseconds) {
    const maximum = Number(elements.seek.max) || 1;
    const progress = clamp((milliseconds / maximum) * 100, 0, 100);
    elements.timelineRail.style.setProperty("--seek-progress", `${progress}%`);
  }

  function observePlaybackCursor(barCursor, beatCursor) {
    if (typeof MutationObserver === "undefined"
      || (cursorTrimTargets[0] === barCursor && cursorTrimTargets[1] === beatCursor)) return;
    cursorTrimObserver?.disconnect();
    cursorTrimTargets = [barCursor, beatCursor];
    // AlphaTab places cursors in a later frame than its position event. Observe
    // the actual placement so a paused first seek cannot retain the old crop.
    cursorTrimObserver = new MutationObserver(trimPlaybackCursor);
    for (const cursor of cursorTrimTargets) {
      cursorTrimObserver.observe(cursor, { attributes: true, attributeFilter: ["style"] });
    }
  }

  function trimPlaybackCursor() {
    if (scoreView === "bars") return;
    const barCursor = elements.score.querySelector(".at-cursor-bar");
    const beatCursor = elements.score.querySelector(".at-cursor-beat");
    if (!barCursor || !beatCursor) return;
    observePlaybackCursor(barCursor, beatCursor);

    const cursorBounds = beatCursor.getBoundingClientRect();
    if (!cursorBounds.height) return;
    const surfaces = [...elements.score.querySelectorAll(".at-surface-svg")];
    const surface = surfaces.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.top <= cursorBounds.top + 1 && bounds.bottom >= cursorBounds.bottom - 1;
    }) || surfaces.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      const midpoint = cursorBounds.top + cursorBounds.height / 2;
      return bounds.top <= midpoint && bounds.bottom >= midpoint;
    });

    if (!surface) return;
    const staffLines = [...surface.querySelectorAll("rect")].filter((element) => {
      if (element.getAttribute("fill")?.toLowerCase() !== "#a5a5a5") return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width >= 20
        && bounds.height > 0
        && bounds.height <= 3
        && bounds.top >= cursorBounds.top - 2
        && bounds.bottom <= cursorBounds.bottom + 2;
    }).map((element) => element.getBoundingClientRect());

    if (!staffLines.length) return;
    const staffTop = Math.min(...staffLines.map((bounds) => bounds.top));
    const staffBottom = Math.max(...staffLines.map((bounds) => bounds.bottom));
    const topInset = clamp((staffTop - cursorBounds.top) / cursorBounds.height * 100, 0, 48);
    const bottomInset = clamp((cursorBounds.bottom - staffBottom) / cursorBounds.height * 100, 0, 48);
    for (const cursor of [barCursor, beatCursor]) {
      const top = `${topInset}%`, bottom = `${bottomInset}%`;
      if (cursor.style.getPropertyValue("--cursor-clip-top") !== top) {
        cursor.style.setProperty("--cursor-clip-top", top);
      }
      if (cursor.style.getPropertyValue("--cursor-clip-bottom") !== bottom) {
        cursor.style.setProperty("--cursor-clip-bottom", bottom);
      }
    }
  }

  function scheduleCursorTrim() {
    if (cursorTrimFrame) return;
    cursorTrimFrame = requestAnimationFrame(() => {
      cursorTrimFrame = 0;
      trimPlaybackCursor();
    });
  }

  function scheduleCursorTrimBurst(passes = 8) {
    const generation = ++cursorTrimBurstGeneration;
    let frame = 0;
    const trimAfterPaint = () => {
      if (generation !== cursorTrimBurstGeneration) return;
      trimPlaybackCursor();
      frame += 1;
      if (frame < passes) requestAnimationFrame(trimAfterPaint);
    };
    requestAnimationFrame(trimAfterPaint);
  }

  function cancelVerticalFollowAnimation(clearPrediction = false) {
    verticalFollowAnimationGeneration += 1;
    if (verticalFollowAnimationFrame) cancelAnimationFrame(verticalFollowAnimationFrame);
    verticalFollowAnimationFrame = 0;
    if (clearPrediction) predictiveFollowRange = null;
  }

  function interruptVerticalFollow() {
    if (verticalFollowAnimationFrame || predictiveFollowRange) cancelVerticalFollowAnimation(true);
    // Real input must also end the grace period after a completed auto-scroll.
    automaticScrollUntil = 0;
  }

  function followScrollDuration(distance) {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
    return clamp(150 + Math.sqrt(Math.max(0, distance)) * 8, 180, 520);
  }

  function animateVerticalFollow(destination, duration) {
    cancelVerticalFollowAnimation();
    const start = window.scrollY;
    const target = Math.max(0, Number(destination) || 0);
    const distance = target - start;
    const animationDuration = Math.max(0, Number(duration) || 0);
    automaticScrollUntil = Date.now() + animationDuration + 120;
    if (Math.abs(distance) < 1 || animationDuration === 0) {
      window.scrollTo({ top: target, behavior: "auto" });
      return;
    }
    const generation = ++verticalFollowAnimationGeneration;
    const startedAt = performance.now();
    const frame = (now) => {
      if (generation !== verticalFollowAnimationGeneration) return;
      const progress = clamp((now - startedAt) / animationDuration, 0, 1);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      window.scrollTo({ top: start + distance * eased, behavior: "auto" });
      if (progress < 1) verticalFollowAnimationFrame = requestAnimationFrame(frame);
      else verticalFollowAnimationFrame = 0;
    };
    verticalFollowAnimationFrame = requestAnimationFrame(frame);
  }

  function masterBarLayoutBox(measureIndex) {
    const lookup = api?.boundsLookup || api?.renderer?.boundsLookup;
    const masterBounds = lookup?.findMasterBarByIndex?.(measureIndex);
    return masterBounds?.realBounds || masterBounds?.visualBounds || masterBounds?.lineAlignedBounds || null;
  }

  function nextVerticalSystemTransition(cursor) {
    if (!engine || flow === "continuous") return null;
    const currentTick = clamp(engine.tickAtSeconds(engine.currentSeconds()), 0, Math.max(0, sequence.endTick - 1));
    if (scoreView === "bars") {
      const systemIndex = barSystems.findIndex((system) => currentTick >= system.startTick && currentTick < system.endTick);
      const nextSystem = systemIndex >= 0 ? barSystems[systemIndex + 1] : null;
      if (!nextSystem) return null;
      const bounds = nextSystem.shell.getBoundingClientRect();
      return { currentTick, tick: nextSystem.startTick, bounds: { top: bounds.top, bottom: bounds.bottom } };
    }

    const currentMeasureIndex = measureIndexAtTick(currentTick);
    const currentBox = masterBarLayoutBox(currentMeasureIndex);
    const currentY = Number(currentBox?.y);
    if (!Number.isFinite(currentY)) return null;
    let nextMeasureIndex = -1;
    let nextBox = null;
    for (let index = currentMeasureIndex + 1; index < sequence.measures.length; index += 1) {
      const candidate = masterBarLayoutBox(index);
      const candidateY = Number(candidate?.y);
      if (!Number.isFinite(candidateY) || Math.abs(candidateY - currentY) <= 1) continue;
      nextMeasureIndex = index;
      nextBox = candidate;
      break;
    }
    if (nextMeasureIndex < 0 || !nextBox) return null;
    const origin = elements.score.getBoundingClientRect();
    const nextTop = origin.top + Number(nextBox.y) - elements.score.scrollTop;
    const nextHeight = Math.max(1, Number(nextBox.h) || Number(currentBox.h));
    return {
      currentTick,
      tick: Number(sequence.measures[nextMeasureIndex]?.[0]) || 0,
      bounds: { top: nextTop, bottom: nextTop + nextHeight },
    };
  }

  function predictiveVerticalFollow(cursor) {
    if (verticalFollowAnimationFrame || flow === "continuous") return false;
    const transition = nextVerticalSystemTransition(cursor);
    if (!transition) return false;
    if (Number.isInteger(loopEndMeasure)) {
      const loopEnd = sequence.measures[loopEndMeasure];
      const loopEndTick = Number(loopEnd?.[0]) + Number(loopEnd?.[1]);
      if (transition.currentTick < loopEndTick && transition.tick >= loopEndTick) return false;
    }
    const header = elements.transport.getBoundingClientRect().height;
    const topLimit = header + 8;
    const bottomLimit = window.innerHeight - 20;
    if (transition.bounds.bottom <= bottomLimit) return false;
    const targetHeight = Math.max(1, transition.bounds.bottom - transition.bounds.top);
    const delta = transition.bounds.top - readingLine(targetHeight, topLimit, bottomLimit);
    if (delta <= 1) return false;
    const destination = window.scrollY + delta;
    const duration = followScrollDuration(Math.abs(destination - window.scrollY));
    const secondsUntilTransition = engine.secondsAtTick(transition.tick) - engine.currentSeconds();
    if (secondsUntilTransition < 0
      || secondsUntilTransition > (duration + FOLLOW_SCROLL_LEAD_BUFFER_MS) / 1000) return false;
    predictiveFollowRange = { startTick: transition.currentTick, targetTick: transition.tick };
    playbackDetached = false;
    hidePlaybackReturn();
    animateVerticalFollow(destination, duration);
    return true;
  }

  function gentleFollowCursor() {
    if (!engine?.playing || pendingNotationReload || scoreScrub) return;
    if (performance.now() - lastFollow < FOLLOW_CHECK_INTERVAL_MS) return;
    lastFollow = performance.now();
    const cursor = playbackCursorBounds();
    if (!cursor) return;
    if (playbackDetached) {
      updatePlaybackReturn();
      return;
    }
    const currentTick = engine?.tickAtSeconds(engine.currentSeconds()) ?? 0;
    if (predictiveFollowRange) {
      if (currentTick >= predictiveFollowRange.startTick - 1
        && currentTick < predictiveFollowRange.targetTick) return;
      predictiveFollowRange = null;
    }
    if (verticalFollowAnimationFrame) return;
    const direction = playbackDirection(cursor);
    if (direction) scrollToPlayback(direction, "smooth", true);
    else predictiveVerticalFollow(cursor);
  }

  // Where the music comes to rest when the view follows it: a fifth of the way
  // down the reading band, the same line the band already treats as the top of
  // comfortable reading. That leaves a system of context above it and the rest
  // of the screen as lookahead, and the music then has the whole page to cross
  // before the view has to move again. Landing it at the bottom edge instead,
  // which is all a minimum scroll needs, hides what is coming and moves the
  // page at every system. A system too tall for that hangs from the top, so
  // none of it is cut off.
  function readingLine(cursorHeight, topLimit, bottomLimit) {
    const usableHeight = Math.max(1, bottomLimit - topLimit);
    return cursorHeight >= usableHeight * 0.8 ? topLimit : topLimit + usableHeight * 0.2;
  }

  function playbackCursorPlace() {
    const bounds = playbackCursorBounds();
    return bounds ? `${Math.round(bounds.left)}:${Math.round(bounds.top)}` : null;
  }

  // A jump only reads as a jump if the score comes with it. The pitchbar view
  // moves its playhead as the seek is applied, while AlphaTab moves its cursor
  // a frame or two later, so this waits for whichever it is to leave the place
  // it held BEFORE the seek. A jump that stays in view never moves far enough
  // to need a scroll and simply runs out of attempts.
  function followCursorFrom(place) {
    let frames = 0;
    const attempt = () => {
      if (playbackCursorPlace() !== place) {
        const direction = playbackDirection();
        if (direction) scrollToPlayback(direction, "smooth", true);
        return;
      }
      if ((frames += 1) < 12) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }

  function playbackCursorBounds() {
    if (!engine || pendingNotationReload) return null;
    const tick = clamp(engine.tickAtSeconds(engine.currentSeconds()), 0, Math.max(0, sequence.endTick - 1));
    if (scoreView === "bars") {
      const system = barSystems.find((system) => tick >= system.startTick && tick < system.endTick);
      return system?.cursor.getBoundingClientRect() || null;
    }
    // The animated AlphaTab cursor can still belong to the previous system
    // when its position event fires. Follow the current measure's geometry.
    const box = masterBarLayoutBox(measureIndexAtTick(tick));
    if (!box) return null;
    const origin = elements.score.getBoundingClientRect();
    let left = origin.left + box.x - elements.score.scrollLeft, width = box.w;
    if (elements.score.classList.contains("has-horizontal-overflow")) {
      const line = elements.score.querySelector(".at-cursor-beat")?.getBoundingClientRect();
      if (line) { left = line.left; width = line.width; }
    }
    const top = origin.top + box.y - elements.score.scrollTop;
    return { left, top, right: left + width, bottom: top + box.h, width, height: box.h };
  }

  function playbackDirection(cursor = playbackCursorBounds()) {
    if (!cursor) return null;
    const bounds = cursor;
    const header = elements.transport.getBoundingClientRect().height;
    const topLimit = header + 8;
    const bottomLimit = window.innerHeight - 20;
    if (bounds.bottom < topLimit) return "up";
    if (bounds.top > bottomLimit) return "down";
    const scoreSurface = scoreView === "bars" ? elements.barScore : elements.score;
    if (flow === "continuous" || scoreSurface.classList.contains("has-horizontal-overflow")) {
      const scoreBounds = scoreSurface.getBoundingClientRect();
      const leftLimit = Math.max(0, scoreBounds.left) + 10;
      const rightLimit = Math.min(window.innerWidth, scoreBounds.right) - 10;
      if (bounds.right < leftLimit) return "left";
      if (bounds.left > rightLimit) return "right";
    }
    return null;
  }

  function cursorOutsideReadingBand(cursor = playbackCursorBounds()) {
    if (!cursor) return false;
    const direction = playbackDirection(cursor);
    if (["left", "right"].includes(direction)) return true;
    const bounds = cursor;
    const header = elements.transport.getBoundingClientRect().height;
    const usableTop = header + 8;
    const usableBottom = window.innerHeight - 20;
    const usableHeight = Math.max(1, usableBottom - usableTop);
    return bounds.bottom < usableTop + usableHeight * 0.20
      || bounds.top > usableTop + usableHeight * 0.80;
  }

  function hidePlaybackReturn() {
    elements.playbackReturn.classList.remove("is-visible");
    elements.playbackReturn.setAttribute("aria-hidden", "true");
    elements.playbackReturn.tabIndex = -1;
  }

  function updatePlaybackReturn() {
    const cursor = playbackCursorBounds();
    if (!playbackDetached || !cursor) {
      hidePlaybackReturn();
      return;
    }
    const direction = playbackDirection(cursor);
    if (!direction) {
      playbackDetached = false;
      hidePlaybackReturn();
      return;
    }
    const location = {
      up: "above",
      down: "below",
      left: "to the left",
      right: "to the right",
    }[direction];
    elements.playbackReturn.dataset.direction = direction;
    elements.playbackReturn.setAttribute("aria-label", `Current playback is ${location}. Return to it.`);
    elements.playbackReturn.title = `Return to playback ${location}`;
    elements.playbackReturn.setAttribute("aria-hidden", "false");
    elements.playbackReturn.tabIndex = 0;
    elements.playbackReturn.classList.add("is-visible");
  }

  function scrollToPlayback(direction = playbackDirection(), behavior = "smooth", minimal = false) {
    const cursor = playbackCursorBounds();
    if (!cursor) return false;
    playbackDetached = false;
    predictiveFollowRange = null;
    hidePlaybackReturn();
    const bounds = cursor;
    const header = elements.transport.getBoundingClientRect().height;
    const topLimit = header + 8;
    const bottomLimit = window.innerHeight - 20;
    if (["up", "down"].includes(direction)) {
      const destination = minimal
        ? window.scrollY + bounds.top - readingLine(bounds.height, topLimit, bottomLimit)
        : window.scrollY + bounds.top - (topLimit + Math.max(0, bottomLimit - topLimit - bounds.height) / 2);
      if (behavior === "smooth") {
        const target = Math.max(0, destination);
        animateVerticalFollow(target, followScrollDuration(Math.abs(target - window.scrollY)));
      } else {
        cancelVerticalFollowAnimation();
        automaticScrollUntil = Date.now() + 300;
        window.scrollTo({ top: Math.max(0, destination), behavior: "auto" });
      }
    } else {
      automaticScrollUntil = Date.now() + (behavior === "smooth" ? 800 : 300);
      const scoreSurface = scoreView === "bars" ? elements.barScore : elements.score;
      const scoreBounds = scoreSurface.getBoundingClientRect();
      const destination = minimal
        ? direction === "left"
          ? scoreSurface.scrollLeft + bounds.left - scoreBounds.left - 10
          : scoreSurface.scrollLeft + bounds.right - scoreBounds.right + 10
        : scoreSurface.scrollLeft + bounds.left - scoreBounds.left - (scoreBounds.width - bounds.width) / 2;
      scoreSurface.scrollTo({ left: Math.max(0, destination), behavior });
    }
    return true;
  }

  function recordManualScoreScroll() {
    if (followScrollFrame) return;
    followScrollFrame = requestAnimationFrame(() => {
      followScrollFrame = 0;
      if (Date.now() < automaticScrollUntil) return;
      cancelVerticalFollowAnimation(true);
      const cursor = playbackCursorBounds();
      if (!cursor) {
        hidePlaybackReturn();
        return;
      }
      playbackDetached = cursorOutsideReadingBand(cursor);
      updatePlaybackReturn();
    });
  }

  function syncPlaybackButton() {
    const preparing = Boolean(engine?.preparing);
    elements.playPause.classList.toggle("is-playing", playing || preparing);
    elements.playPause.setAttribute("aria-busy", String(preparing));
    elements.playPause.setAttribute("aria-label", preparing ? "Cancel playback start" : playing ? "Pause score" : "Play score");
    elements.playPause.title = preparing ? "Cancel playback start (Space)" : playing ? "Pause (Space)" : "Play (Space)";
  }

  function initializeMediaSession() {
    if (!("mediaSession" in navigator) || window.frameElement?.inert) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: String(config.title || buildMetadata.title || document.title.replace(/(?: \| Melete| — (?:Practice score|Choir Practice))$/u, "")),
        artist: String(config.composer || buildMetadata.composer || "Choir practice score"),
      });
      navigator.mediaSession.setActionHandler("play", () => { void engine?.startTransport(); });
      navigator.mediaSession.setActionHandler("pause", () => engine?.pauseTransport());
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        cancelVerticalFollowAnimation(true);
        const next = Math.max(0, engine.currentSeconds() - (details.seekOffset || 5));
        api.tickPosition = engine.tickAtSeconds(next);
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        cancelVerticalFollowAnimation(true);
        const next = Math.min(engine.duration, engine.currentSeconds() + (details.seekOffset || 5));
        api.tickPosition = engine.tickAtSeconds(next);
      });
    } catch {
      // Media Session is optional.
    }
  }

  elements.settingsToggle.addEventListener("click", () => setSettingsOpen(!elements.settingsPanel.classList.contains("is-open")));
  window.addEventListener("scroll", recordManualScoreScroll, { passive: true });
  window.addEventListener("pointerdown", interruptVerticalFollow, { capture: true, passive: true });
  window.addEventListener("wheel", interruptVerticalFollow, { capture: true, passive: true });
  elements.score.addEventListener("scroll", recordManualScoreScroll, { passive: true });
  elements.barScore.addEventListener("scroll", recordManualScoreScroll, { passive: true });
  elements.score.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".score-note-layer")) return;
    const note = standardNoteAtClientPoint(event.clientX, event.clientY);
    const chord = !note && standardChordTargetAtClientPoint(event.clientX, event.clientY);
    const preview = note || (chord ? { notes: chordNotesAtTick(chord.tick), fullChord: true } : null);
    const follow = (pointer) => {
      if (!chord) return standardNoteAtClientPoint(pointer.clientX, pointer.clientY, true);
      const target = standardChordTargetAtClientPoint(pointer.clientX, pointer.clientY, false);
      return target ? { notes: chordNotesAtTick(target.tick) } : null;
    };
    const targetAtPointer = (pointerEvent) => note && Number.isFinite(note.tick)
      ? { tick: note.tick, exactTick: true, partIndex: note.track }
      : chord || standardScoreTargetAtClientPoint(
      pointerEvent.clientX,
      pointerEvent.clientY,
      currentScorePartIndex(),
    );
    if (!beginPitchAudition(event, preview, follow, targetAtPointer)) beginScoreScrub(event, targetAtPointer);
  });
  elements.score.addEventListener("touchstart", beginScorePinch, { passive: false });
  elements.score.addEventListener("touchmove", updateScorePinch, { passive: false });
  elements.score.addEventListener("touchend", finishScorePinch, { passive: false });
  elements.score.addEventListener("touchcancel", finishScorePinch, { passive: false });
  elements.barScore.addEventListener("touchstart", beginScorePinch, { passive: false });
  elements.barScore.addEventListener("touchmove", updateScorePinch, { passive: false });
  elements.barScore.addEventListener("touchend", finishScorePinch, { passive: false });
  elements.barScore.addEventListener("touchcancel", finishScorePinch, { passive: false });
  window.addEventListener("blur", () => { cancelPitchAuditions(); cancelScoreScrub(); });
  window.addEventListener("pagehide", () => { cancelPitchAuditions(); cancelScoreScrub(); });
  elements.playbackReturn.addEventListener("click", () => scrollToPlayback(playbackDirection(), "smooth", false));
  elements.practicePart.addEventListener("input", () => {
    setPracticePart(practicePartPager?.value());
    updateNoteActionLabel();
    if (scoreView === "bars") scheduleBarRender();
    // Choosing here answers the first-visit question as well.
    if (Number.isInteger(practicePartIndex) && !elements.partChooser.hidden) {
      rememberPartChooser("chosen");
      hidePartChooser();
    }
  });
  elements.flowToggle.addEventListener("click", () => setFlow(flow === "wrap" ? "continuous" : "wrap"));
  elements.flowToggle.addEventListener("keydown", (event) => {
    let next = null;
    if (["ArrowLeft", "ArrowUp", "Home"].includes(event.key)) next = "wrap";
    else if (["ArrowRight", "ArrowDown", "End"].includes(event.key)) next = "continuous";
    if (!next) return;
    setFlow(next);
    elements.flowToggle.querySelector(`[data-flow="${next}"]`)?.focus();
    event.preventDefault();
  });
  elements.scoreViewToggle.addEventListener("click", () => setScoreView(scoreView === "standard" ? "bars" : "standard"));
  elements.scoreViewToggle.addEventListener("keydown", (event) => {
    let next = null;
    if (["ArrowLeft", "ArrowUp", "Home"].includes(event.key)) next = "standard";
    else if (["ArrowRight", "ArrowDown", "End"].includes(event.key)) next = "bars";
    if (!next) return;
    setScoreView(next);
    elements.scoreViewToggle.querySelector(`[data-view="${next}"]`)?.focus();
    event.preventDefault();
  });
  attachHoldReset(elements.pitchCapture, togglePitchCapture, clearPitchTrace, "pitch trace");
  elements.tempo.addEventListener("input", () => {
    if (api) api.playbackSpeed = tempoControl.value() / 100;
    savePreferences();
  });
  elements.metronome.addEventListener("input", () => {
    engine?.setMetronome(metronomeControl.value());
    savePreferences();
  });
  elements.verticalScale.addEventListener("input", () => { savePreferences(); scheduleRender(); });
  elements.horizontalScale.addEventListener("input", () => { savePreferences(); scheduleRender(); });
  attachHoldReset(elements.loopStart, () => setLoopPoint("start"), clearLoop, "loop");
  attachHoldReset(elements.loopEnd, () => setLoopPoint("end"), clearLoop, "loop");
  elements.playPause.addEventListener("click", () => engine?.toggleTransport());
  document.addEventListener("melete:restore-position", event => restorePlaybackPosition(event.detail?.milliseconds));
  document.addEventListener("melete:activate", () => { if (ready) initializeMediaSession(); });
  elements.seek.addEventListener("pointerdown", (event) => {
    seeking = true;
    scrubLabelPointer = event.pointerType === "mouse" ? null : event.pointerId;
  });
  elements.seek.addEventListener("input", () => {
    const value = previewSeek(Number(elements.seek.value), true);
    if (scrubLabelPointer !== null) showScrubLabel(value);
  });
  elements.seek.addEventListener("change", () => {
    hideScrubLabel();
    if (!ready || !engine) return;
    seeking = false;
    const value = previewSeek(Number(elements.seek.value));
    api.tickPosition = seekTickFor(value);
  });
  elements.seek.addEventListener("pointercancel", () => { seeking = false; hideScrubLabel(); });
  // A release can land anywhere once the finger has slid off the rail.
  ["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, (event) => {
    if (event.pointerId === scrubLabelPointer) hideScrubLabel();
  }, true));
  window.addEventListener("blur", hideScrubLabel);
  elements.seek.addEventListener("keydown", (event) => {
    if (!ready || !engine || !api) return;
    let value = null;
    if (["ArrowLeft", "ArrowDown"].includes(event.key)) value = adjacentChapterMilliseconds(elements.seek.value, -1);
    else if (["ArrowRight", "ArrowUp"].includes(event.key)) value = adjacentChapterMilliseconds(elements.seek.value, 1);
    else if (event.key === "Home") value = chapterSeekMilliseconds[0] ?? 0;
    else if (event.key === "End") value = chapterSeekMilliseconds.at(-1) ?? Math.round(engine.duration * 1000);
    if (value === null) return;
    previewSeek(value, true);
    event.preventDefault();
  });
  elements.fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      showToast("Full screen is unavailable", "error");
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const full = Boolean(document.fullscreenElement);
    elements.fullscreen.setAttribute("aria-label", full ? "Exit full screen" : "Enter full screen");
    elements.fullscreen.dataset.help = full ? "Exit full screen." : "Enter full screen.";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") { cancelPitchAuditions(); cancelScoreScrub(); }
    if (document.visibilityState !== "visible" || !pitchCaptureEnabled() || !pitchCaptureStream) return;
    const track = pitchCaptureStream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") return;
    track.enabled = true;
    void engine?.context?.resume().then(() => pitchCaptureContext?.resume()).then(() => {
      if (playing) startPitchSampling();
      else {
        pitchCaptureState = "armed";
        updatePitchCaptureAppearance();
      }
    });
  });
  elements.noteMode.addEventListener("click", () => {
    if (isMobileSettingsDevice()) setSettingsOpen(false);
    startInlineNoteEdit(currentScoreTick(), currentScorePartIndex());
  });

  function isTextEntryTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable) return true;
    return target instanceof HTMLInputElement
      && ["text", "search", "email", "url", "tel", "password"].includes(target.type);
  }

  // Pointer interaction should not leave a toolbar control holding keyboard
  // focus. Keyboard-originated activation retains focus for normal navigation.
  elements.transport.addEventListener("pointerup", (event) => {
    const control = event.target instanceof Element
      ? event.target.closest("button, input, a, [role='button'], [role='spinbutton'], [role='slider'], [tabindex]")
      : null;
    if (!(control instanceof HTMLElement) || isTextEntryTarget(control)) return;
    requestAnimationFrame(() => {
      if (document.activeElement === control) control.blur();
    });
  });

  // Space is the transport shortcut throughout the practice interface. Handle
  // it in capture phase so a focused button cannot activate itself and the
  // browser cannot scroll the page; preserve ordinary spaces in text editors.
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) engine?.toggleTransport();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, { capture: true });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (event.defaultPrevented) return;
    if (event.key.startsWith("Arrow") && target instanceof Element
      && target.closest("button, select, [role='spinbutton'], [role='slider'], [role='tab']")) return;
    // Up and down step between section breaks, the way an editor steps between
    // cuts; left and right audition adjacent notes of the selected part. The score follows so the
    // jump lands somewhere you can read, and a control that uses the arrows
    // itself has already called preventDefault by the time this runs.
    if (["ArrowUp", "ArrowDown"].includes(event.key) && engine && api) {
      // Section starts only: the end of the piece is also a snap point, and
      // seeking onto it sends the transport back to the beginning, so stepping
      // forward stops at the last section rather than falling off the end.
      const here = engine.currentSeconds() * 1000;
      const stops = chapterSeekMilliseconds.filter((point) => point < engine.duration * 1000 - 1);
      const step = event.key === "ArrowDown"
        ? stops.find((point) => point > here + 1)
        : [...stops].reverse().find((point) => point < here - 1);
      if (step === undefined) { event.preventDefault(); return; }
      // The same path a click on the score takes, so both views move their
      // playhead and the section start is honoured exactly rather than snapped
      // to the nearest eighth.
      const from = playbackCursorPlace();
      applyScoreScrubTarget({ tick: engine.tickAtSeconds(step / 1000), exactTick: true });
      followCursorFrom(from);
      event.preventDefault();
      return;
    }
    if (["ArrowLeft", "ArrowRight"].includes(event.key) && engine && api) {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      stepScoreNote(direction);
      event.preventDefault();
      return;
    }
    if (event.key === "[") {
      setLoopPoint("start");
      event.preventDefault();
    } else if (event.key === "]") {
      setLoopPoint("end");
      event.preventDefault();
    } else if (event.key === "Escape") {
      if (elements.settingsPanel.classList.contains("is-open")) setSettingsOpen(false);
    }
  });

  window.addEventListener("resize", () => requestAnimationFrame(() => {
    syncPillThumb();
    updateTransportHeight();
    if (!("ResizeObserver" in window) && api && scoreTracks.length) scheduleRender();
  }));

  if ("ResizeObserver" in window) {
    lastScoreShellWidth = Math.round(elements.scoreShell.getBoundingClientRect().width || 0);
    scoreResizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || elements.scoreShell.getBoundingClientRect().width || 0);
      if (!width || Math.abs(width - lastScoreShellWidth) < 2) return;
      lastScoreShellWidth = width;
      if (api && scoreTracks.length) scheduleRender();
    });
    scoreResizeObserver.observe(elements.scoreShell);
  }

  function embeddedText(id) {
    const embedded = document.getElementById(id)?.textContent?.trim();
    if (embedded) return embedded;
    throw new Error(`Embedded ${id} is missing`);
  }

  function currentPortableState() {
    return {
      version: PORTABLE_STATE_VERSION,
      fingerprint: portableStateFingerprint(),
      preferences: currentPreferenceState(),
      annotations: currentAnnotationState(),
    };
  }

  function jsonForEmbeddedScript(value) {
    return JSON.stringify(value)
      .replace(/</gu, "\\u003c")
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029");
  }

  function documentWithPortableState(source, state) {
    const scriptClose = `<${"/"}script>`;
    const marker = new RegExp(`<script\\b[^>]*\\bid=["']portable-state["'][^>]*>[\\s\\S]*?${scriptClose}`, "iu");
    if (!marker.test(source)) throw new Error("Portable state marker is missing");
    const replacement = `<script id="portable-state" type="application/json">${jsonForEmbeddedScript(state)}${scriptClose}`;
    return source.replace(marker, () => replacement);
  }

  function saveStandaloneBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function chooseStandaloneSaveHandle(filename) {
    if (!window.isSecureContext || typeof window.showSaveFilePicker !== "function") return null;
    return window.showSaveFilePicker({
      id: "choir-practice-score",
      suggestedName: filename,
      types: [{
        description: "Standalone HTML file",
        accept: { "text/html": [".html", ".htm"] },
      }],
    });
  }

  async function writeStandaloneFile(handle, blob) {
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      throw error;
    }
  }

  async function downloadStandalone(event) {
    event.preventDefault();
    if (elements.download.getAttribute("aria-busy") === "true") return;
    elements.download.setAttribute("aria-busy", "true");

    try {
      const filename = elements.download.download || "choir-practice.html";
      let saveHandle = null;
      try {
        saveHandle = await chooseStandaloneSaveHandle(filename);
      } catch (error) {
        if (error?.name === "AbortError") return;
        console.warn("Save picker unavailable; falling back to browser download", error);
      }

      if (editingAnnotation) commitInlineNoteEdit();
      savePreferences();
      const source = initialDocumentSource || `<!doctype html>\n${document.documentElement.outerHTML}`;
      const portableDocument = documentWithPortableState(source, currentPortableState());
      const blob = new Blob([portableDocument], { type: "text/html;charset=utf-8" });
      if (saveHandle) {
        await writeStandaloneFile(saveHandle, blob);
        showToast("Score saved with settings and annotations");
      } else {
        saveStandaloneBlob(blob, filename);
        showToast("Score downloaded with settings and annotations");
      }
    } catch (error) {
      console.error(error);
      showToast("Could not download this score", "error");
    } finally {
      elements.download.removeAttribute("aria-busy");
    }
  }

  async function downloadMuseScore() {
    const button = elements.downloadScore;
    if (!config.sourceScore?.data || button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    try {
      const filename = config.sourceScore.filename || "score.mscz";
      let handle = null;
      if (window.isSecureContext && typeof window.showSaveFilePicker === "function") {
        try {
          handle = await window.showSaveFilePicker({
            id: "choir-practice-musescore",
            suggestedName: filename,
            types: [{ description: "MuseScore file", accept: { "application/octet-stream": [".mscz"] } }],
          });
        } catch (error) {
          if (error?.name === "AbortError") return;
          console.warn("Save picker unavailable; falling back to browser download", error);
        }
      }
      const blob = new Blob([base64ToBytes(config.sourceScore.data)], { type: "application/octet-stream" });
      if (handle) await writeStandaloneFile(handle, blob);
      else saveStandaloneBlob(blob, filename);
    } catch (error) {
      console.error(error);
      showToast("Could not save the MuseScore file", "error");
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  async function init() {
    initialDocumentSource = `<!doctype html>\n${document.documentElement.outerHTML}`;
    const currentDocument = window.location.href.split(/[?#]/u)[0];
    const isStandalone = Boolean(document.getElementById("alphatab-runtime"));
    elements.download.href = isStandalone
      ? currentDocument
      : new URL("./dist/index.html", currentDocument).href;
    if (isStandalone) {
      elements.download.addEventListener("click", (event) => downloadStandalone(event));
    }
    updateTransportHeight();
    setupSettingsHelp();
    if (!window.alphaTab) {
      showLoadError("Notation engine unavailable");
      return;
    }

    try {
      config = parseEmbeddedJson("trainer-config", {});
      buildMetadata = parseEmbeddedJson("build-metadata", {});
      portableState = parseEmbeddedJson("portable-state", null);
      elements.download.download = `${String(config.slug || "choir-practice").replace(/[^a-z0-9-]+/giu, "-") || "choir-practice"}.html`;
      const demoVideo = demoVideoAddress(config.demoVideo);
      if (demoVideo && elements.demoVideo) {
        elements.demoVideo.href = demoVideo;
        elements.demoVideo.hidden = false;
      }
      if (config.printPdfUrl && elements.printScore) {
        const address = new URL(config.printPdfUrl, document.baseURI);
        if (!["http:", "https:", "file:"].includes(address.protocol)) throw new Error("Invalid PDF link");
        elements.printScore.href = address.href;
        elements.printScore.hidden = false;
      } else if (config.printPdf && elements.printScore) {
        const pdf = new Blob([base64ToBytes(config.printPdf)], { type: "application/pdf" });
        elements.printScore.href = URL.createObjectURL(pdf);
        elements.printScore.hidden = false;
      }
      if (config.sourceScore?.data && elements.downloadScore) {
        elements.downloadScore.addEventListener("click", downloadMuseScore);
        elements.downloadScore.hidden = false;
      }
      fullScoreXml = embeddedText("score-data");
      const playbackJson = embeddedText("playback-data");
      sequence = JSON.parse(playbackJson);
      if (!Number.isFinite(sequence.division) || !Number.isFinite(sequence.endTick) || !sequence.notes?.length || !sequence.measures?.length) {
        throw new Error("Playback data is incomplete");
      }
      pitchBarUnitTicks = shortestPitchBarNoteTicks(fullScoreXml, sequence);
      parts = normalizeParts(sequence.parts);
      if (!parts.length) throw new Error("No score parts were found");
      configurePitchGuides(fullScoreXml);
      partDivisi = analysePartDivisi();
      // One key per kind of saved data, named after the song and never
      // versioned. Keying on the build's fingerprint meant every rebuild of the
      // same song started from nothing and left the last build's data behind,
      // unreachable. Anything found under an older key is adopted once and the
      // old entry removed.
      const songKey = (suffix) => `choir-practice:${config.slug || config.title || "score"}:${suffix}`;
      const buildFingerprint = buildMetadata.build?.fingerprint || buildMetadata.fingerprint;
      preferenceKey = songKey("preferences");
      legacyPreferenceKeys = [`choir-practice:${buildMetadata.fingerprint}:v2`];
      settingsPanelPreferenceKey = songKey("settings-open");
      legacySettingsPanelKeys = [`${songKey("settings-open")}:v1`];
      pitchTraceKey = songKey("pitch-trace");
      legacyPitchTraceKeys = [`choir-practice:${buildFingerprint}:pitch-trace:v2`];
      annotationKey = songKey("notes");
      legacyAnnotationKeys = [`${songKey("notes")}:v3`, `${songKey("notes")}:v2`,
        `choir-practice:${buildMetadata.fingerprint}:v2:notes`];
      partChooserKey = songKey("part-chooser");
      setSettingsOpen(loadSettingsOpenState(), { persist: false });
      loadPreferences();
      loadPitchTrace();
      buildMixer();
      buildPracticePartPicker();
      registerStaticResetTargets();
      loadAnnotations();
      sweepSupersededStorage(config.slug || config.title || "score");
      attachMixerGestures();
      updateLoopState();
      updateNoteActionLabel();
      updatePitchCaptureAppearance();
      // A link naming a part wins; otherwise a first visit with no part asks.
      const ownPartLink = partLinkFields(window.location.search, window.location.hash);
      const ownLinkNamesPart = ownPartLink.part !== undefined || ownPartLink.div !== undefined;
      if (ownLinkNamesPart) consumePartLink();
      const arrivalLink = pendingPartLink || (ownLinkNamesPart ? ownPartLink : null);
      pendingPartLink = null;
      if (!applyPartLink(arrivalLink) && !Number.isInteger(practicePartIndex) && !partChooserAnswered()) showPartChooser();

      const settings = new window.alphaTab.Settings();
      settings.core.file = null;
      settings.core.fontDirectory = null;
      settings.core.useWorkers = false;
      settings.core.enableLazyLoading = true;
      settings.core.includeNoteBounds = true;
      settings.core.tracks = "all";
      settings.core.smuflFontSources = new Map([[window.alphaTab.FontFileFormat.Woff2, window.TRAINER_FONT_SOURCE]]);
      settings.display.layoutMode = flow === "continuous" ? window.alphaTab.LayoutMode.Horizontal : window.alphaTab.LayoutMode.Page;
      settings.display.scale = verticalControl.value() / 100;
      settings.display.barsPerRow = -1;
      settings.display.stretchForce = horizontalControl.value() / 100;
      settings.importer.mergePartGroupsInMusicXml = false;
      applyMeasureNumberSettings(settings);
      applyLyricFontSettings(settings);
      // Blake, on Autumn: MuseScore's second voice is used for a divisi whose
      // rhythm differs, not for a different kind of note. AlphaTab greys those
      // notes by default, which reads as "these are special" when they are just
      // more notes to sing. Paint them like the main voice.
      const glyphs = settings.display.resources;
      if (glyphs && glyphs.mainGlyphColor) glyphs.secondaryGlyphColor = glyphs.mainGlyphColor;
      installNotationFormatting();
      const prepareWrittenDirections = installWrittenDirections(fullScoreXml, sequence.division);
      installStaffLevelDynamics();
      installLowerVoiceRestPlacement();
      [
        window.alphaTab.NotationElement.ScoreTitle,
        window.alphaTab.NotationElement.ScoreSubTitle,
        window.alphaTab.NotationElement.ScoreArtist,
        window.alphaTab.NotationElement.ScoreAlbum,
        window.alphaTab.NotationElement.ScoreMusic,
        window.alphaTab.NotationElement.ScoreWords,
        window.alphaTab.NotationElement.ScoreWordsAndMusic,
        window.alphaTab.NotationElement.ScoreCopyright,
      ].filter((value) => value !== undefined).forEach((element) => settings.notation.elements.set(element, false));
      settings.player.playerMode = window.alphaTab.PlayerMode.EnabledExternalMedia;
      settings.player.soundFont = null;
      settings.player.scrollElement = "html,body";
      settings.player.scrollMode = window.alphaTab.ScrollMode.Off;
      settings.player.enableCursor = true;
      settings.player.enableElementHighlighting = true;
      settings.player.enableAnimatedBeatCursor = true;
      settings.player.enableUserInteraction = false;

      api = new window.alphaTab.AlphaTabApi(elements.score, settings);
      api.customCursorHandler = createLeftEdgeCursorHandler(window.alphaTab, api);
      engine = new GuideEngine(sequence);
      engine.onPreparationChanged = syncPlaybackButton;
      buildTimelineSegments();
      engine.attach(api);
      engine.setMetronome(metronomeControl.value());
      // Singing survives a refresh. Where this origin already has permission
      // the browser hands the microphone straight back; where it does not, this
      // gives up without a word and the toggle stays off.
      if (wantsPitchCapture && !window.frameElement?.inert) void startPitchCapture({ quiet: true });

      api.scoreLoaded.on((score) => {
        applyWrittenChordNames(score);
        prepareWrittenDirections(score);
        scoreTracks = score.tracks;
        applyMeasureNumberSettings(api.settings, score);
        if (scoreTracks.length !== parts.length) {
          const detail = `Playback has ${parts.length} parts but notation has ${scoreTracks.length}`;
          console.error(detail);
          scoreTracks = [];
          showLoadError("Score and playback parts do not match.", detail);
        } else if (scoreView === "standard" && !notationRenderInFlight) {
          notationRenderInFlight = true;
          notationRenderQueued = false;
          notationRenderFailed = false;
          syncScoreLoadingVisibility();
          beginNotationRenderTimeout();
        }
      });
      api.renderFinished.on(() => {
        if (loadFailed) return;
        const renderIsCurrent = finishScheduledNotationRender();
        if (scoreView === "standard") {
          notationHasRendered = true;
          notationRenderFailed = false;
          setNotationLoadingMessage();
        }
        if (pendingNotationReload) {
          pendingNotationReload.renderReady = true;
          finishNotationReloadWhenReady();
        }
        syncScoreLoadingVisibility();
        if (!renderIsCurrent) return;
        requestAnimationFrame(() => {
          syncNotationOverflow();
          // AlphaTab rebuilds its cursor layers during reflow but does not
          // reliably repaint them when the musical position itself is
          // unchanged. Re-submit that position only after the final queued
          // render so measure and beat highlights use the new geometry.
          engine?.pushPosition();
          syncPillThumb();
          updateTransportHeight();
          scheduleSectionGuides();
          renderAnnotations();
          renderSelectedPartHighlight();
          renderStaffPitchTrace();
          scheduleCursorTrimBurst();
          scheduleFullMeasureRestCentering();
        });
      });
      api.playerReady.on(() => {
        if (loadFailed) return;
        updatePracticeDivisi();
        engine.attach(api);
        ready = true;
        elements.playPause.disabled = false;
        elements.seek.disabled = false;
        elements.seek.max = String(Math.max(1, Math.round(engine.duration * 1000)));
        elements.totalTime.textContent = formatTime(engine.duration * 1000);
        api.playbackSpeed = tempoControl.value() / 100;
        engine.updateMix(audibleTracks, trackVolumes, trackPans);
        if (pendingNotationReload) {
          pendingNotationReload.playerReady = true;
          finishNotationReloadWhenReady();
        } else engine.pushPosition();
        initializeMediaSession();
        updatePitchCaptureAppearance();
        if (scoreView === "bars") scheduleBarRender();
      });
      api.playerStateChanged.on((event) => {
        playing = event.state === window.alphaTab.synth.PlayerState.Playing;
        if (!playing) cancelVerticalFollowAnimation(true);
        syncPlaybackButton();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
        if (playing) startPitchSampling();
        else stopPitchSampling();
      });
      api.playerPositionChanged.on(() => {
        const milliseconds = engine.currentSeconds() * 1000;
        if (!seeking) {
          elements.seek.value = String(Math.round(milliseconds));
          elements.currentTime.textContent = formatTime(milliseconds);
          updateSeekAppearance(milliseconds);
        }
        scheduleCursorTrim();
        renderSelectedPartHighlight();
        updateBarPlayhead(engine.tickAtSeconds(engine.currentSeconds()));
        gentleFollowCursor();
      });
      api.playerFinished.on(() => {
        playing = false;
        syncPlaybackButton();
        stopPitchSampling();
      });
      api.error.on((error) => {
        console.error(error);
        showLoadError("Score could not be loaded.", error?.message || "Score could not be loaded");
      });

      const scoreBytes = new TextEncoder().encode(scoreXmlForDisplayMode());
      const initialTracks = parts.map((_, index) => index).filter((index) => visibleTracks.has(index));
      if (!api.load(scoreBytes, initialTracks)) throw new Error("Embedded score format was rejected");
    } catch (error) {
      console.error(error);
      showLoadError("Embedded score data could not be read.", error?.message || "Embedded score data could not be read");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else void init();
})();
