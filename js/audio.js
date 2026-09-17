/**
 * TR-808 style drum synthesis via Web Audio API
 * Self-contained — no external samples.
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
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -24;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 2;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.15;
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      this.comp.connect(this.master);
      this.master.connect(this.ctx.destination);
      this._noiseBuffer = this._makeNoise(2);
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

    _makeNoise(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    }

    _noise(when, duration) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      src.loop = true;
      src.start(when);
      src.stop(when + duration + 0.05);
      return src;
    }

    _env(gainNode, when, attack, decay, peak, sustain, release) {
      const g = gainNode.gain;
      g.cancelScheduledValues(when);
      g.setValueAtTime(0.0001, when);
      g.exponentialRampToValueAtTime(Math.max(peak, 0.0001), when + Math.max(attack, 0.001));
      if (sustain != null && release != null) {
        g.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), when + attack + decay);
        g.exponentialRampToValueAtTime(0.0001, when + attack + decay + release);
      } else {
        g.exponentialRampToValueAtTime(0.0001, when + attack + decay);
      }
    }

    _out(node, when, duration) {
      node.connect(this.comp);
    }

    // —— Bass Drum ——
    playBD(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const click = this.ctx.createOscillator();
      const clickGain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.06);
      osc.frequency.exponentialRampToValueAtTime(30, t + 0.45);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.95 * vel, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);

      click.type = 'sine';
      click.frequency.value = 220;
      clickGain.gain.setValueAtTime(0.35 * vel, t);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);

      osc.connect(gain);
      gain.connect(this.comp);
      click.connect(clickGain);
      clickGain.connect(this.comp);
      osc.start(t);
      osc.stop(t + 0.6);
      click.start(t);
      click.stop(t + 0.03);
    }

    // —— Snare ——
    playSD(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const tone = this.ctx.createOscillator();
      const toneGain = this.ctx.createGain();
      const noise = this._noise(t, 0.25);
      const noiseFilter = this.ctx.createBiquadFilter();
      const noiseGain = this.ctx.createGain();

      tone.type = 'triangle';
      tone.frequency.setValueAtTime(185, t);
      tone.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      toneGain.gain.setValueAtTime(0.0001, t);
      toneGain.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.002);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = 1800;
      noiseGain.gain.setValueAtTime(0.0001, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.7 * vel, t + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

      tone.connect(toneGain);
      toneGain.connect(this.comp);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.comp);
      tone.start(t);
      tone.stop(t + 0.25);
    }

    // —— Toms ——
    _playTom(when, startFreq, endFreq, decay, vel) {
      const t = when ?? this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const noise = this._noise(t, 0.08);
      const nGain = this.ctx.createGain();
      const nFilt = this.ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, t);
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.85 * vel, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      nFilt.type = 'bandpass';
      nFilt.frequency.value = startFreq * 1.5;
      nFilt.Q.value = 1.5;
      nGain.gain.setValueAtTime(0.2 * vel, t);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

      osc.connect(gain);
      gain.connect(this.comp);
      noise.connect(nFilt);
      nFilt.connect(nGain);
      nGain.connect(this.comp);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }

    playLT(when, vel = 1) {
      this._playTom(when, 120, 70, 0.4, vel);
    }
    playMT(when, vel = 1) {
      this._playTom(when, 180, 100, 0.32, vel);
    }
    playHT(when, vel = 1) {
      this._playTom(when, 260, 150, 0.28, vel);
    }

    // —— Rimshot ——
    playRS(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o1.type = 'square';
      o2.type = 'square';
      o1.frequency.value = 450;
      o2.frequency.value = 850;
      g.gain.setValueAtTime(0.35 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      o1.connect(g);
      o2.connect(g);
      g.connect(this.comp);
      o1.start(t);
      o2.start(t);
      o1.stop(t + 0.05);
      o2.stop(t + 0.05);
    }

    // —— Clap (multi-burst noise) ——
    playCP(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const bursts = [0, 0.012, 0.024, 0.045];
      bursts.forEach((off, i) => {
        const noise = this._noise(t + off, 0.12);
        const filt = this.ctx.createBiquadFilter();
        const g = this.ctx.createGain();
        filt.type = 'bandpass';
        filt.frequency.value = 1200;
        filt.Q.value = 0.8;
        const peak = (i === bursts.length - 1 ? 0.75 : 0.4) * vel;
        const decay = i === bursts.length - 1 ? 0.28 : 0.04;
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.exponentialRampToValueAtTime(peak, t + off + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + decay);
        noise.connect(filt);
        filt.connect(g);
        g.connect(this.comp);
      });
    }

    // —— Closed Hat ——
    playCH(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const noise = this._noise(t, 0.08);
      const hp = this.ctx.createBiquadFilter();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      bp.type = 'bandpass';
      bp.frequency.value = 9000;
      bp.Q.value = 0.7;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
      noise.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      g.connect(this.comp);
    }

    // —— Open Hat ——
    playOH(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const noise = this._noise(t, 0.45);
      const hp = this.ctx.createBiquadFilter();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      bp.type = 'bandpass';
      bp.frequency.value = 8500;
      bp.Q.value = 0.6;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      noise.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      g.connect(this.comp);
    }

    // —— Cymbal ——
    playCY(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const freqs = [523, 785, 1047, 1568];
      const mix = this.ctx.createGain();
      mix.gain.value = 0.12 * vel;
      freqs.forEach((f) => {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        o.connect(mix);
        o.start(t);
        o.stop(t + 0.9);
      });
      const noise = this._noise(t, 0.9);
      const hp = this.ctx.createBiquadFilter();
      const bp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 5000;
      bp.type = 'bandpass';
      bp.frequency.value = 7000;
      bp.Q.value = 0.5;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.45 * vel, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      mix.connect(hp);
      noise.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      g.connect(this.comp);
    }

    // —— Cowbell ——
    playCB(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const filt = this.ctx.createBiquadFilter();
      o1.type = 'square';
      o2.type = 'square';
      // Classic 808 cowbell-ish ratio ~540 / 800 Hz
      o1.frequency.value = 540;
      o2.frequency.value = 800;
      filt.type = 'bandpass';
      filt.frequency.value = 700;
      filt.Q.value = 2;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o1.connect(filt);
      o2.connect(filt);
      filt.connect(g);
      g.connect(this.comp);
      o1.start(t);
      o2.start(t);
      o1.stop(t + 0.4);
      o2.stop(t + 0.4);
    }

    // —— Maracas ——
    playMA(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const noise = this._noise(t, 0.06);
      const hp = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 5500;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      noise.connect(hp);
      hp.connect(g);
      g.connect(this.comp);
    }

    // —— Claves ——
    playCL(when, vel = 1) {
      if (!this.ctx) return;
      const t = when ?? this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 2500;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7 * vel, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(g);
      g.connect(this.comp);
      osc.start(t);
      osc.stop(t + 0.08);
    }

    trigger(id, when, vel = 1) {
      const fn = this['play' + id];
      if (typeof fn === 'function') fn.call(this, when, vel);
    }
  }

  global.TR808 = { DrumMachine, INSTRUMENTS };
})(typeof window !== 'undefined' ? window : globalThis);
