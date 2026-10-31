/**
 * Beat analysis — listen to a drum loop and recreate it as a 16-step pattern.
 * Pure JS, no dependencies: radix-2 FFT, spectral-flux onsets, tempo by
 * autocorrelation + 16th-grid phase fit, multi-bar voting, band-energy
 * voice classification (BD / SD / CP / CH / OH).
 *
 * API: TR808.BeatAnalysis.analyze(Float32Array mono, sampleRate, opts?)
 *   -> { bpm, grid: {BD:[16],...}, onsets, bars, confidence }
 *      TR808.BeatAnalysis.toMono(AudioBuffer) -> Float32Array
 */
(function (global) {
  'use strict';

  const N = 1024;

  // —— FFT (in-place iterative radix-2) ——————————————————————————
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k];
            const ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  function toMono(buf) {
    const len = buf.length, ch = buf.numberOfChannels;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  // Downsample to ~22 kHz (keeps >5 kHz hat band, halves the work)
  function decimate(x, sr) {
    if (sr < 32000) return { x, sr };
    const f = Math.round(sr / 22050);
    const out = new Float32Array(Math.floor(x.length / f));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < f; k++) s += x[i * f + k];
      out[i] = s / f;
    }
    return { x: out, sr: sr / f };
  }

  const median = (arr) => {
    const a = Array.from(arr).sort((p, q) => p - q);
    return a.length ? a[a.length >> 1] : 0;
  };
  const pct = (arr, p) => {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
  };

  // —— Spectral frames ————————————————————————————————————————————
  function spectrogram(x, sr) {
    const hop = 128; // ~5.8 ms at 22 kHz
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const binHz = sr / N, half = N / 2;
    const bin = (hz) => Math.min(half, Math.max(1, Math.round(hz / binHz)));
    const B = {
      low: [bin(30), bin(150)],
      lmid: [bin(150), bin(500)],
      mid: [bin(500), bin(2500)],
      hmid: [bin(2500), bin(5000)],
      high: [bin(5000), half],
    };
    const bands = {};
    for (const k in B) bands[k] = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames);
    const bflux = { low: new Float32Array(nFrames), lmid: new Float32Array(nFrames), mid: new Float32Array(nFrames), high: new Float32Array(nFrames) };
    const centroid = new Float32Array(nFrames);
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(half + 1), cur = new Float32Array(half + 1);
    for (let f = 0; f < nFrames; f++) {
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let fl = 0, cw = 0, ct = 0;
      const bf = { low: 0, lmid: 0, mid: 0, high: 0 };
      for (let k = 1; k <= half; k++) {
        const m2 = re[k] * re[k] + im[k] * im[k];
        const lm = Math.log1p(1000 * Math.sqrt(m2));
        cur[k] = lm;
        const d = lm - prev[k];
        if (d > 0) {
          fl += d;
          if (k < B.low[1]) bf.low += d;
          else if (k < B.lmid[1]) bf.lmid += d;
          else if (k < B.mid[1]) bf.mid += d;
          else if (k >= B.high[0]) bf.high += d;
        }
        cw += m2 * k; ct += m2;
      }
      for (const kk in B) {
        let e = 0;
        for (let k = B[kk][0]; k < B[kk][1]; k++) e += re[k] * re[k] + im[k] * im[k];
        bands[kk][f] = e;
      }
      flux[f] = fl;
      for (const kk in bf) bflux[kk][f] = bf[kk];
      centroid[f] = ct > 0 ? (cw / ct) * binHz : 0;
      const t = prev; prev = cur; cur = t;
    }
    return { hop, frameRate: sr / hop, nFrames, flux, bflux, bands, centroid };
  }

  // —— Onsets: adaptive-threshold peak picking —————————————————————
  function pickOnsets(env, frameRate, opts) {
    const n = env.length;
    const w = Math.round(0.1 * frameRate);
    const mx = pct(env, 0.98) || 1;
    const delta = (opts.delta ?? 0.06) * mx;
    const minGap = Math.round(0.045 * frameRate);
    const out = [];
    let last = -1e9;
    for (let i = 1; i < n - 1; i++) {
      if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
      const a = Math.max(0, i - w), b = Math.min(n, i + w);
      let s = 0;
      for (let j = a; j < b; j++) s += env[j];
      const thr = (s / (b - a)) * 1.3 + delta;
      if (env[i] < thr) continue;
      if (i - last < minGap) {
        if (out.length && env[i] > out[out.length - 1].s) { out[out.length - 1] = { f: i, s: env[i] }; last = i; }
        continue;
      }
      out.push({ f: i, s: env[i] });
      last = i;
    }
    return out;
  }

  // —— Tempo ———————————————————————————————————————————————————————
  function estimateTempo(env, frameRate, onsets) {
    const n = env.length;
    const mean = env.reduce((a, b) => a + b, 0) / n;
    const e = env.map((v) => Math.max(0, v - mean));
    const lagFor = (bpm) => (60 / bpm) * frameRate;
    const ac = (lag) => {
      const l0 = Math.floor(lag), fr = lag - l0;
      let s = 0;
      for (let i = 0; i + l0 + 1 < n; i++) s += e[i] * (e[i + l0] * (1 - fr) + e[i + l0 + 1] * fr);
      return s / (n - l0);
    };
    let best = 120, bestS = -Infinity;
    const cands = [];
    for (let bpm = 60; bpm <= 180; bpm += 0.5) {
      // beat-level + half-beat comb, mild log-Gaussian prior centred ~118 BPM
      const s = ac(lagFor(bpm)) + 0.5 * ac(lagFor(bpm) * 2) + 0.25 * ac(lagFor(bpm) / 2);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.6, 2));
      const sc = s * prior;
      cands.push([bpm, sc]);
      if (sc > bestS) { bestS = sc; best = bpm; }
    }
    // refine with 16th-grid phase coherence of the onsets
    const times = onsets.map((o) => o.f / frameRate);
    const ws = onsets.map((o) => o.s);
    const fit = (bpm) => {
      const step = 60 / bpm / 4;
      let c = 0, s = 0, W = 0;
      for (let i = 0; i < times.length; i++) {
        const ph = (2 * Math.PI * times[i]) / step;
        c += ws[i] * Math.cos(ph); s += ws[i] * Math.sin(ph); W += ws[i];
      }
      return { r: Math.hypot(c, s) / (W || 1), phase: ((Math.atan2(s, c) / (2 * Math.PI)) * step + step) % step };
    };
    let rb = best, rf = fit(best);
    for (let bpm = Math.max(60, best * 0.96); bpm <= Math.min(180, best * 1.04); bpm += 0.02) {
      const f = fit(bpm);
      if (f.r > rf.r + 1e-6) { rf = f; rb = bpm; }
    }
    // octave preference: keep inside 80-160 when possible
    if (rb < 80 && rb * 2 <= 180) rb *= 2;
    else if (rb > 160 && rb / 2 >= 60) rb /= 2;
    rf = fit(rb);
    return { bpm: rb, phase: rf.phase, coherence: rf.r };
  }

  // —— Voice classification ————————————————————————————————————————
  function classify(spec, onsets, frameRate) {
    const { bflux, bands, centroid } = spec;
    const at = (arr, f) => Math.max(arr[f] || 0, arr[f + 1] || 0, arr[f - 1] || 0);
    const hFloor = pct(bands.high, 0.1);
    const feats = onsets.map((o, idx) => {
      const f = o.f;
      const nextF = idx + 1 < onsets.length ? onsets[idx + 1].f : spec.nFrames;
      // high-band decay length (frames until -15 dB), bounded by next onset
      const p0 = Math.max(bands.high[f], bands.high[f + 1] || 0, bands.high[f + 2] || 0);
      let d = 0;
      const lim = Math.min(spec.nFrames, nextF, f + Math.round(0.6 * frameRate));
      for (let k = f + 2; k < lim; k++) { if (bands.high[k] < Math.max(p0 * 0.03, hFloor * 3)) break; d++; }
      const decay = d / frameRate;
      const sum = (arr) => { let s = 0; for (let k = f; k < Math.min(spec.nFrames, f + 6); k++) s += arr[k]; return s; };
      return {
        low: at(bflux.low, f), lmid: at(bflux.lmid, f), mid: at(bflux.mid, f), high: at(bflux.high, f),
        eLow: sum(bands.low), eLmid: sum(bands.lmid), eMid: sum(bands.mid), eHigh: Math.max(0, sum(bands.high) - 6 * hFloor),
        cent: centroid[f + 1] || centroid[f], decay, cut: (lim - f) / frameRate,
      };
    });
    const ref = (k) => pct(feats.map((x) => x[k]), 0.9) || 1;
    const R = { low: ref('low'), lmid: ref('lmid'), mid: ref('mid'), high: ref('high'), eHigh: ref('eHigh') };
    return feats.map((x) => voiceOf(x, R));
  }

  // Classify one hit's feature vector against reference levels R
  function voiceOf(x, R) {
    const v = {};
    const nl = x.low / R.low, nm = x.mid / R.mid, nh = x.high / R.high;
    if (nl > 0.45 && x.eLow > x.eLmid) v.BD = nl;
    // snare / clap: strong mid-band attack whose body sits above the kick
    // (a kick's click also shows mid flux, but its energy is all < 150 Hz)
    const bodyRatio = (x.eLmid + x.eMid) / (x.eLow + 1e-12);
    if (nm > 0.5 && bodyRatio > (v.BD ? 0.35 : 1.5)) {
      const tonal = x.eLmid / (x.eMid + 1e-12); // 808 snare has 180-330 Hz body
      v[tonal > 3 ? 'SD' : 'CP'] = nm;
    }
    if (!(v.SD || v.CP) && x.eHigh / R.eHigh > 0.08 && nh > 0.1) {
      // open hat rings; if cut short by the next onset, judge relative to the gap
      const open = x.decay > 0.16 || (x.decay >= x.cut - 0.02 && x.cut > 0.12 && x.decay > 0.1);
      v[open ? 'OH' : 'CH'] = x.eHigh / R.eHigh;
    }
    return v;
  }

  // —— Main ——————————————————————————————————————————————————————————
  function analyze(input, sampleRate, opts = {}) {
    const { x, sr } = decimate(input, sampleRate);
    // normalise
    let pk = 0;
    for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    if (pk < 1e-4) throw new Error('The recording is silent — nothing to analyse.');
    const xn = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) xn[i] = x[i] / pk;

    const spec = spectrogram(xn, sr);
    const fr = spec.frameRate;
    const onsets = pickOnsets(spec.flux, fr, opts);
    if (onsets.length < 4) throw new Error('Not enough drum hits detected. Try louder or closer to the speaker.');
    const tempo = opts.bpm
      ? { bpm: opts.bpm, phase: 0, coherence: 1 }
      : estimateTempo(spec.flux, fr, onsets);
    const bpm = tempo.bpm;
    const step = 60 / bpm / 4;
    const voices = classify(spec, onsets, fr);

    // quantise; onset time is slightly after the true attack (frame centre)
    const lat = (N / 2) / sr * 0.5;
    const hits = onsets.map((o, i) => ({ k: Math.round((o.f / fr - lat - tempo.phase) / step), v: voices[i], s: o.s }));
    const kMin = Math.min(...hits.map((h) => h.k)), kMax = Math.max(...hits.map((h) => h.k));
    const IDS = ['BD', 'SD', 'CP', 'CH', 'OH'];

    // try every bar rotation; vote across bars; score musical plausibility
    let best = null;
    for (let r = 0; r < 16; r++) {
      const votes = {}, cover = new Array(16).fill(0);
      IDS.forEach((id) => (votes[id] = new Array(16).fill(0)));
      const barOf = (k) => Math.floor((k - r) / 16);
      const b0 = barOf(kMin), b1 = barOf(kMax);
      for (let b = b0; b <= b1; b++)
        for (let s = 0; s < 16; s++) {
          const k = b * 16 + s + r;
          if (k >= kMin - 1 && k <= kMax + 1) cover[s]++;
        }
      const seen = new Set();
      for (const h of hits) {
        const s = (((h.k - r) % 16) + 16) % 16;
        for (const id in h.v) {
          const key = id + ':' + h.k;
          if (seen.has(key)) continue;
          seen.add(key);
          votes[id][s]++;
        }
      }
      const grid = {};
      IDS.forEach((id) => {
        grid[id] = votes[id].map((c, s) => (cover[s] && c / cover[s] >= 0.5 ? 1 : 0));
      });
      let sc = 0;
      sc += grid.BD[0] * 4 + grid.BD[8] * 1.5;
      const sn = (s) => grid.SD[s] || grid.CP[s];
      sc += (sn(4) + sn(12)) * 2.5 - sn(0) * 2;
      sc -= grid.BD[4] * 0.5 + grid.BD[12] * 0.5;
      sc += 0.3 * ((grid.CH[0] || 0) + (grid.CH[2] || 0)); // hats on even 16ths
      if (r === ((kMin % 16) + 16) % 16) sc += 0.75; // audio likely starts on a downbeat
      if (!best || sc > best.sc) best = { sc, grid, r, votes, cover };
    }

    // a step can't be both CH and OH; SD vs CP keep the majority
    const g = best.grid;
    for (let s = 0; s < 16; s++) {
      if (g.CH[s] && g.OH[s]) { if (best.votes.OH[s] >= best.votes.CH[s]) g.CH[s] = 0; else g.OH[s] = 0; }
      if (g.SD[s] && g.CP[s]) { if (best.votes.CP[s] > best.votes.SD[s]) g.SD[s] = 0; else g.CP[s] = 0; }
    }
    // Hats hidden under a snare/clap hit can't be heard separately: if the
    // hats form a steady 8th or 16th line elsewhere, fill those gaps.
    for (const stride of [1, 2]) {
      const idx = [];
      for (let s = 0; s < 16; s += stride) idx.push(s);
      const on = idx.filter((s) => g.CH[s] || g.OH[s]).length;
      const gaps = idx.filter((s) => !g.CH[s] && !g.OH[s]);
      if (on >= idx.length * 0.6 && gaps.length && gaps.every((s) => g.SD[s] || g.CP[s])) {
        gaps.forEach((s) => (g.CH[s] = 1));
        break;
      }
    }
    const bars = Math.max(1, Math.round((kMax - kMin + 1) / 16));
    return {
      bpm: Math.round(bpm * 10) / 10,
      grid: g,
      bars,
      onsets: onsets.length,
      confidence: Math.round(Math.min(1, tempo.coherence * 1.4) * 100) / 100,
      phase: tempo.phase,
      firstStep: kMin,
    };
  }


  // —— Streaming (live) detection ————————————————————————————————————
  // Incremental version of spectrogram + pickOnsets + classify for the
  // live "show the beats" view. Feed raw mic/file chunks with push();
  // it returns newly classified hits [{t, s, v, id}] (t in seconds).
  function growable(n) { return { a: new Float32Array(n), n: 0 }; }
  function gpush(g, v) {
    if (g.n >= g.a.length) { const b = new Float32Array(g.a.length * 2); b.set(g.a); g.a = b; }
    g.a[g.n++] = v;
  }
  const ORDER = ['BD', 'SD', 'CP', 'OH', 'CH'];
  function primary(v) {
    let best = null, bs = -1;
    for (const id of ORDER) if (v[id] != null && v[id] > bs) { bs = v[id]; best = id; }
    return best;
  }

  function createStream(sampleRate) {
    const f = sampleRate >= 32000 ? Math.round(sampleRate / 22050) : 1;
    const sr = sampleRate / f, hop = 128, fr = sr / hop, half = N / 2;
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const binHz = sr / N;
    const bin = (hz) => Math.min(half, Math.max(1, Math.round(hz / binHz)));
    const B = { low: [bin(30), bin(150)], lmid: [bin(150), bin(500)], mid: [bin(500), bin(2500)], high: [bin(5000), half] };
    const x = growable(sr * 16);
    const G = () => growable(4096);
    const flux = G(), centroid = G();
    const bflux = { low: G(), lmid: G(), mid: G(), high: G() };
    const bands = { low: G(), lmid: G(), mid: G(), high: G() };
    const env = G(); // peak per 256 decimated samples (~11.6 ms)
    let envAcc = 0, envCnt = 0, dAcc = 0, dCnt = 0;
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(half + 1), cur = new Float32Array(half + 1);
    let nFrames = 0, runMax = 0, lastOn = -1e9, scanned = 1;
    const onsets = []; // {f, s}
    const feats = []; // per classified onset
    const hits = [];
    const w = Math.round(0.1 * fr), minGap = Math.round(0.045 * fr), look = Math.round(0.22 * fr);
    const lat = (N / 2) / sr * 0.5;

    function frame() {
      const o = nFrames * hop, X = x.a;
      for (let i = 0; i < N; i++) { re[i] = X[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let fl = 0, cw = 0, ct = 0, bl = 0, blm = 0, bm = 0, bh = 0;
      const e = { low: 0, lmid: 0, mid: 0, high: 0 };
      for (let k = 1; k <= half; k++) {
        const m2 = re[k] * re[k] + im[k] * im[k];
        const lm = Math.log1p(1000 * Math.sqrt(m2));
        cur[k] = lm;
        const d = lm - prev[k];
        if (d > 0) {
          fl += d;
          if (k < B.low[1]) bl += d; else if (k < B.lmid[1]) blm += d; else if (k < B.mid[1]) bm += d; else if (k >= B.high[0]) bh += d;
        }
        if (k >= B.low[0] && k < B.low[1]) e.low += m2;
        else if (k >= B.lmid[0] && k < B.lmid[1]) e.lmid += m2;
        else if (k >= B.mid[0] && k < B.mid[1]) e.mid += m2;
        else if (k >= B.high[0] && k < B.high[1]) e.high += m2;
        cw += m2 * k; ct += m2;
      }
      gpush(flux, fl); gpush(centroid, ct > 0 ? (cw / ct) * binHz : 0);
      gpush(bflux.low, bl); gpush(bflux.lmid, blm); gpush(bflux.mid, bm); gpush(bflux.high, bh);
      for (const k in e) gpush(bands[k], e[k]);
      const t = prev; prev = cur; cur = t;
      nFrames++;
    }

    function pick() {
      const F = flux.a;
      while (scanned < nFrames - 1) {
        const i = scanned++;
        runMax = Math.max(F[i], runMax * 0.9995);
        if (F[i] < F[i - 1] || F[i] < F[i + 1]) continue;
        const a = Math.max(0, i - w), b = Math.min(nFrames, i + w);
        let s = 0;
        for (let j = a; j < b; j++) s += F[j];
        const thr = (s / (b - a)) * 1.3 + 0.06 * runMax;
        if (F[i] < thr || F[i] < 0.12 * runMax) continue;
        if (i - lastOn < minGap) {
          const l = onsets[onsets.length - 1];
          if (l && !l.done && F[i] > l.s) { l.f = i; l.s = F[i]; lastOn = i; }
          continue;
        }
        onsets.push({ f: i, s: F[i], done: false });
        lastOn = i;
      }
    }

    function featAt(idx) {
      const fI = onsets[idx].f;
      const nextF = idx + 1 < onsets.length ? onsets[idx + 1].f : nFrames;
      const at = (g, q) => Math.max(g.a[q] || 0, g.a[q + 1] || 0, g.a[q - 1] || 0);
      const H = bands.high.a;
      const hFloor = 1e-9 + pct(H.subarray(0, nFrames), 0.1);
      const p0 = Math.max(H[fI], H[fI + 1] || 0, H[fI + 2] || 0);
      let d = 0;
      const lim = Math.min(nFrames, nextF, fI + Math.round(0.6 * fr));
      for (let k = fI + 2; k < lim; k++) { if (H[k] < Math.max(p0 * 0.03, hFloor * 3)) break; d++; }
      const sum = (g) => { let s = 0; for (let k = fI; k < Math.min(nFrames, fI + 6); k++) s += g.a[k]; return s; };
      return {
        low: at(bflux.low, fI), lmid: at(bflux.lmid, fI), mid: at(bflux.mid, fI), high: at(bflux.high, fI),
        eLow: sum(bands.low), eLmid: sum(bands.lmid), eMid: sum(bands.mid), eHigh: Math.max(0, sum(bands.high) - 6 * hFloor),
        cent: centroid.a[fI + 1] || centroid.a[fI], decay: d / fr, cut: (lim - fI) / fr,
      };
    }

    function classifyReady(flush) {
      const out = [];
      for (let idx = 0; idx < onsets.length; idx++) {
        const o = onsets[idx];
        if (o.done) continue;
        if (!flush && nFrames < o.f + look && idx === onsets.length - 1) break;
        if (!flush && nFrames < o.f + look && onsets[idx + 1].f > nFrames) break;
        o.done = true;
        const ft = featAt(idx);
        feats.push(ft);
        const ref = (k) => pct(feats.map((q) => q[k]), 0.9) || 1;
        const R = { low: ref('low'), lmid: ref('lmid'), mid: ref('mid'), high: ref('high'), eHigh: ref('eHigh') };
        const v = voiceOf(ft, R);
        const h = { t: o.f / fr, s: o.s, v, id: primary(v) };
        hits.push(h);
        out.push(h);
      }
      return out;
    }

    function push(chunk, flush) {
      for (let i = 0; i < chunk.length; i++) {
        dAcc += chunk[i]; dCnt++;
        if (dCnt === f) {
          const v = dAcc / f;
          gpush(x, v);
          dAcc = 0; dCnt = 0;
          const av = Math.abs(v);
          if (av > envAcc) envAcc = av;
          if (++envCnt === 256) { gpush(env, envAcc); envAcc = 0; envCnt = 0; }
        }
      }
      while ((nFrames * hop) + N <= x.n) frame();
      pick();
      return classifyReady(!!flush);
    }

    function tempo() {
      const ons = onsets.filter((o) => o.done);
      if (nFrames / fr < 2 || ons.length < 4) return null;
      return estimateTempo(Array.from(flux.a.subarray(0, nFrames)), fr, ons);
    }

    // Fold hits so far onto a 16-step bar at the given tempo
    function liveGrid(tp) {
      const step = 60 / tp.bpm / 4;
      const ks = hits.map((h) => Math.round((h.t - lat - tp.phase) / step));
      // bar origin: same musical-plausibility score as analyze() uses
      const res = { BD: new Array(16).fill(0), SN: new Array(16).fill(0) };
      hits.forEach((h, i) => {
        const m = ((ks[i] % 16) + 16) % 16;
        if (h.id === 'BD') res.BD[m]++;
        else if (h.id === 'SD' || h.id === 'CP') res.SN[m]++;
      });
      let r = 0, bsc = -Infinity;
      for (let q = 0; q < 16; q++) {
        const at = (arr, s) => arr[(s + q) % 16];
        const sc = at(res.BD, 0) * 4 + at(res.BD, 8) * 1.5 + (at(res.SN, 4) + at(res.SN, 12)) * 2.5 - at(res.SN, 0) * 2;
        if (sc > bsc) { bsc = sc; r = q; }
      }
      const grid = {};
      hits.forEach((h, i) => {
        const s = (((ks[i] - r) % 16) + 16) % 16;
        if (h.id) (grid[h.id] = grid[h.id] || new Array(16).fill(0))[s]++;
      });
      return { grid, origin: r, step, lat };
    }

    return {
      push, tempo, liveGrid, hits, sr, lat,
      get duration() { return x.n / sr; },
      get env() { return env.a.subarray(0, env.n); },
      envRate: sr / 256,
    };
  }

  global.TR808 = global.TR808 || {};
  global.TR808.BeatAnalysis = { analyze, toMono, makeFFT, createStream, voiceOf, primary };
})(typeof window !== 'undefined' ? window : globalThis);
