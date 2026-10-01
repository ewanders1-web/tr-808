/**
 * TR-808 drum synthesis via Web Audio API
 * Pure synthesis modelled on the 808's analog voice circuits (bridged-T
 * resonators, six-oscillator metal bank, multi-trigger clap) — no samples.
 */
(function (global) {
  'use strict';

  const INSTRUMENTS = [
    { id: 'BD', name: 'Bass Drum', color: '#c44' },
    { id: 'SD', name: 'Snare', color: '#d65' },
    { id: 'LT', name: 'Low Tom', color: '#e83' },
    { id: 'MT', name: 'Mid Tom', color: '#e83' },
    { id: 'HT', name: 'Hi Tom', color: '#e83' },
    { id: 'RS', name: 'Rimshot', color: '#a6a' },
    { id: 'CP', name: 'Clap', color: '#a6a' },
    { id: 'CH', name: 'Closed Hat', color: '#6ad' },
    { id: 'OH', name: 'Open Hat', color: '#6ad' },
    { id: 'CY', name: 'Cymbal', color: '#6ad' },
    { id: 'CB', name: 'Cowbell', color: '#da4' },
    { id: 'MA', name: 'Maracas', color: '#8b6' },
    { id: 'CL', name: 'Claves', color: '#8b6' },
  ];

  class DrumMachine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.comp = null;
      this.unlocked = false;
      this._volume = 1.0;
      this._noiseBuffer = null;
      this._openHats = [];
    }

    async resume() {
      if (!this.ctx) this._init();
      // Same-gesture kick: silent buffer + tiny tick (critical on iOS Safari)
      this._gestureUnlock();
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch (e) {
          console.warn('AudioContext.resume failed', e);
        }
      }
      // Second kick after resume for stubborn iOS sessions
      this._gestureUnlock();
      this.unlocked = this.ctx.state === 'running';
      return this.unlocked;
    }

    _gestureUnlock() {
      if (!this.ctx) return;
      try {
        const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
      } catch (_) {}
      try {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        g.gain.value = 0.0001;
        osc.connect(g);
        g.connect(this.ctx.destination);
        const t = this.ctx.currentTime;
        osc.start(t);
        osc.stop(t + 0.01);
      } catch (_) {}
    }

    _init() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._attach(new AC({ latencyHint: 'interactive' }));
    }

    /**
     * Build the output chain on a given context. Split from _init so the
     * engine can also be rendered offline (OfflineAudioContext) for testing.
     *
     * voices -> bus -> comp (gentle safety limiter only) -> master -> out
     */
    _attach(ctx) {
      this.ctx = ctx;
      // Voices sum into the bus. The bus is scaled by 0.5 so the soft-clip
      // curve below sees +/-2.0 of headroom across its +/-1 input range.
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.5 * 0.75;
      // "comp" is now a static soft limiter instead of a DynamicsCompressor:
      // the old -24 dB / 2:1 compressor (with auto make-up gain) flattened
      // every transient. This is perfectly linear below ~0.6 and eases
      // peaks toward a 0.98 ceiling, so the output can never clip.
      this.comp = ctx.createWaveShaper();
      this.comp.curve = this._makeLimiterCurve(0.6, 0.98);
      this.comp.oversample = '2x';
      this.master = ctx.createGain();
      this.master.gain.value = this._volume;
      this.bus.connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(ctx.destination);

      // Cached buffers (built once): white/pink noise, the six-oscillator
      // metal bank, a trigger-pulse "click", and a soft-clip curve.
      this._noiseBuffer = this._makeNoise(3);
      this._pinkBuffer = this._makePink(3);
      this._metalBuffer = this._makeMetal(4);
      this._clickBuffer = this._makeClick();
      this._softCurve = this._makeSoftCurve(1.6);
      this._openHats = [];
    }

    get volume() {
      return this._volume;
    }

    set volume(v) {
      this._volume = Math.max(0, Math.min(1, v));
      if (this.master) {
        this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
      }
    }

    get currentTime() {
      return this.ctx ? this.ctx.currentTime : 0;
    }

    // —— Cached sources ————————————————————————————————————————————

    _makeNoise(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }

    // Pink-ish noise (Paul Kellet's economy filter) — the 808 toms/congas
    // mix in a little filtered noise for the "skin" sound.
    _makePink(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
      return buf;
    }

    // The 808 metal bank: six free-running Schmitt-trigger square
    // oscillators (HD14584, ~48% duty) summed in a passive mixer. Rendered
    // once with PolyBLEP anti-aliasing; voices start at a random offset,
    // which mimics the free-running (random phase) oscillators.
    _makeMetal(seconds) {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * seconds);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
      const duty = 0.48;
      const blep = (t, dt) => {
        if (t < dt) { t /= dt; return t + t - t * t - 1; }
        if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
        return 0;
      };
      for (const f of freqs) {
        const dt = f / sr;
        let ph = Math.random();
        for (let i = 0; i < len; i++) {
          let v = ph < duty ? 1 : -1;
          v += blep(ph, dt);
          let p2 = ph - duty;
          if (p2 < 0) p2 += 1;
          v -= blep(p2, dt);
          d[i] += v / 6;
          ph += dt;
          if (ph >= 1) ph -= 1;
        }
      }
      return buf;
    }

    // Trigger-pulse feed-through: ~1 ms rounded pulse. Lowpass it to taste.
    _makeClick() {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * 0.004);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = t < 0.001 ? Math.sin((Math.PI * t) / 0.001) : 0;
      }
      return buf;
    }

    // Curve input x in [-1, 1] represents signal 2x (bus is pre-scaled by 0.5).
    _makeLimiterCurve(knee, ceil) {
      const n = 4096;
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = ((i / (n - 1)) * 2 - 1) * 2;
        const a = Math.abs(v);
        const y = a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
        c[i] = Math.sign(v) * y;
      }
      return c;
    }

    _makeSoftCurve(drive) {
      const n = 1024;
      const c = new Float32Array(n);
      const norm = Math.tanh(drive);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.tanh(drive * x) / norm;
      }
      return c;
    }

    _src(buffer, when, duration, maxOffset) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const room = Math.max(0, buffer.duration - duration - 0.1);
      const off = Math.random() * Math.min(room, maxOffset == null ? room : maxOffset);
      src.start(when, off);
      src.stop(when + duration);
      return src;
    }

    _noise(when, duration) {
      return this._src(this._noiseBuffer, when, duration);
    }

    _osc(type, freq, when, stopAt) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, when);
      o.start(when);
      o.stop(stopAt);
      return o;
    }

    _filter(type, freq, q) {
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q != null) f.Q.value = q;
      return f;
    }

    // Exponential-decay envelope (RC discharge, like the 808's VCAs).
    // attack: linear rise time; tau: decay time constant.
    _decayEnv(param, when, peak, attack, tau) {
      param.cancelScheduledValues(when);
      param.setValueAtTime(0, when);
      param.linearRampToValueAtTime(peak, when + attack);
      param.setTargetAtTime(0, when + attack, tau);
    }

    _gain(v) {
      const g = this.ctx.createGain();
      g.gain.value = v == null ? 0 : v;
      return g;
    }

    _t(when) {
      return when == null ? this.ctx.currentTime : when;
    }

    _out(node) {
      node.connect(this.bus);
    }

    // —— Bass Drum ————————————————————————————————————————————————
    // Bridged-T resonator (~56 Hz) kicked by the trigger pulse. The pulse
    // momentarily raises the resonant frequency, giving a short downward
    // pitch "bend"; its feed-through is the click. The output is a nearly
    // pure decaying sine with a long tail, then the tone (lowpass) stage.
    playBD(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const dur = 1.6;
      const body = this._osc('sine', 56, t, t + dur);
      body.frequency.setValueAtTime(92, t);
      body.frequency.setTargetAtTime(56, t, 0.012);
      const bodyG = this._gain();
      // fast attack, long RC decay (~1.3 s to -60 dB)
      this._decayEnv(bodyG.gain, t, 0.95 * vel, 0.0015, 0.19);

      const sat = this.ctx.createWaveShaper();
      sat.curve = this._softCurve;
      const post = this._gain(0.62);

      const click = this.ctx.createBufferSource();
      click.buffer = this._clickBuffer;
      const clickLP = this._filter('lowpass', 2600, 0.7);
      const clickG = this._gain(0.45 * vel);
      click.start(t);

      body.connect(bodyG);
      bodyG.connect(sat);
      click.connect(clickLP);
      clickLP.connect(clickG);
      clickG.connect(sat);
      sat.connect(post);
      this._out(post);
    }

    // —— Snare ————————————————————————————————————————————————————
    // Two bridged-T resonators (~180 Hz and ~330 Hz) plus white noise
    // shaped by the tone (lowpass) and highpass, with its own "snappy" VCA.
    playSD(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const out = this._gain(1);

      const r1 = this._osc('sine', 180, t, t + 0.5);
      r1.frequency.setValueAtTime(196, t);
      r1.frequency.setTargetAtTime(180, t, 0.006);
      const g1 = this._gain();
      this._decayEnv(g1.gain, t, 0.4 * vel, 0.001, 0.055);
      const r2 = this._osc('sine', 330, t, t + 0.3);
      r2.frequency.setValueAtTime(355, t);
      r2.frequency.setTargetAtTime(330, t, 0.005);
      const g2 = this._gain();
      this._decayEnv(g2.gain, t, 0.3 * vel, 0.001, 0.032);
      r1.connect(g1);
      r2.connect(g2);
      g1.connect(out);
      g2.connect(out);

      const noise = this._noise(t, 0.45);
      const nLP = this._filter('lowpass', 9000, 0.5);
      const nHP = this._filter('highpass', 1300, 0.6);
      const nG = this._gain();
      this._decayEnv(nG.gain, t, 0.36 * vel, 0.0015, 0.07);
      noise.connect(nLP);
      nLP.connect(nHP);
      nHP.connect(nG);
      nG.connect(out);
      this._out(out);
    }

    // —— Toms ————————————————————————————————————————————————————
    // Bridged-T with a slight pitch glide from the trigger pulse, plus a
    // dash of pink noise through a lowpass (as in the 808 tom circuit).
    _playTom(when, freq, tau, vel, noiseAmt) {
      if (!this.ctx) return;
      const t = this._t(when);
      const dur = tau * 7 + 0.02;
      const o = this._osc('sine', freq, t, t + dur);
      o.frequency.setValueAtTime(freq * 1.28, t);
      o.frequency.setTargetAtTime(freq, t, 0.03);
      const g = this._gain();
      this._decayEnv(g.gain, t, 0.72 * vel, 0.0015, tau);
      const post = this._gain(1);
      o.connect(g);
      g.connect(post);

      if (noiseAmt > 0) {
        const n = this._src(this._pinkBuffer, t, dur * 0.6);
        const lp = this._filter('lowpass', freq * 6, 0.7);
        const ng = this._gain();
        this._decayEnv(ng.gain, t, noiseAmt * vel, 0.001, tau * 0.45);
        n.connect(lp);
        lp.connect(ng);
        ng.connect(post);
      }
      this._out(post);
    }

    playLT(when, vel = 1) {
      this._playTom(when, 90, 0.11, vel, 0.32);
    }
    playMT(when, vel = 1) {
      this._playTom(when, 135, 0.085, vel, 0.28);
    }
    playHT(when, vel = 1) {
      this._playTom(when, 190, 0.07, vel, 0.25);
    }

    // —— Rimshot ——————————————————————————————————————————————————
    // Two bridged-T resonators (~455 Hz and ~1667 Hz) with very fast decay
    // through a "swing" VCA (asymmetric clipping) and a highpass.
    playRS(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const sum = this._gain(1);
      const a = this._osc('triangle', 455, t, t + 0.08);
      const b = this._osc('sine', 1667, t, t + 0.08);
      const ga = this._gain();
      const gb = this._gain();
      this._decayEnv(ga.gain, t, 0.9 * vel, 0.0005, 0.011);
      this._decayEnv(gb.gain, t, 0.55 * vel, 0.0005, 0.008);
      a.connect(ga);
      b.connect(gb);
      ga.connect(sum);
      gb.connect(sum);
      const sw = this.ctx.createWaveShaper();
      const n = 256;
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = x > 0 ? Math.tanh(2.2 * x) : 0.35 * Math.tanh(1.5 * x);
      }
      sw.curve = c;
      const hp = this._filter('highpass', 380, 0.7);
      const out = this._gain(0.62);
      sum.connect(sw);
      sw.connect(hp);
      hp.connect(out);
      this._out(out);
    }

    // —— Hand Clap ————————————————————————————————————————————————
    // White noise -> ~1 kHz bandpass, then two VCAs: a sawtooth envelope
    // that re-fires 3x ~10 ms apart (the "multiple hands"), and a longer
    // "reverb" envelope. Summed and highpassed.
    playCP(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const noise = this._noise(t, 0.6);
      const bp = this._filter('bandpass', 1050, 1.6);
      noise.connect(bp);

      const saw = this._gain();
      const sp = saw.gain;
      sp.setValueAtTime(0, t);
      const offs = [0, 0.0105, 0.021];
      offs.forEach((o) => {
        sp.setValueAtTime(1.15 * vel, t + o);
        sp.setTargetAtTime(0.0001, t + o, 0.0032);
      });
      sp.setValueAtTime(1.15 * vel, t + 0.0315);
      sp.setTargetAtTime(0, t + 0.0315, 0.006);

      const verb = this._gain();
      verb.gain.setValueAtTime(0, t);
      verb.gain.setValueAtTime(0, t + 0.028);
      verb.gain.linearRampToValueAtTime(0.62 * vel, t + 0.034);
      verb.gain.setTargetAtTime(0, t + 0.034, 0.075);

      const hp = this._filter('highpass', 500, 0.7);
      bp.connect(saw);
      bp.connect(verb);
      saw.connect(hp);
      verb.connect(hp);
      const out = this._gain(1.5);
      hp.connect(out);
      this._out(out);
    }

    // —— Metal voices (CH / OH / CY / CB) ——————————————————————————————

    _metal(when, duration) {
      return this._src(this._metalBuffer, when, duration);
    }

    // Choke any open hat still ringing at time t (808: CH cuts OH).
    _chokeOH(t) {
      this._openHats = this._openHats.filter((h) => h.end > t);
      this._openHats.forEach((h) => {
        if (h.start < t) {
          h.choke.gain.setValueAtTime(1, t);
          h.choke.gain.setTargetAtTime(0, t, 0.006);
          h.end = t;
        }
      });
    }

    // Hats: metal bank -> bandpass (~7.1 kHz) -> VCA -> highpass.
    _hat(t, vel, tau, peak, dur) {
      const m = this._metal(t, dur);
      const bp = this._filter('bandpass', 7100, 1.1);
      const bp2 = this._filter('bandpass', 10500, 0.9);
      const vca = this._gain();
      this._decayEnv(vca.gain, t, peak * vel, 0.0008, tau);
      const hp = this._filter('highpass', 6200, 0.7);
      m.connect(bp);
      bp.connect(vca);
      m.connect(bp2);
      bp2.connect(vca);
      vca.connect(hp);
      return hp;
    }

    playCH(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      this._chokeOH(t);
      const out = this._hat(t, vel, 0.013, 1.9, 0.12);
      this._out(out);
    }

    playOH(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      this._chokeOH(t); // a new OH also retriggers/cuts the previous one
      const dur = 0.9;
      const out = this._hat(t, vel, 0.11, 1.55, dur);
      const choke = this._gain(1);
      out.connect(choke);
      this._out(choke);
      this._openHats.push({ start: t, end: t + dur, choke });
    }

    // Cymbal: metal bank split into a low band (~3.44 kHz, shorter envelope)
    // and a high band (~7.1 kHz, long envelope), each highpassed, then mixed.
    playCY(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const dur = 2.0;
      const m = this._metal(t, dur);

      const lowBP = this._filter('bandpass', 3440, 2.2);
      const lowV = this._gain();
      this._decayEnv(lowV.gain, t, 1.0 * vel, 0.002, 0.07);
      const lowHP = this._filter('highpass', 2200, 0.7);

      const hiBP = this._filter('bandpass', 7100, 1.4);
      const hiV = this._gain();
      this._decayEnv(hiV.gain, t, 1.3 * vel, 0.003, 0.32);
      const hiHP = this._filter('highpass', 5200, 0.7);

      m.connect(lowBP);
      lowBP.connect(lowV);
      lowV.connect(lowHP);
      m.connect(hiBP);
      hiBP.connect(hiV);
      hiV.connect(hiHP);
      const out = this._gain(1);
      lowHP.connect(out);
      hiHP.connect(out);
      this._out(out);
    }

    // Cowbell: oscillators #5/#6 (540 + 800 Hz squares) through a two-stage
    // envelope (fast "clunk" then long tail) into a ~880 Hz bandpass.
    playCB(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const dur = 0.75;
      const o1 = this._osc('square', 540, t, t + dur);
      const o2 = this._osc('square', 800, t, t + dur);
      const mix = this._gain(0.5);
      o1.connect(mix);
      o2.connect(mix);
      const env = this._gain();
      const p = env.gain;
      const pk = 0.95 * vel;
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(pk, t + 0.0015);
      p.setTargetAtTime(pk * 0.32, t + 0.0015, 0.012); // initial snap
      p.setTargetAtTime(0, t + 0.03, 0.13); // long tail
      const bp = this._filter('bandpass', 880, 2.4);
      const hp = this._filter('highpass', 420, 0.7);
      const out = this._gain(1.15);
      mix.connect(env);
      env.connect(bp);
      bp.connect(hp);
      hp.connect(out);
      this._out(out);
    }

    // —— Maracas ——————————————————————————————————————————————————
    // Highpassed white noise with a short swell-then-decay envelope.
    playMA(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const n = this._noise(t, 0.12);
      const hp = this._filter('highpass', 5000, 0.9);
      const g = this._gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.55 * vel, t + 0.006);
      g.gain.setTargetAtTime(0, t + 0.006, 0.014);
      n.connect(hp);
      hp.connect(g);
      this._out(g);
    }

    // —— Claves ———————————————————————————————————————————————————
    // A single bridged-T ping at ~2.5 kHz with a very short decay.
    playCL(when, vel = 1) {
      if (!this.ctx) return;
      const t = this._t(when);
      const o = this._osc('sine', 2500, t, t + 0.12);
      o.frequency.setValueAtTime(2600, t);
      o.frequency.setTargetAtTime(2500, t, 0.002);
      const g = this._gain();
      this._decayEnv(g.gain, t, 0.6 * vel, 0.0004, 0.016);
      o.connect(g);
      this._out(g);
    }

    trigger(id, when, vel = 1) {
      const fn = this['play' + id];
      if (typeof fn === 'function') fn.call(this, when, vel);
    }
  }

  global.TR808 = { DrumMachine, INSTRUMENTS };
})(typeof window !== 'undefined' ? window : globalThis);
