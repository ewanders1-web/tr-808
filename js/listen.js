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
        chunks.push(new Float32Array(d));
        total += d.length;
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
      // iOS may suspend/interrupt the context when the mic closes
      setTimeout(() => machine.resume().catch(() => {}), 50);
      if (cancel) { setStatus('Ready.'); return; }
      let len = 0;
      r.chunks.forEach((c) => (len += c.length));
      const x = new Float32Array(len);
      let o = 0;
      r.chunks.forEach((c) => { x.set(c, o); o += c.length; });
      if (len < r.sr * 1.5) { setStatus('Recording too short — try at least 3 seconds.', true); return; }
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
        runAnalysis(x, buf.sampleRate);
      } catch (e) {
        setStatus('Could not read that audio file (' + (e && e.message ? e.message : 'unsupported format') + ').', true);
      }
    });

    // —— Analysis + result ——————————————————————————————————————
    function runAnalysis(x, sr) {
      setStatus('Analysing…');
      setTimeout(() => {
        try {
          const r = global.TR808.BeatAnalysis.analyze(x, sr);
          pending = r;
          showResult(r);
          setStatus('Done — ' + r.onsets + ' hits over ~' + r.bars + ' bar' + (r.bars > 1 ? 's' : '') + '.');
        } catch (e) {
          pending = null;
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
    }

    $('#listen-discard').addEventListener('click', () => {
      pending = null;
      result.hidden = true;
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
