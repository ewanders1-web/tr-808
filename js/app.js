/**
 * TR-808 PWA — UI wiring, touch pads, sequencer controls
 */
(function () {
  'use strict';

  const { DrumMachine, INSTRUMENTS, Sequencer, PATTERNS, STEPS } = window.TR808;

  const machine = new DrumMachine();
  const seq = new Sequencer(machine);

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  let audioReady = false;
  let silentEl = null;

  function unlockHtmlAudio() {
    // Extra iOS unlock path via HTMLAudioElement
    try {
      if (!silentEl) {
        silentEl = new Audio(
          'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
        );
        silentEl.setAttribute('playsinline', 'true');
        silentEl.volume = 0.01;
      }
      const p = silentEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }

  async function unlockAudio() {
    unlockHtmlAudio();
    try {
      await machine.resume();
      audioReady = machine.unlocked || (machine.ctx && machine.ctx.state === 'running');
      updateAudioBadge();
      return audioReady;
    } catch (e) {
      console.warn('Audio unlock failed', e);
      updateAudioBadge();
      return false;
    }
  }

  function updateAudioBadge() {
    const el = $('#audio-status');
    if (!el) return;
    if (audioReady) {
      el.textContent = 'AUDIO ON · if silent, flip Ring switch';
      el.classList.add('ready');
    } else {
      el.textContent = 'TAP A PAD TO ENABLE AUDIO';
      el.classList.remove('ready');
    }
  }

  // —— Build pads ——
  function buildPads() {
    const grid = $('#pads');
    grid.innerHTML = '';
    INSTRUMENTS.forEach((inst) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pad';
      btn.dataset.id = inst.id;
      btn.setAttribute('aria-label', inst.name);
      btn.style.setProperty('--pad-accent', inst.color);
      btn.innerHTML =
        `<span class="pad-id">${inst.id}</span>` +
        `<span class="pad-name">${inst.name}</span>`;

      const fire = async (e) => {
        // Prefer pointer events; ignore legacy touch/mouse duplicates
        if (e.type === 'touchstart' && window.PointerEvent) return;
        if (e.type === 'mousedown' && (window.PointerEvent || e.sourceCapabilities?.firesTouchEvents)) return;
        e.preventDefault();
        unlockHtmlAudio();
        // Kick AudioContext in this same gesture turn, then hit the pad
        const pending = unlockAudio();
        machine.trigger(inst.id);
        await pending;
        btn.classList.add('hit');
        clearTimeout(btn._hitT);
        btn._hitT = setTimeout(() => btn.classList.remove('hit'), 120);
      };

      btn.addEventListener('pointerdown', fire, { passive: false });
      btn.addEventListener('touchstart', fire, { passive: false });
      btn.addEventListener('mousedown', fire);

      grid.appendChild(btn);
    });
  }

  // —— Sequencer grid ——
  function buildSeqGrid() {
    const wrap = $('#seq-grid');
    wrap.innerHTML = '';

    // header row with step numbers
    const head = document.createElement('div');
    head.className = 'seq-row seq-header';
    head.innerHTML = '<div class="seq-label"></div>';
    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('div');
      cell.className = 'seq-step-num' + (s % 4 === 0 ? ' beat' : '');
      cell.textContent = String(s + 1);
      head.appendChild(cell);
    }
    wrap.appendChild(head);

    INSTRUMENTS.forEach((inst) => {
      const row = document.createElement('div');
      row.className = 'seq-row';
      row.dataset.inst = inst.id;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'seq-label';
      label.textContent = inst.id;
      label.title = 'Audition ' + inst.name;
      label.style.setProperty('--pad-accent', inst.color);
      label.addEventListener('pointerdown', async (e) => {
        e.preventDefault();
        await unlockAudio();
        machine.trigger(inst.id);
      });
      row.appendChild(label);

      for (let s = 0; s < STEPS; s++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'seq-cell' + (s % 4 === 0 ? ' beat' : '');
        cell.dataset.step = String(s);
        cell.setAttribute('aria-label', `${inst.id} step ${s + 1}`);
        cell.addEventListener('pointerdown', async (e) => {
          e.preventDefault();
          await unlockAudio();
          const on = seq.toggleStep(inst.id, s);
          cell.classList.toggle('on', !!on);
        });
        row.appendChild(cell);
      }
      wrap.appendChild(row);
    });

    buildAccentRow(wrap);
    renderGrid();
  }

  function buildAccentRow(wrap) {
    // 808-style global accent track: one extra row, tap a step to accent it
    const row = document.createElement('div');
    row.className = 'seq-row seq-accent-row';
    row.dataset.inst = 'ACC';
    const label = document.createElement('div');
    label.className = 'seq-label seq-accent-label';
    label.textContent = 'ACC';
    label.title = 'Accent — tap a step to make it hit harder';
    row.appendChild(label);

    for (let s = 0; s < STEPS; s++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'seq-cell seq-accent-cell' + (s % 4 === 0 ? ' beat' : '');
      cell.dataset.step = String(s);
      cell.setAttribute('aria-label', `Accent step ${s + 1}`);
      cell.addEventListener('pointerdown', async (e) => {
        e.preventDefault();
        await unlockAudio();
        const on = seq.toggleAccent(s);
        cell.classList.toggle('accent-on', !!on);
      });
      row.appendChild(cell);
    }
    wrap.appendChild(row);
  }

  function renderGrid() {
    INSTRUMENTS.forEach((inst) => {
      const row = $(`.seq-row[data-inst="${inst.id}"]`);
      if (!row) return;
      $$('.seq-cell', row).forEach((cell, s) => {
        cell.classList.toggle('on', !!(seq.grid[inst.id] && seq.grid[inst.id][s]));
      });
    });
    // accent row
    const accRow = $('.seq-accent-row');
    if (accRow) {
      $$('.seq-accent-cell', accRow).forEach((cell, s) => {
        cell.classList.toggle('accent-on', !!seq.accent[s]);
      });
    }
  }

  function setPlayhead(step) {
    $$('.seq-cell.playhead').forEach((c) => c.classList.remove('playhead'));
    $$('.seq-step-num.playhead').forEach((c) => c.classList.remove('playhead'));
    if (step < 0) return;
    $$('.seq-row').forEach((row) => {
      if (row.classList.contains('seq-header')) {
        const nums = $$('.seq-step-num', row);
        if (nums[step]) nums[step].classList.add('playhead');
        return;
      }
      const cells = $$('.seq-cell', row);
      if (cells[step]) cells[step].classList.add('playhead');
    });
  }

  seq.onStep = setPlayhead;

  // —— Controls ——
  function bindControls() {
    const playBtn = $('#btn-play');
    const stopBtn = $('#btn-stop');
    const clearBtn = $('#btn-clear');
    const bpmInput = $('#bpm');
    const bpmVal = $('#bpm-val');
    const volInput = $('#volume');
    const patternSel = $('#pattern');

    playBtn.addEventListener('click', async () => {
      unlockHtmlAudio();
      await unlockAudio();
      machine.trigger('BD');
      if (!seq.playing) {
        seq.start();
        playBtn.classList.add('active');
        playBtn.textContent = 'PLAYING';
      }
    });

    stopBtn.addEventListener('click', () => {
      seq.stop();
      playBtn.classList.remove('active');
      playBtn.textContent = 'PLAY';
      setPlayhead(-1);
    });

    clearBtn.addEventListener('click', () => {
      seq.clear();
      renderGrid();
    });

    const syncBpm = () => {
      seq.setBpm(Number(bpmInput.value));
      bpmVal.textContent = String(seq.bpm);
      bpmInput.value = String(seq.bpm);
    };
    bpmInput.addEventListener('input', syncBpm);
    bpmInput.addEventListener('change', syncBpm);

    volInput.addEventListener('input', () => {
      machine.volume = Number(volInput.value) / 100;
    });
    machine.volume = Number(volInput.value) / 100;

    // 808-style accent amount knob
    const accentInput = $('#accent');
    const syncAccent = () => {
      seq.setAccentAmount(Number(accentInput.value) / 100);
    };
    accentInput.addEventListener('input', syncAccent);
    syncAccent();

    // patterns
    Object.keys(PATTERNS).forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PATTERNS[key].name;
      patternSel.appendChild(opt);
    });
    patternSel.addEventListener('change', () => {
      const key = patternSel.value;
      if (!key) return;
      seq.loadPattern(key);
      syncBpmFromSeq();
      renderGrid();
    });

    function syncBpmFromSeq() {
      bpmInput.value = String(seq.bpm);
      bpmVal.textContent = String(seq.bpm);
    }

    // load default pattern
    seq.loadPattern('rock');
    patternSel.value = 'rock';
    syncBpmFromSeq();
    renderGrid();

    // first gesture anywhere unlocks
    const unlockOnce = async () => {
      await unlockAudio();
    };
    document.body.addEventListener('pointerdown', unlockOnce, { once: true });
    document.body.addEventListener('touchstart', unlockOnce, { once: true, passive: true });
  }

  // Prevent double-tap zoom on interactive chrome
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) {
        const t = e.target;
        if (t.closest && (t.closest('.pad') || t.closest('.seq-cell') || t.closest('.ctrl'))) {
          e.preventDefault();
        }
      }
      lastTouch = now;
    },
    { passive: false }
  );

  function init() {
    buildPads();
    buildSeqGrid();
    bindControls();
    updateAudioBadge();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
