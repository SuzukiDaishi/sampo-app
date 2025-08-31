// AudioWorkletProcessor for Sanpo App audio core (Phase 1)
// Implements: buffers, buses, tracks, schedulePlay/stop, setGain, setLPF(one-pole),
// seamless loop, equal-power pan, simple ramps, sample-accurate events within block.

const dBToLin = (db) => Math.pow(10, db / 20);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

class Ramp {
  constructor(value = 1.0) {
    this.value = value;
    this.target = value;
    this.remaining = 0; // samples
    this.delta = 0;
  }
  setTarget(target, rampSamples = 0) {
    this.target = target;
    if (rampSamples <= 0) {
      this.value = target;
      this.remaining = 0;
      this.delta = 0;
    } else {
      this.remaining = rampSamples | 0;
      this.delta = (this.target - this.value) / this.remaining;
    }
  }
  step() {
    if (this.remaining > 0) {
      this.value += this.delta;
      this.remaining--;
      if (this.remaining <= 0) this.value = this.target;
    }
    return this.value;
  }
}

class AudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 128;
    this.sr = sampleRate; // global in worklet scope
    this.currentSample = 0;
    // Mixer selection: default to JS mixer for stability
    this.useWasmMixer = false;
    // Queue for posting messages to main thread safely from RT context
    this._outbox = [];
    // Safe enqueue helper (guards against accidental overwrite)
    this._enqueue = (m) => {
      try {
        if (!this._outbox || !Array.isArray(this._outbox)) {
          this._outbox = []
        }
        this._outbox.push(m)
      } catch (_) {
        try { this.port && this.port.postMessage && this.port.postMessage(m) } catch (_) {}
      }
    }

    // Storage
    this.buffers = new Map(); // id -> { sampleRate, channels: Float32Array[] }
    this.buses = new Map();   // id -> { id, gain: Ramp, lpf: {enabled, cutoff, alpha, lastL, lastR}, ducker? }
    this.tracks = new Map();  // id -> track
    this.events = [];         // scheduled events within future time
    this.masterGain = new Ramp(dBToLin(-6)); // headroom -6dB

    this.pendingNotifies = [];

    this.port.onmessage = (e) => this._onMessage(e.data);

    // Wasm integration fields
    this.wasm = null;
    this.wasmReady = false;
    this.wasmLoading = null;

    // Safety: some environments may not expose a callable postMessage on MessagePort
    // Create a no-op shim if unavailable to avoid runtime TypeError during debug posts.
    try {
      if (!this.port || typeof this.port.postMessage !== 'function') {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        this.port.postMessage = function () {}
      }
    } catch (_) {
      // ignore
    }

    // Debug helper
    this._dbg = (label, extra) => {
      try {
        const info = {
          label,
          hasPort: !!this.port,
          typePort: typeof this.port,
          typePM: this.port ? typeof this.port.postMessage : 'noport',
          hasStart: this.port && typeof this.port.start === 'function'
        }
        if (extra && typeof extra === 'object') Object.assign(info, extra)
        // Try posting to main thread; also log to console for Worklet scope
        try { this.port.postMessage({ type: 'debug', msg: 'worklet-dbg', info }) } catch (_) {}
        try { console && console.log && console.log('[AUDIO][worklet][dbg]', info) } catch (_) {}
      } catch (_) {}
    }
    this._dbg('constructor')

    // Do not override prototype methods; use local send helpers in handlers
  }

  _post(msg) { try { this.port.postMessage(msg) } catch (_) {} }

  async _ensureWasm() {
    if (this.wasmReady && this.wasm) return true;
    if (!this.wasmLoading) {
      this.wasmLoading = (async () => {
        try {
          const mod = await import('/wasm/sampo_core.js');
          if (mod && typeof mod.default === 'function') {
            await mod.default();
          }
          this.wasm = mod;
          // Dump available exports for diagnosis
          try {
            const keys = Object.keys(mod || {});
            const types = {};
            for (const k of keys) types[k] = typeof mod[k];
            this._enqueue({ type: 'debug', msg: 'wasm-exports', keys, types });
          } catch (_) {}
          if (this.wasm && typeof this.wasm.audio_init === 'function') {
            this.wasm.audio_init(this.sr);
            this._enqueue({ type: 'debug', msg: 'wasm-audio_init-called', sr: this.sr });
          } else {
            this._enqueue({ type: 'debug', msg: 'wasm-audio_init-missing' });
          }
          this.wasmReady = true;
          this._enqueue({ type: 'debug', msg: 'wasm audio ready' });
        } catch (e) {
          this._enqueue({ type: 'debug', msg: 'wasm audio load failed', error: String(e) });
          this.wasm = null;
          this.wasmReady = false;
        }
      })();
    }
    await this.wasmLoading;
    return this.wasmReady;
  }

  _onMessage(msg) {
    this._dbg('onMessage', { type: msg && msg.type })
    switch (msg?.type) {
      case 'setEngineMode': {
        const mode = (msg && msg.mode) || 'js'
        this.useWasmMixer = mode === 'wasm'
        this._dbg('engineMode', { mode: this.useWasmMixer ? 'wasm' : 'js' })
        break;
      }
      case 'init': {
        this._dbg('init received', { sr: this.sr, blockSize: this.blockSize });
        // kick wasm load but don't block ready
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this._ensureWasm();
        try { this.port.postMessage({ type: 'ready', sampleRate: this.sr, blockSize: this.blockSize }) } catch (_) {}
        break;
      }
      case 'loadBuffer': {
        const { bufferId, sampleRate, channels } = msg;
        if (!bufferId || !channels || !Array.isArray(channels)) return;
        this.buffers.set(bufferId, { sampleRate, channels });
        const len = channels && channels[0] ? channels[0].length : 0
        this._dbg('bufferLoaded', { bufferId, sampleRate, channels: channels.length || 0, length: len });
        // Register to wasm if available
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            try {
              const arr = new (globalThis.Array)();
              for (const ch of channels) arr.push(ch);
              this.wasm.audio_register_asset(bufferId, sampleRate, arr);
            } catch (e) {
              this._dbg('audio_register_asset failed', { error: String(e) })
            }
          }
        })();
        break;
      }
      case 'createBus': {
        const { busId, options } = msg;
        if (!busId) break;
        const gainDb = options?.gainDb ?? -6;
        this.buses.set(busId, {
          id: busId,
          gain: new Ramp(dBToLin(gainDb)),
          lpf: { enabled: !!options?.lpf?.enabled, cutoff: options?.lpf?.cutoffHz ?? 0, alpha: 0, lastL: 0, lastR: 0 },
          ducker: undefined
        });
        if (options?.lpf?.enabled) this._updateLPF(busId, options.lpf.cutoffHz ?? 1000, options.lpf.q ?? 0.707);
        this._dbg('createBus', { busId, gainDb })
        break;
      }
      case 'createTrack': {
        const { trackId, busId, assetId, options } = msg;
        if (!trackId || !busId || !assetId) break;
        const buf = this.buffers.get(assetId);
        if (!buf) break;
        const pan = clamp(options?.pan ?? 0, -1, 1);
        const { l, r } = this._panGains(pan);
        const gainDb = options?.gainDb ?? 0;
        this.tracks.set(trackId, {
          id: trackId,
          busId,
          assetId,
          buf,
          playing: false,
          readPos: 0.0, // float sample index in source rate
          step: buf.sampleRate / this.sr, // resample ratio
          pan,
          panL: l,
          panR: r,
          gain: new Ramp(dBToLin(gainDb)),
          loop: null,
          notifyEnded: false,
          pendingSwitch: null,
          pendingSwitchAt: null,
          markers: []
        });
        this._dbg('createTrack', { trackId, busId, assetId, sr: buf.sampleRate, len: buf.channels[0]?.length || 0 })
        // wasm create
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            try { if (typeof this.wasm.audio_create_track_bus === 'function') { this.wasm.audio_create_track_bus(trackId, busId, assetId, pan, gainDb) } else { this.wasm.audio_create_track(trackId, assetId, pan, gainDb) } } catch (e) {}
          }
        })();
        break;
      }
      case 'schedulePlay': {
        const { trackId, whenSamples, offsetSamples, loop } = msg;
        if (!this.tracks.has(trackId)) break;
        const w = Number.isFinite(whenSamples) ? Math.max(0, whenSamples|0) : this.currentSample;
        this.events.push({ type: 'start', when: w, trackId, offsetSamples: (offsetSamples|0) >>> 0, loop: loop ?? null });
        this._dbg('queue schedulePlay', { when: w })
        this._dbg('schedulePlay', { trackId, when: w })
        // wasm schedule (immediate on wasm side)
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            const mode = loop?.mode || 'seamless';
            const start = (loop?.start ?? 0) >>> 0;
            const end = (loop?.end == null) ? -1 : (loop.end >>> 0);
            const xfadeMs = (loop?.crossfadeMs ?? 0) >>> 0;
            try { this.wasm.audio_schedule_play(trackId, (offsetSamples|0) >>> 0, mode, start, end, xfadeMs) } catch (e) {}
          }
        })();
        break;
      }
      case 'stop': {
        const { trackId, whenSamples } = msg;
        if (!this.tracks.has(trackId)) break;
        const w = Number.isFinite(whenSamples) ? Math.max(0, whenSamples|0) : this.currentSample;
        this.events.push({ type: 'stop', when: w, trackId });
        this._dbg('queue stop', { when: w })
        this._dbg('stop', { trackId, when: w })
        break;
      }
      case 'setGain': {
        const { scope, id, gainDb, rampMs } = msg;
        const target = dBToLin(gainDb ?? 0);
        const samples = Math.max(0, Math.floor((rampMs ?? 0) * this.sr / 1000));
        if (scope === 'master') {
          this.masterGain.setTarget(target, samples);
        } else if (scope === 'bus') {
          const b = id ? this.buses.get(id) : null;
          if (b) b.gain.setTarget(target, samples);
        } else if (scope === 'track') {
          const t = id ? this.tracks.get(id) : null;
          if (t) t.gain.setTarget(target, samples);
        }
        this._dbg('setGain', { scope, id, gainDb, rampMs })
        break;
      }
      case 'setLPF': {
        const { scope, id, cutoffHz, rampMs } = msg;
        if (scope === 'bus') this._updateLPF(id, cutoffHz ?? 0, 0.707);
        this._dbg('setLPF', { scope, id, cutoffHz })
        break;
      }
      case 'setDucker': {
        const { targetBusId, keyBusId, params } = msg;
        const b = this.buses.get(targetBusId);
        if (b) {
          const thDb = params?.thresholdDb ?? -24;
          const ratio = Math.max(1, params?.ratio ?? 6);
          const attackMs = Math.max(1, params?.attackMs ?? 10);
          const releaseMs = Math.max(1, params?.releaseMs ?? 200);
          const maxAttenDb = Math.max(0, params?.maxAttenDb ?? 12);
          const makeupDb = params?.makeupDb ?? 0;
          b.ducker = {
            enabled: true,
            key: keyBusId,
            thresholdDb: thDb,
            thresholdLin: Math.pow(10, thDb / 20),
            ratio,
            attack: 1 - Math.exp(-1 / (this.sr * attackMs / 1000)),
            release: 1 - Math.exp(-1 / (this.sr * releaseMs / 1000)),
            maxAttenDb,
            maxAttenLin: Math.pow(10, -maxAttenDb / 20),
            makeupLin: Math.pow(10, makeupDb / 20),
            env: 0,
            gain: 1
          };
          this._dbg('setDucker', { targetBusId, keyBusId, thresholdDb: thDb, ratio })
        }
        // wasm setDucker
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            try { this.wasm.audio_set_ducker(targetBusId, keyBusId, params?.thresholdDb ?? -24, params?.ratio ?? 6, params?.attackMs ?? 10, params?.releaseMs ?? 200, params?.maxAttenDb ?? 12, params?.makeupDb ?? 0) } catch (e) {}
          }
        })();
        break;
      }
      case 'setMarkers': {
        const { trackId, markersSamples } = msg;
        const t = this.tracks.get(trackId);
        if (t && Array.isArray(markersSamples)) {
          t.markers = markersSamples.filter(n => Number.isFinite(n) && n >= 0).map(n => n|0).sort((a,b)=>a-b);
        this._dbg('setMarkers', { trackId, count: t.markers.length })
        }
        // wasm setMarkers
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            try {
              const arr = new (globalThis.Array)();
              for (const m of (markersSamples||[])) arr.push(m);
              this.wasm.audio_set_markers(trackId, arr);
            } catch (e) {}
          }
        })();
        break;
      }
      case 'setLoop': {
        const { trackId, loop } = msg;
        const t = this.tracks.get(trackId);
        if (t) {
          if (loop) {
            const l = { mode: loop.mode, start: loop.start >>> 0, end: loop.end != null ? (loop.end >>> 0) : null };
            if (l.mode === 'xfade') {
              const ms = loop.crossfadeMs ?? 0;
              const x = Math.max(0, Math.floor((t.buf.sampleRate * ms) / 1000));
              l._xfadeSamples = x;
            }
            t.loop = l;
          } else {
            t.loop = null;
          }
        }
        // wasm setLoop
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            const mode = loop?.mode || 'none';
            const start = (loop?.start ?? 0) >>> 0;
            const end = (loop?.end == null) ? -1 : (loop.end >>> 0);
            const xfadeMs = (loop?.crossfadeMs ?? 0) >>> 0;
            try { this.wasm.audio_set_loop(trackId, mode, start, end, xfadeMs) } catch (e) {}
          }
        })();
        break;
      }
      case 'transition': {
        const { trackId, at, toAssetId, loop } = msg;
        const t = this.tracks.get(trackId);
        if (!t) break;
        if (at === 'loopEnd') {
          t.pendingSwitch = { assetId: toAssetId, loop: loop ?? null };
          this._dbg('transition@loopEnd', { trackId, toAssetId })
        } else if (at === 'now') {
          const nb = this.buffers.get(toAssetId);
          if (nb) {
            t.buf = nb;
            t.step = nb.sampleRate / this.sr;
            t.readPos = (loop?.start ?? 0) * (nb.sampleRate / this.sr);
            t.loop = loop ?? null;
            this._dbg('transition@now', { trackId, toAssetId })
          }
        } else if (at === 'nextMarker') {
          if (Array.isArray(t.markers) && t.markers.length) {
            const posIdx = Math.floor(t.readPos);
            const next = t.markers.find(m => m > posIdx);
            if (next != null) {
              t.pendingSwitchAt = next;
              t.pendingSwitch = { assetId: toAssetId, loop: loop ?? null };
              this._dbg('transition@nextMarker', { trackId, toAssetId, atSample: next })
            } else {
              // fallback to loopEnd
              t.pendingSwitch = { assetId: toAssetId, loop: loop ?? null };
              this._dbg('transition@nextMarker fallback loopEnd', { trackId, toAssetId })
            }
          }
        }
        // wasm transition
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async () => {
          if (await this._ensureWasm()) {
            const mode = loop?.mode || 'seamless';
            const start = (loop?.start ?? 0) >>> 0;
            const end = (loop?.end == null) ? -1 : (loop.end >>> 0);
            const xfadeMs = (loop?.crossfadeMs ?? 0) >>> 0;
            try { this.wasm.audio_transition(trackId, at || 'now', toAssetId, mode, start, end, xfadeMs) } catch (e) {}
          }
        })();
        break;
      }
      case 'query': {
        if (msg.what === 'time') {
          __dbg({ type: 'time', currentSample: this.currentSample });
        }
        break;
      }
      default:
        break;
    }
  }

  _panGains(pan) {
    // equal-power pan [-1..+1]
    const angle = (pan + 1) * 0.25 * Math.PI;
    return { l: Math.cos(angle), r: Math.sin(angle) };
  }

  _updateLPF(busId, cutoffHz, q) {
    const b = this.buses.get(busId);
    if (!b) return;
    const f = Math.max(0, cutoffHz);
    if (!Number.isFinite(f) || f <= 0) {
      b.lpf.enabled = false;
      b.lpf.cutoff = 0;
      b.lpf.alpha = 0;
      return;
    }
    b.lpf.enabled = true;
    b.lpf.cutoff = f;
    // One-pole LPF: alpha = 1 - exp(-2*pi*f/sr)
    b.lpf.alpha = 1 - Math.exp(-2 * Math.PI * f / this.sr);
  }

  _applyLPFBus(b, inL, inR) {
    if (!b.lpf.enabled) return { outL: inL, outR: inR };
    const n = inL.length;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    let yl = b.lpf.lastL, yr = b.lpf.lastR;
    const a = b.lpf.alpha;
    for (let i = 0; i < n; i++) {
      yl = yl + a * (inL[i] - yl);
      yr = yr + a * (inR[i] - yr);
      outL[i] = yl;
      outR[i] = yr;
    }
    b.lpf.lastL = yl;
    b.lpf.lastR = yr;
    return { outL, outR };
  }

  _processSegment(outputL, outputR, offset, length) {
    if (length <= 0) return;

    // Prepare per-bus accumulators
    const busIds = Array.from(this.buses.keys());
    const busAcc = new Map();
    for (const id of busIds) {
      busAcc.set(id, { L: new Float32Array(length), R: new Float32Array(length) });
    }

    // Mix tracks into their buses
    const endedNow = [];
    for (const t of this.tracks.values()) {
      if (!t.playing) continue;
      const bus = busAcc.get(t.busId);
      if (!bus) continue;
      let chs = t.buf.channels;
      let ch0 = chs[0];
      let ch1 = chs[1] || ch0; // mono → copy
      const lenSrc = ch0.length;

      let pos = t.readPos;
      const step = t.step;
      const panL = t.panL, panR = t.panR;

      for (let i = 0; i < length; i++) {
        // Read with linear interpolation
        let idx = Math.floor(pos);
        let frac = pos - idx;
        // transition at marker
        if (t.pendingSwitchAt != null && idx >= t.pendingSwitchAt) {
          const sw = t.pendingSwitch;
          if (sw) {
            const nb = this.buffers.get(sw.assetId);
            if (nb) {
              t.buf = nb;
              t.step = nb.sampleRate / this.sr;
              pos = (sw.loop?.start ?? 0) * 1.0;
              chs = t.buf.channels;
              ch0 = chs[0];
              ch1 = chs[1] || ch0;
              t.loop = sw.loop ?? null;
            }
          }
          t.pendingSwitch = null;
          t.pendingSwitchAt = null;
          idx = Math.floor(pos);
          frac = pos - idx;
        }
        if (t.loop && t.loop.mode === 'seamless') {
          const Lstart = t.loop.start >>> 0;
          const Lend = t.loop.end != null ? (t.loop.end >>> 0) : lenSrc;
          if (idx >= Lend) {
            // wrap
            if (t.pendingSwitch) {
              const sw = t.pendingSwitch;
              const nb = this.buffers.get(sw.assetId);
              if (nb) {
                t.buf = nb;
                t.step = nb.sampleRate / this.sr;
                // start at loop.start (or 0)
                pos = (sw.loop?.start ?? 0) * 1.0;
                chs = t.buf.channels;
                ch0 = chs[0];
                ch1 = chs[1] || ch0;
                // apply new loop definition
                t.loop = sw.loop ?? null;
              }
              t.pendingSwitch = null;
            } else {
              const over = pos - Lend;
              pos = Lstart + over;
            }
            idx = Math.floor(pos);
            frac = pos - idx;
          }
        } else if (t.loop && t.loop.mode === 'xfade' && typeof t.loop._xfadeSamples === 'number') {
          const Lstart = t.loop.start >>> 0;
          const Lend = t.loop.end != null ? (t.loop.end >>> 0) : lenSrc;
          const X = Math.max(0, t.loop._xfadeSamples|0);
          if (X > 0) {
            if (idx >= Lend) {
              const over = pos - Lend;
              pos = Lstart + over;
              idx = Math.floor(pos);
              frac = pos - idx;
            }
            const winStart = Lend - X;
            if (idx >= winStart && idx < Lend) {
              const tnorm = Math.min(1, Math.max(0, (pos - winStart) / X));
              const gB = Math.sin(0.5 * Math.PI * tnorm);
              const gA = Math.cos(0.5 * Math.PI * tnorm);
              const eidx = Math.min(Lend - 2, Math.max(Lstart, idx));
              const efrac = frac;
              const eL0 = ch0[eidx], eL1 = ch0[eidx + 1];
              const eR0 = ch1[eidx], eR1 = ch1[eidx + 1];
              const eL = eL0 + (eL1 - eL0) * efrac;
              const eR = eR0 + (eR1 - eR0) * efrac;
              const sPos = Lstart + (pos - winStart);
              const sIdx = Math.floor(sPos);
              const sFrac = sPos - sIdx;
              const sL0 = ch0[sIdx] ?? ch0[Lstart];
              const sL1 = ch0[sIdx + 1] ?? ch0[Lstart];
              const sR0 = ch1[sIdx] ?? ch1[Lstart];
              const sR1 = ch1[sIdx + 1] ?? ch1[Lstart];
              const sL = sL0 + (sL1 - sL0) * sFrac;
              const sR = sR0 + (sR1 - sR0) * sFrac;
              const g = t.gain.step();
              bus.L[i] += (eL * gA + sL * gB) * g * panL;
              bus.R[i] += (eR * gA + sR * gB) * g * panR;
              pos += step;
              continue;
            }
          }
        }

        if (idx >= lenSrc - 1) {
          // Near end: stop only if not looping. For loops, wrap sample read.
          if (!t.loop || t.loop.mode === 'none') {
            t.playing = false;
            endedNow.push(t.id);
            break;
          }
        }
        const s0L = ch0[idx];
        let idx1 = idx + 1;
        if (idx1 >= lenSrc) {
          // Wrap next sample to loop start for seamless; otherwise clamp
          if (t.loop && t.loop.mode === 'seamless') {
            const Lstart = t.loop.start >>> 0;
            idx1 = Lstart;
          } else {
            idx1 = lenSrc - 1;
          }
        }
        const s1L = ch0[idx1];
        const s0R = ch1[idx];
        const s1R = ch1[idx1];
        const sampleL = s0L + (s1L - s0L) * frac;
        const sampleR = s0R + (s1R - s0R) * frac;

        const g = t.gain.step();
        bus.L[i] += sampleL * panL * g;
        bus.R[i] += sampleR * panR * g;

        pos += step;
      }
      t.readPos = pos;
    }

    // Apply bus ducking + gain + LPF, then mix to master
    for (const id of busIds) {
      const b = this.buses.get(id);
      const acc = busAcc.get(id);
      if (!b || !acc) continue;
      const n = length;
      // Sidechain ducking
      if (b.ducker && b.ducker.enabled && b.ducker.key && busAcc.has(b.ducker.key)) {
        const key = busAcc.get(b.ducker.key);
        let env = b.ducker.env || 0;
        let gr = b.ducker.gain || 1;
        const atk = b.ducker.attack;
        const rel = b.ducker.release;
        const thr = b.ducker.thresholdLin;
        for (let i = 0; i < n; i++) {
          const kL = key.L[i], kR = key.R[i];
          const mag = Math.hypot(kL, kR) * 0.7071; // RMS-ish proxy
          const delta = mag - env;
          env += (delta > 0 ? atk : rel) * delta;
          let gtar = 1;
          if (env > thr) {
            const envDb = 20 * Math.log10(env + 1e-12);
            const exceed = envDb - b.ducker.thresholdDb;
            const attenDb = Math.max(0, exceed * (1 - 1 / b.ducker.ratio));
            const gdb = -Math.min(b.ducker.maxAttenDb, attenDb);
            gtar = Math.pow(10, gdb / 20);
          }
          const dgr = gtar - gr;
          gr += (dgr > 0 ? rel : atk) * dgr;
          acc.L[i] *= gr * b.ducker.makeupLin;
          acc.R[i] *= gr * b.ducker.makeupLin;
        }
        b.ducker.env = env;
        b.ducker.gain = gr;
      }
      const glinStart = b.gain.value;
      // If ramping, we step per-sample; otherwise constant multiplier
      if (b.gain.remaining > 0) {
        for (let i = 0; i < n; i++) {
          const g = b.gain.step();
          acc.L[i] *= g;
          acc.R[i] *= g;
        }
      } else if (glinStart !== 1) {
        for (let i = 0; i < n; i++) {
          acc.L[i] *= glinStart;
          acc.R[i] *= glinStart;
        }
      }

      const filt = this._applyLPFBus(b, acc.L, acc.R);
      // Mix to master with master gain
      for (let i = 0; i < n; i++) {
        const mg = this.masterGain.step();
        outputL[offset + i] += filt.outL[i] * mg;
        outputR[offset + i] += filt.outR[i] * mg;
      }
    }

    // Defer notifications to end of process()
    for (const tid of endedNow) {
      this.pendingNotifies.push({ type: 'trackEnded', trackId: tid, atSamples: this.currentSample + offset });
    }
  }

  _applyEventsInBlock(blockStart, blockEnd) {
    // Extract events in window and sort
    const evts = this.events.filter(e => e.when >= blockStart && e.when < blockEnd);
    // Remove them from queue
    this.events = this.events.filter(e => !(e.when >= blockStart && e.when < blockEnd));
    evts.sort((a, b) => a.when - b.when);
    return evts;
  }

  _applyEvent(evt) {
    if (evt.type === 'start') {
      const t = this.tracks.get(evt.trackId);
      if (!t) return;
      t.playing = true;
      const off = evt.offsetSamples >>> 0;
      t.readPos = off * (t.buf.sampleRate / this.sr);
      if (evt.loop) {
        const l = { mode: evt.loop.mode, start: evt.loop.start >>> 0, end: evt.loop.end != null ? (evt.loop.end >>> 0) : null };
        if (l.mode === 'xfade') {
          const ms = evt.loop.crossfadeMs ?? 0;
          const x = Math.max(0, Math.floor((t.buf.sampleRate * ms) / 1000));
          l._xfadeSamples = x;
        }
        t.loop = l;
      } else {
        t.loop = null;
      }
      this.pendingNotifies.push({ type: 'trackStarted', trackId: t.id, atSamples: evt.when });
      this._enqueue({ type: 'debug', msg: 'trackStarted', trackId: t.id, at: evt.when })
    } else if (evt.type === 'stop') {
      const t = this.tracks.get(evt.trackId);
      if (!t) return;
      t.playing = false;
      this.pendingNotifies.push({ type: 'trackEnded', trackId: t.id, atSamples: evt.when });
      this._enqueue({ type: 'debug', msg: 'trackStopped', trackId: t.id, at: evt.when })
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length || this.blockSize;
    const outL = output[0];
    const outR = output[1] || output[0];
    // Clear
    outL.fill(0);
    if (outR !== outL) outR.fill(0);

    // Flush queued messages (safe context)
    if (!this._outbox || !Array.isArray(this._outbox)) this._outbox = []
    if (this._outbox.length) {
      const q = this._outbox.splice(0);
      for (const m of q) { try { this.port.postMessage(m) } catch (_) {} }
    }

    // Prefer wasm mixer only when explicitly enabled for stability
    if (this.useWasmMixer && this.wasmReady && this.wasm && typeof this.wasm.audio_process_into === 'function') {
      try { this.wasm.audio_process_into(outL, outR) } catch {}
      this.currentSample += frames;
      // No pending notifications from wasm yet
      this.pendingNotifies.length = 0;
      return true;
    }

    const blockStart = this.currentSample;
    const blockEnd = blockStart + frames;
    const evts = this._applyEventsInBlock(blockStart, blockEnd);

    // Segment rendering: start → evt1 → evt2 → ... → end
    let segStart = blockStart;
    let outOffset = 0;
    for (const evt of evts) {
      const len = Math.max(0, Math.min(frames - outOffset, evt.when - segStart));
      if (len > 0) this._processSegment(outL, outR, outOffset, len);
      // Apply event at boundary
      this._applyEvent(evt);
      segStart = evt.when;
      outOffset += len;
    }
    // Tail
    const remain = frames - outOffset;
    if (remain > 0) this._processSegment(outL, outR, outOffset, remain);

    this.currentSample += frames;

    // Flush notifications
    for (const n of this.pendingNotifies) this._outbox.push(n);
    this.pendingNotifies.length = 0;

    return true; // keep alive
  }
}

registerProcessor('audio-engine', AudioEngineProcessor);
