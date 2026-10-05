/**
 * 16-step sequencer with look-ahead scheduling
 */
(function (global) {
  'use strict';

  const STEPS = 16;
  const LOOKAHEAD = 0.1; // seconds
  const SCHEDULE_INTERVAL = 25; // ms

  const EMPTY = () =>
    Object.fromEntries(
      (global.TR808?.INSTRUMENTS || []).map((i) => [i.id, new Array(STEPS).fill(0)])
    );

  const PATTERNS = {
    rock: {
      name: 'Rock',
      bpm: 110,
      accent: [0, 4, 8, 12],
      grid: (() => {
        const g = EMPTY();
        // Classic rock: BD on 1,9  SD on 5,13  CH on 8ths
        [0, 8].forEach((s) => (g.BD[s] = 1));
        [4, 12].forEach((s) => (g.SD[s] = 1));
        for (let s = 0; s < 16; s += 2) g.CH[s] = 1;
        g.OH[14] = 1;
        g.CH[14] = 0;
        return g;
      })(),
    },
    hiphop: {
      name: 'Hip-Hop',
      bpm: 90,
      accent: [0, 4, 12],
      grid: (() => {
        const g = EMPTY();
        [0, 7, 10].forEach((s) => (g.BD[s] = 1));
        [4, 12].forEach((s) => (g.SD[s] = 1));
        for (let s = 0; s < 16; s++) if (s % 2 === 0) g.CH[s] = 1;
        g.CH[6] = 0;
        g.OH[6] = 1;
        g.CP[12] = 1;
        return g;
      })(),
    },
    electro: {
      name: 'Electro',
      bpm: 128,
      accent: [0, 4, 8, 12],
      grid: (() => {
        const g = EMPTY();
        [0, 8, 10].forEach((s) => (g.BD[s] = 1));
        [4, 12].forEach((s) => (g.SD[s] = 1));
        for (let s = 0; s < 16; s++) g.CH[s] = 1;
        g.CB[0] = 1;
        g.CB[6] = 1;
        g.CB[11] = 1;
        g.CL[2] = 1;
        g.CL[14] = 1;
        return g;
      })(),
    },
  };

  class Sequencer {
    constructor(machine) {
      this.machine = machine;
      this.steps = STEPS;
      this.bpm = 120;
      this.playing = false;
      this.currentStep = 0;
      this.grid = EMPTY();
      // 808-style global accent track: one accent per step, all instruments
      this.accent = new Array(STEPS).fill(0);
      this.accentAmount = 0.5; // 0..1, like the 808's ACCENT knob
      this._timer = null;
      this._nextNoteTime = 0;
      this.onStep = null; // (stepIndex) => void
    }

    setBpm(bpm) {
      this.bpm = Math.max(60, Math.min(180, Math.round(bpm)));
    }

    clear() {
      this.grid = EMPTY();
      this.accent = new Array(STEPS).fill(0);
    }

    setAccentAmount(v) {
      this.accentAmount = Math.max(0, Math.min(1, Number(v) || 0));
    }

    toggleAccent(step) {
      if (step < 0 || step >= STEPS) return 0;
      this.accent[step] = this.accent[step] ? 0 : 1;
      return this.accent[step];
    }

    loadPattern(key) {
      const p = PATTERNS[key];
      if (!p) return;
      this.grid = {};
      for (const id of Object.keys(p.grid)) {
        this.grid[id] = p.grid[id].slice();
      }
      // ensure all instruments exist
      (global.TR808.INSTRUMENTS || []).forEach((inst) => {
        if (!this.grid[inst.id]) this.grid[inst.id] = new Array(STEPS).fill(0);
      });
      // 808-style accent track defaults
      this.accent = new Array(STEPS).fill(0);
      (p.accent || []).forEach((s) => {
        if (s >= 0 && s < STEPS) this.accent[s] = 1;
      });
      this.setBpm(p.bpm);
    }

    toggleStep(instId, step) {
      if (!this.grid[instId]) this.grid[instId] = new Array(STEPS).fill(0);
      this.grid[instId][step] = this.grid[instId][step] ? 0 : 1;
      return this.grid[instId][step];
    }

    stepDuration() {
      // 16th notes
      return 60 / this.bpm / 4;
    }

    start() {
      if (this.playing) return;
      if (!this.machine.ctx) return;
      this.playing = true;
      this.currentStep = 0;
      this._nextNoteTime = this.machine.currentTime + 0.05;
      this._timer = setInterval(() => this._scheduler(), SCHEDULE_INTERVAL);
      this._scheduler();
    }

    stop() {
      this.playing = false;
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this.currentStep = 0;
      if (this.onStep) this.onStep(-1);
    }

    toggle() {
      if (this.playing) this.stop();
      else this.start();
    }

    _scheduler() {
      if (!this.playing || !this.machine.ctx) return;
      const horizon = this.machine.currentTime + LOOKAHEAD;
      while (this._nextNoteTime < horizon) {
        this._scheduleStep(this.currentStep, this._nextNoteTime);
        const stepForUi = this.currentStep;
        const when = this._nextNoteTime;
        // schedule UI update near play time
        const delay = Math.max(0, (when - this.machine.currentTime) * 1000 - 5);
        setTimeout(() => {
          if (this.playing && this.onStep) this.onStep(stepForUi);
        }, delay);

        this._nextNoteTime += this.stepDuration();
        this.currentStep = (this.currentStep + 1) % this.steps;
      }
    }

    _scheduleStep(step, when) {
      const instruments = global.TR808.INSTRUMENTS || [];
      const vel = this.accent[step] ? 1 + this.accentAmount : 1;
      for (const inst of instruments) {
        if (this.grid[inst.id] && this.grid[inst.id][step]) {
          this.machine.trigger(inst.id, when, vel);
        }
      }
    }
  }

  global.TR808 = global.TR808 || {};
  global.TR808.Sequencer = Sequencer;
  global.TR808.PATTERNS = PATTERNS;
  global.TR808.STEPS = STEPS;
})(typeof window !== 'undefined' ? window : globalThis);
