/**
 * Listen & Recreate — record from the mic or load an audio file, analyse it
 * with TR808.BeatAnalysis and offer the recreated pattern to the sequencer.
 */
(function (global) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const SHOW = ['BD', 'SD', 'CP', 'LT', 'MT', 'HT', 'CH', 'OH'];

  function init(app) {
    const { machine, seq, renderGrid, unlockAudio } = app;
    const panel = $('#listen-panel');
    if (!panel) return;
    const recBtn = $('#listen-rec');
    const fileIn = $('#listen-file');
    const meter = $('#listen-meter');
    const status = $('#listen-status');
    const result = $('#listen-result');
    let seconds = 8;
    let rec = null; // active recording state
    let pending = null; // analysis result awaiting apply
    let live = null; // live 'show the beats' state
    let lastStream = null; // stream of the last take (for the result timeline)
    let replay = null; // file replay animation

    // —— Live view ——————————————————————————————————————————————
    const LIVE_IDS = ['BD', 'SD', 'CP', 'CH', 'OH'];
    const COLORS = { BD: '#c44', SD: '#d65', CP: '#a6a', CH: '#6ad', OH: '#9ce' };
    (global.TR808.INSTRUMENTS || []).forEach((i) => { if (COLORS[i.id] && i.id !== 'OH') COLORS[i.id] = i.color; });
    const liveEl = $('#listen-live');
    const flashEls = {};
    liveEl.querySelectorAll('.ll-flash span').forEach((el) => {
      flashEls[el.dataset.id] = el;
      el.style.setProperty('--c', COLORS[el.dataset.id]);
    });
    const liveBpm = $('#listen-live-bpm');
    const liveCount = $('#listen-live-count');
    const liveGridEl = $('#listen-live-grid');
    const strip = $('#listen-strip');

    function startLive(sr, span) {
      stopLive();
      const stream = global.TR808.BeatAnalysis.createStream(sr);
      live = { stream, span, flashUntil: {}, newHits: 0, tempo: null, lg: null, lastTempo: 0, gridKey: '', raf: 0 };
      lastStream = stream;
      liveBpm.textContent = '—';
      liveCount.textContent = '0 hits';
      liveGridEl.innerHTML = '';
      liveEl.hidden = false;
      const loop = (now) => { if (!live) return; drawLive(now); live.raf = requestAnimationFrame(loop); };
      live.raf = requestAnimationFrame(loop);
    }

    function feedLive(chunk, flush) {
      if (!live) return;
      let hits;
      try { hits = live.stream.push(chunk, flush); } catch (_) { return; }
      live.newHits += hits.length;
      const now = performance.now();
      hits.forEach((h) => { if (h.id) live.flashUntil[h.id] = now + 140; });
    }

    function stopLive(keepVisible) {
      if (live) cancelAnimationFrame(live.raf);
      live = null;
      LIVE_IDS.forEach((id) => flashEls[id].classList.remove('hit'));
      if (!keepVisible) liveEl.hidden = true;
    }

    function drawLive(now) {
      const L = live, st = L.stream;
      LIVE_IDS.forEach((id) => flashEls[id].classList.toggle('hit', (L.flashUntil[id] || 0) > now));
      if (L.newHits) { liveCount.textContent = st.hits.length + ' hit' + (st.hits.length === 1 ? '' : 's'); L.newHits = 0; }
      // tempo + live grid, throttled (autocorrelation is the costly part)
      if (now - L.lastTempo > 600 && st.duration >= 2) {
        L.lastTempo = now;
        const tp = st.tempo();
        if (tp) {
          L.tempo = tp;
          L.lg = st.liveGrid(tp);
          liveBpm.textContent = String(Math.round(tp.bpm));
          renderLiveGrid(L.lg);
        }
      }
      if (L.lg) {
        const t = st.duration - 0.05;
        const ph = Math.floor((t - L.lg.lat - L.tempo.phase) / L.lg.step - L.lg.origin);
        const s = ((ph % 16) + 16) % 16;
        if (s !== L.ph) {
          L.ph = s;
          liveGridEl.querySelectorAll('.lp-row').forEach((row) => {
            const cells = row.children;
            for (let i = 1; i < cells.length; i++) cells[i].classList.toggle('ph', i - 1 === s);
          });
        }
      }
      drawStrip(strip, st, L.span, L.tempo);
    }

    function renderLiveGrid(lg) {
      const key = JSON.stringify(lg.grid);
      if (key === live.gridKey) return;
      live.gridKey = key;
      live.ph = -1;
      liveGridEl.innerHTML = '';
      let max = 1;
      for (const id in lg.grid) max = Math.max(max, ...lg.grid[id]);
      LIVE_IDS.forEach((id) => {
        const row = lg.grid[id];
        if (!row || !row.some(Boolean)) return;
        const el = document.createElement('div');
        el.className = 'lp-row';
        el.innerHTML = '<span>' + id + '</span>' + row.map((c, s) =>
          '<span class="lp-cell' + (s % 4 === 0 ? ' beat' : '') + (c ? ' lv' : '') + '"' +
          (c ? ' style="--c:' + COLORS[id] + ';opacity:' + (0.35 + 0.65 * Math.min(1, c / max)).toFixed(2) + '"' : '') + '></span>').join('');
        liveGridEl.appendChild(el);
      });
    }

    // Waveform-ish envelope + one lane of coloured markers per voice
    function drawStrip(cv, st, span, tempo) {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      span = Math.max(span, st.duration, 0.5);
      const xs = W / span;
      if (tempo) { // beat lines
        const beat = 60 / tempo.bpm;
        g.fillStyle = 'rgba(255,255,255,0.07)';
        for (let t = (tempo.phase || 0) % beat; t < span; t += beat) g.fillRect(Math.round(t * xs), 0, 1, H);
      }
      const env = st.env, er = st.envRate;
      let pk = 1e-4;
      for (let i = 0; i < env.length; i++) if (env[i] > pk) pk = env[i];
      g.fillStyle = '#3a3a44';
      const mid = H / 2;
      const step = Math.max(1, Math.floor(env.length / W));
      for (let i = 0; i < env.length; i += step) {
        const a = (env[i] / pk) * (H * 0.46);
        g.fillRect(Math.floor((i / er) * xs), mid - a, Math.max(1, Math.ceil(xs / er * step)), a * 2);
      }
      const lane = H / LIVE_IDS.length;
      const hits = st.hits;
      const mw = Math.max(2, Math.round(2 * dpr));
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const x = Math.round(h.t * xs);
        for (const id in h.v) {
          const li = LIVE_IDS.indexOf(id);
          if (li < 0) continue;
          g.fillStyle = COLORS[id];
          g.globalAlpha = id === h.id ? 1 : 0.45;
          g.fillRect(x - mw / 2, (LIVE_IDS.length - 1 - li) * lane + 1, mw, lane - 2);
        }
        if (!h.id) { g.globalAlpha = 0.5; g.fillStyle = '#888'; g.fillRect(x, 0, 1, H); }
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = Math.round(9 * dpr) + 'px sans-serif';
      g.textBaseline = 'middle';
      LIVE_IDS.forEach((id, li) => g.fillText(id, 3, (LIVE_IDS.length - 1 - li) * lane + lane / 2));
      if (live && live.stream === st) { // write head
        g.fillStyle = '#ffe066';
        g.fillRect(Math.min(W - 2, Math.round(st.duration * xs)), 0, 2, H);
      }
    }

    const setStatus = (msg, err) => {
      status.textContent = msg;
      status.classList.toggle('error', !!err);
    };

    const open = () => {
      panel.hidden = false;
      unlockAudio();
    };
    const close = () => {
      if (rec) stopRec(true);
      cancelReplay();
      stopLive();
      panel.hidden = true;
    };
    $('#btn-listen').addEventListener('click', open);
    $('#listen-close').addEventListener('click', close);
    panel.addEventListener('click', (e) => {
      if (e.target === panel) close();
    });

    panel.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        panel.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
        c.classList.add('on');
        seconds = Number(c.dataset.sec);
      })
    );

    // —— Microphone ——————————————————————————————————————————————
    async function startRec() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus(
          window.isSecureContext
            ? 'This browser cannot record audio. Try LOAD FILE instead.'
            : 'Microphone needs a secure (https) page. Try LOAD FILE instead.',
          true
        );
        return;
      }
      if (seq.playing) document.getElementById('btn-stop').click();
      // Context must exist/resume inside this tap (iOS)
      await unlockAudio();
      const ctx = machine.ctx;
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
      } catch (_) {}
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        restoreSession();
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        setStatus(
          denied
            ? 'Microphone access was denied. Allow it in your browser settings (iPhone: Settings › Safari › Microphone), or use LOAD FILE.'
            : 'Could not open the microphone (' + (e && e.name ? e.name : e) + ').',
          true
        );
        return;
      }
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch (_) {}
      }
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const chunks = [];
      let total = 0;
      const maxSamples = Math.ceil(seconds * ctx.sampleRate);
      proc.onaudioprocess = (ev) => {
        if (!rec) return;
        const d = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(d);
        chunks.push(copy);
        total += d.length;
        feedLive(copy);
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        const db = 20 * Math.log10(Math.sqrt(s / d.length) + 1e-9);
        meter.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + '%';
        if (total >= maxSamples) stopRec(false);
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      const t0 = Date.now();
      rec = { stream, src, proc, mute, chunks, sr: ctx.sampleRate, timer: null };
      cancelReplay();
      startLive(ctx.sampleRate, seconds);
      rec.timer = setInterval(() => {
        const left = Math.max(0, seconds - (Date.now() - t0) / 1000);
        setStatus('Listening… ' + left.toFixed(1) + ' s (tap STOP to finish early)');
      }, 100);
      recBtn.textContent = '■ STOP';
      recBtn.classList.add('recording');
      result.hidden = true;
      setStatus('Listening…');
    }

    function restoreSession() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (_) {}
    }

    function stopRec(cancel) {
      const r = rec;
      if (!r) return;
      rec = null;
      clearInterval(r.timer);
      try { r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect(); } catch (_) {}
      r.proc.onaudioprocess = null;
      r.stream.getTracks().forEach((t) => t.stop());
      restoreSession();
      recBtn.textContent = '● LISTEN';
      recBtn.classList.remove('recording');
      meter.style.width = '0';
      if (live) feedLive(new Float32Array(0), true);
      stopLive(!cancel);
      // iOS may suspend/interrupt the context when the mic closes
      setTimeout(() => machine.resume().catch(() => {}), 50);
      if (cancel) { stopLive(); setStatus('Ready.'); return; }
      let len = 0;
      r.chunks.forEach((c) => (len += c.length));
      const x = new Float32Array(len);
      let o = 0;
      r.chunks.forEach((c) => { x.set(c, o); o += c.length; });
      if (len < r.sr * 1.5) { stopLive(); setStatus('Recording too short — try at least 3 seconds.', true); return; }
      runAnalysis(x, r.sr);
    }

    recBtn.addEventListener('click', () => {
      if (rec) stopRec(false);
      else startRec();
    });

    // —— File ———————————————————————————————————————————————————
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      setStatus('Decoding ' + f.name + '…');
      result.hidden = true;
      try {
        await unlockAudio();
        const ab = await f.arrayBuffer();
        const ctx = machine.ctx;
        const buf = await new Promise((res, rej) => {
          const p = ctx.decodeAudioData(ab, res, rej);
          if (p && p.then) p.then(res, rej);
        });
        let x = global.TR808.BeatAnalysis.toMono(buf);
        const maxLen = Math.floor(buf.sampleRate * 30); // analyse up to 30 s
        if (x.length > maxLen) x = x.subarray(0, maxLen);
        replayFile(x, buf.sampleRate, f.name);
      } catch (e) {
        setStatus('Could not read that audio file (' + (e && e.message ? e.message : 'unsupported format') + ').', true);
      }
    });

    // Scan a loaded file through the live detector, faster than real time,
    // so the hits/tempo/grid build up visually; then run the full analysis.
    function cancelReplay() {
      if (replay) { cancelAnimationFrame(replay.raf); replay = null; }
    }
    function replayFile(x, sr, name) {
      cancelReplay();
      if (rec) stopRec(true);
      const dur = x.length / sr;
      const speed = Math.max(3, dur / 3.5); // whole file in <= ~3.5 s
      startLive(sr, dur);
      setStatus('Scanning ' + name + '…');
      const t0 = performance.now();
      let pos = 0;
      const R = { raf: 0 };
      replay = R;
      const tick = (now) => {
        if (replay !== R) return;
        const target = Math.min(x.length, Math.floor(((now - t0) / 1000) * speed * sr));
        if (target > pos) { feedLive(x.subarray(pos, target)); pos = target; }
        if (pos >= x.length) {
          feedLive(new Float32Array(0), true);
          replay = null;
          setTimeout(() => { stopLive(true); runAnalysis(x, sr); }, 250);
          return;
        }
        R.raf = requestAnimationFrame(tick);
      };
      R.raf = requestAnimationFrame(tick);
    }

    // —— Analysis + result ——————————————————————————————————————
    function runAnalysis(x, sr) {
      setStatus('Analysing…');
      setTimeout(() => {
        try {
          const r = global.TR808.BeatAnalysis.analyze(x, sr);
          pending = r;
          liveEl.hidden = true;
          showResult(r);
          setStatus('Done — ' + r.onsets + ' hits over ~' + r.bars + ' bar' + (r.bars > 1 ? 's' : '') + '.');
        } catch (e) {
          pending = null;
          liveEl.hidden = true;
          setStatus(e.message || 'Analysis failed.', true);
        }
      }, 30);
    }

    function showResult(r) {
      $('#listen-bpm').textContent = String(Math.round(r.bpm));
      $('#listen-conf').textContent =
        r.confidence >= 0.6 ? '· solid grid fit' : r.confidence >= 0.35 ? '· rough fit' : '· low confidence';
      const pv = $('#listen-preview');
      pv.innerHTML = '';
      SHOW.forEach((id) => {
        const row = r.grid[id];
        if (!row || !row.some(Boolean)) return;
        const el = document.createElement('div');
        el.className = 'lp-row';
        el.innerHTML = '<span>' + id + '</span>' +
          row.map((v, s) => '<span class="lp-cell' + (s % 4 === 0 ? ' beat' : '') + (v ? ' on' : '') + '"></span>').join('');
        pv.appendChild(el);
      });
      if (!pv.children.length) pv.textContent = 'No drum hits recognised.';
      result.hidden = false;
      const tl = $('#listen-timeline');
      tl.hidden = !lastStream;
      if (lastStream) drawStrip(tl, lastStream, lastStream.duration, { bpm: r.bpm, phase: r.phase });
    }

    $('#listen-discard').addEventListener('click', () => {
      pending = null;
      result.hidden = true;
      stopLive();
      setStatus('Discarded. Ready.');
    });

    $('#listen-apply').addEventListener('click', async () => {
      if (!pending) return;
      unlockAudio(); // gesture: make sure playback is alive after recording
      const steps = global.TR808.STEPS || 16;
      const grid = {};
      (global.TR808.INSTRUMENTS || []).forEach((inst) => {
        const g = pending.grid[inst.id];
        grid[inst.id] = g ? g.slice(0, steps).map((v) => (v ? 1 : 0)) : new Array(steps).fill(0);
      });
      seq.grid = grid;
      if (Array.isArray(seq.accent)) seq.accent = new Array(seq.accent.length).fill(0);
      seq.setBpm(pending.bpm);
      const PATTERNS = global.TR808.PATTERNS;
      PATTERNS.recreated = { name: 'Recreated', bpm: seq.bpm, accent: [], grid: JSON.parse(JSON.stringify(grid)) };
      const sel = document.getElementById('pattern');
      if (sel && !sel.querySelector('option[value="recreated"]')) {
        const opt = document.createElement('option');
        opt.value = 'recreated';
        opt.textContent = 'Recreated';
        sel.appendChild(opt);
      }
      if (sel) sel.value = 'recreated';
      const bpmIn = document.getElementById('bpm');
      const bpmVal = document.getElementById('bpm-val');
      if (bpmIn) bpmIn.value = String(seq.bpm);
      if (bpmVal) bpmVal.textContent = String(seq.bpm);
      renderGrid();
      pending = null;
      result.hidden = true;
      setStatus('Applied. Press PLAY to hear it.');
      panel.hidden = true;
    });
  }

  global.TR808 = global.TR808 || {};
  global.TR808.Listen = { init };
})(typeof window !== 'undefined' ? window : globalThis);
