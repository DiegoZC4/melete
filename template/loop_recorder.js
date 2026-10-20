/* Microphone-only loop takes. No storage, network, or score-playback connection. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MeleteRecording = api;
})(globalThis, () => {
  "use strict";

  const MAX_LOOP_SECONDS = 300;
  class TakeBuffer {
    constructor(sampleRate, seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_LOOP_SECONDS
        || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid recording length");
      this.sampleRate = sampleRate;
      this.passFrames = Math.ceil(sampleRate * seconds);
      this.takes = [];
      this.current = null;
      this.nextId = 1;
      this.lastChunk = null;
    }

    begin(frame) {
      this.finish(frame, true);
      // The active pass occupies one of the three slots, never a fourth buffer.
      if (this.takes.length === 3) this.takes.shift();
      const take = {id: this.nextId++, start: Math.round(frame), end: null,
        pcm: new Int16Array(this.passFrames), written: 0, gap: false, firstGap: null, completed: false, peak: 0};
      this.takes.push(take);
      this.current = take;
      // Audio can arrive just before a main-thread transport notification.
      if (this.lastChunk) this.write(take, this.lastChunk.frame, this.lastChunk.samples);
      return take;
    }

    finish(frame, completed = false) {
      if (!this.current) return;
      this.current.end = Math.max(this.current.start,
        Math.min(Math.round(frame), this.current.start + this.passFrames));
      this.current.completed = completed;
      this.current = null;
    }

    write(take, frame, samples) {
      const from = Math.max(frame, take.start + take.written);
      const to = Math.min(frame + samples.length, take.end ?? take.start + this.passFrames);
      if (to <= from) return;
      if (from > take.start + take.written) {
        take.gap = true;
        take.firstGap ||= {offset: take.written, frames: from - take.start - take.written};
      }
      for (let cursor = from; cursor < to; cursor += 1) {
        const value = Math.max(-1, Math.min(1, Number(samples[cursor - frame]) || 0));
        take.peak = Math.max(take.peak, Math.abs(value));
        take.pcm[cursor - take.start] = Math.round(value * (value < 0 ? 32768 : 32767));
      }
      take.written = to - take.start;
    }

    append(frame, samples) {
      if (!samples.length) return;
      this.takes.forEach(take => this.write(take, frame, samples));
      this.lastChunk = {frame, samples};
    }

    info(take) {
      const length = Math.min(take.written, take.end === null ? this.passFrames : take.end - take.start);
      const complete = take.completed && !take.gap && take.end !== null
        && take.written >= take.end - take.start;
      return {id: take.id, length, seconds: length / this.sampleRate,
        active: take === this.current, complete, gap: take.gap, firstGap: take.firstGap, peak: take.peak};
    }

    samples(take) { return take.pcm.subarray(0, this.info(take).length); }
  }

  function wavBytes(samples, sampleRate) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
    text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
    return bytes;
  }

  // The audio thread supplies frame timestamps; timer jitter does not stretch
  // or concatenate the recorded signal. Output is always silent, not mic monitor.
  const WORKLET_SOURCE = `
    class MeleteMicCapture extends AudioWorkletProcessor {
      constructor() {
        super();
        this.samples = new Float32Array(2048);
        this.used = 0;
        this.start = 0;
        this.hasInput = false;
        this.stopped = false;
        this.port.onmessage = event => {
          if (event.data === 'stop') {
            this.flush();
            this.stopped = true;
            this.port.postMessage({stopped: true});
          }
        };
      }
      flush() {
        if (!this.used) return;
        const samples = this.samples.slice(0, this.used);
        this.port.postMessage({frame: this.start, samples, hasInput: this.hasInput}, [samples.buffer]);
        this.used = 0;
        this.hasInput = false;
      }
      process(inputs, outputs) {
        if (this.stopped) return false;
        const channels = inputs[0];
        const length = outputs[0][0].length;
        if (this.used && currentFrame !== this.start + this.used) this.flush();
        for (let i = 0; i < length; i++) {
          if (!this.used) this.start = currentFrame + i;
          let value = 0;
          if (channels?.length) {
            this.hasInput = true;
            for (const channel of channels) value += channel[i] || 0;
            value /= channels.length;
          }
          this.samples[this.used++] = value;
          if (this.used === this.samples.length) this.flush();
        }
        return true;
      }
    }
    registerProcessor('melete-mic-capture', MeleteMicCapture);
  `;
  const installed = new WeakMap();
  class PcmCapture {
    static async create(context, source, onSamples, onError) {
      if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
        throw new Error("Loop recording needs a browser with AudioWorklet support");
      }
      if (!installed.has(context)) {
        // A data module also works in standalone file:// pages, where Chrome
        // rejects a blob:null module as cross-origin. This source has no imports.
        const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(WORKLET_SOURCE)}`;
        installed.set(context, context.audioWorklet.addModule(url));
      }
      try { await installed.get(context); }
      catch (error) { installed.delete(context); throw error; }
      const capture = new PcmCapture();
      capture.context = context;
      capture.source = source;
      capture.node = new AudioWorkletNode(context, "melete-mic-capture", {outputChannelCount: [1]});
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const timeout = setTimeout(() => rejectReady(new Error("No microphone samples arrived")), 3000);
      capture.node.port.onmessage = ({data}) => {
        if (data.samples) {
          onSamples(data.frame, data.samples);
          if (data.hasInput) resolveReady();
        }
        if (data.stopped) capture.resolveStop?.();
      };
      capture.node.onprocessorerror = () => {
        const error = new Error("Microphone recording was interrupted");
        rejectReady(error);
        onError(error);
      };
      capture.node.connect(context.destination);
      source.connect(capture.node);
      // Permission can resolve before a cold input starts delivering blocks.
      // Wait for actual frames (silence is valid) before starting the score.
      try { await ready; return capture; }
      catch (error) { await capture.stop(); throw error; }
      finally { clearTimeout(timeout); }
    }

    stop() {
      if (this.stopping) return this.stopping;
      this.stopping = new Promise(resolve => {
        const finish = () => {
          clearTimeout(timeout);
          try { this.source.disconnect(this.node); } catch {}
          this.node.disconnect();
          this.node.port.close();
          resolve();
        };
        const timeout = setTimeout(finish, 500);
        this.resolveStop = finish;
        this.node.port.postMessage("stop");
      });
      return this.stopping;
    }
  }

  return {TakeBuffer, wavBytes, PcmCapture, MAX_LOOP_SECONDS, WORKLET_SOURCE};
});
