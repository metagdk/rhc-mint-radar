/* RHC Mint Radar — unified intelligence layer. */
(() => {
  'use strict';
  if (window.__RHC_INTEL_V5__) return;
  window.__RHC_INTEL_V5__ = true;

  const CFG = Object.freeze({
    scanMs: 5000,
    rpcMs: 15000,
    timeoutMs: 7000,
    cacheMs: 5 * 60 * 1000,
    minAccelerationSamples: 3,
    journalKey: 'rhc-intel-journal-v2'
  });

  const state = {
    cache: new Map(),
    journal: loadJournal(),
    hidden: document.hidden,
    lastRpc: 0,
    rpc: { latency: null, block: null, chainId: null, ok: false, error: null }
  };

  function loadJournal() {
    try {
      const value = JSON.parse(localStorage.getItem(CFG.journalKey) || '[]');
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  function saveJournal() {
    try { localStorage.setItem(CFG.journalKey, JSON.stringify(state.journal.slice(-500))); } catch {}
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  function txt(el, selector) {
    const node = el?.querySelector(selector);
    return node?.textContent?.trim() || '';
  }

  function numberFrom(value) {
    const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function idFor(row) {
    return String(row?.dataset?.addr || '').toLowerCase();
  }

  function rows() {
    return [...document.querySelectorAll('#collections > [data-addr]')]
      .filter(row => /^0x[a-f0-9]{40}$/.test(idFor(row)));
  }

  function evidence(row) {
    const heat = numberFrom(txt(row, '.heat-val'));
    const supply = numberFrom(txt(row, '.supply-top b'));
    const session = numberFrom(txt(row, '.stats-box > div:first-child b'));
    const windowMints = numberFrom(txt(row, '.stats-box > div:nth-child(2) b'));
    const holderMatch = txt(row, '.supply-sub').match(/holders\s+([\d,]+)/i);
    const holders = holderMatch ? numberFrom(holderMatch[1]) : null;
    const name = txt(row, '.cell-col .name') || txt(row, '.cell-col h3') || idFor(row).slice(0, 10);
    return { heat, supply, session, windowMints, holders, name };
  }

  function analyze(row) {
    const id = idFor(row);
    const now = Date.now();
    const ev = evidence(row);
    const cached = state.cache.get(id);
    const samples = (cached?.samples || [])
      .filter(sample => now - sample.t < CFG.cacheMs);

    samples.push({ t: now, heat: ev.heat });
    while (samples.length > 60) samples.shift();

    const valid = samples.filter(sample => Number.isFinite(sample.heat));
    let velocity = ev.heat;
    let acceleration = null;

    // Heat is already the radar's mint-rate (/min). Do not invent a second
    // velocity metric from cumulative mints. Acceleration only becomes valid
    // after three independent samples exist.
    if (valid.length >= 2) {
      velocity = valid[valid.length - 1].heat;
    }

    if (valid.length >= CFG.minAccelerationSamples) {
      const a = valid[valid.length - 2];
      const b = valid[valid.length - 1];
      const c = valid[valid.length - 3];
      const dtNow = Math.max(0.001, (b.t - a.t) / 60000);
      const dtPrev = Math.max(0.001, (a.t - c.t) / 60000);
      const currentVelocity = (b.heat - a.heat) / dtNow;
      const previousVelocity = (a.heat - c.heat) / dtPrev;
      acceleration = currentVelocity - previousVelocity;
    }

    // Alpha is intentionally transparent: heat is the dominant observed
    // signal; acceleration is only added after it has enough samples.
    const heatScore = ev.heat == null ? null : Math.max(0, Math.min(100, ev.heat));
    const accelerationScore = acceleration == null
      ? null
      : Math.max(0, Math.min(100, 50 + acceleration * 2));

    let alpha = null;
    if (heatScore != null) {
      alpha = accelerationScore == null
        ? Math.round(heatScore)
        : Math.round(heatScore * 0.70 + accelerationScore * 0.30);
    }

    // Confidence is NOT "number of formulas that ran". It reflects how much
    // independent/settled evidence exists. A fresh row cannot show 100%.
    let confidence = 0;
    if (heatScore != null) confidence += 45;
    if (valid.length >= 2) confidence += 20;
    if (valid.length >= CFG.minAccelerationSamples) confidence += 15;
    if (ev.supply != null || ev.holders != null) confidence += 10;
    if (state.rpc.ok) confidence += 10;
    confidence = Math.min(100, confidence);

    const out = {
      ...ev,
      velocity,
      acceleration,
      alpha,
      confidence,
      samples,
      evidence: {
        heat: heatScore != null,
        velocity: valid.length >= 2,
        acceleration: acceleration != null,
        supply: ev.supply != null,
        holders: ev.holders != null,
        rpc: state.rpc.ok
      }
    };

    state.cache.set(id, { at: now, ...out });
    return out;
  }

  async function rpc(method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
    const started = performance.now();

    try {
      const response = await fetch('/api/intel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
        credentials: 'same-origin'
      });

      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok || data?.error) {
        const code = data?.code || `HTTP_${response.status}`;
        throw new Error(code);
      }

      state.rpc.latency = Math.round(performance.now() - started);
      state.rpc.error = null;
      return data.result;
    } catch (error) {
      state.rpc.error = error?.message || 'RPC_UNAVAILABLE';
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshRpc() {
    const [block, chain] = await Promise.all([
      rpc('eth_blockNumber'),
      rpc('eth_chainId')
    ]);

    const previousOk = state.rpc.ok;
    state.rpc.block = block ? parseInt(block, 16) : null;
    state.rpc.chainId = chain ? parseInt(chain, 16) : null;
    state.rpc.ok = Boolean(block && chain);

    if (!state.rpc.ok && previousOk) state.rpc.latency = null;
  }

  function mount() {
    if (document.getElementById('rhc-intel-panel')) return;

    const panel = document.createElement('aside');
    panel.id = 'rhc-intel-panel';
    panel.setAttribute('aria-label', 'RHC intelligence');
    panel.innerHTML = `
      <div class="rhc-intel-head">
        <b>INTELLIGENCE</b>
        <span id="rhc-intel-status" title="Private RPC health">● STARTING</span>
      </div>
      <div class="rhc-intel-grid">
        <div><small>HOT</small><strong id="rhc-hot">0</strong></div>
        <div><small>ALPHA</small><strong id="rhc-alpha">—</strong></div>
        <div><small>VELOCITY</small><strong id="rhc-velocity">—</strong></div>
        <div><small>RPC</small><strong id="rhc-rpc">—</strong></div>
      </div>
      <div id="rhc-hot-list"></div>`;
    document.body.appendChild(panel);
  }

  function render() {
    const analyzed = rows()
      .map(row => ({ row, data: analyze(row) }))
      .filter(item => item.data.alpha != null)
      .sort((a, b) => (b.data.alpha ?? -1) - (a.data.alpha ?? -1));

    const hot = analyzed.filter(item => item.data.alpha >= 75).slice(0, 5);
    const best = analyzed[0]?.data || null;

    const q = id => document.getElementById(id);
    const hotEl = q('rhc-hot');
    const alphaEl = q('rhc-alpha');
    const velocityEl = q('rhc-velocity');
    const rpcEl = q('rhc-rpc');
    const statusEl = q('rhc-intel-status');
    const listEl = q('rhc-hot-list');

    if (!hotEl || !alphaEl || !velocityEl || !rpcEl || !statusEl || !listEl) return;

    hotEl.textContent = String(hot.length);
    alphaEl.textContent = best ? String(best.alpha) : '—';
    velocityEl.textContent = best?.velocity != null ? `${best.velocity.toFixed(1)}/m` : '—';
    rpcEl.textContent = state.rpc.ok ? `${state.rpc.latency}ms` : '—';

    if (state.rpc.ok) {
      statusEl.textContent = '● RPC LIVE';
      statusEl.className = 'rhc-intel-status-ok';
      statusEl.title = `Chain ID ${state.rpc.chainId ?? '—'} · block ${state.rpc.block ?? '—'}`;
    } else {
      statusEl.textContent = '● RPC OFFLINE';
      statusEl.className = 'rhc-intel-status-bad';
      statusEl.title = state.rpc.error || 'Private RPC unavailable; market heat remains local to the radar.';
    }

    listEl.innerHTML = hot.length
      ? hot.map(item => {
          const confidence = item.data.confidence;
          const label = confidence >= 80 ? 'high' : confidence >= 60 ? 'medium' : 'early';
          return `<div class="rhc-hot-row" title="${esc(label)} confidence · ${esc(item.data.evidence.acceleration ? 'acceleration confirmed' : 'waiting for more samples')}">
            <b>🔥 ${esc(item.data.name)}</b>
            <span>${item.data.alpha} · ${confidence}%</span>
          </div>`;
        }).join('')
      : '<div class="rhc-empty">No high-confidence opportunities yet</div>';
  }

  function bindJournal(row) {
    if (row.dataset.rhcJournalBound) return;
    row.dataset.rhcJournalBound = '1';

    row.querySelectorAll('a.btn').forEach(btn => {
      const action = (btn.textContent || '').trim().toUpperCase();
      if (!['MINT', 'PASS', 'WATCH'].includes(action)) return;
      btn.addEventListener('click', () => {
        state.journal.push({
          t: Date.now(),
          action,
          id: idFor(row),
          name: txt(row, '.cell-col .name')
        });
        saveJournal();
      }, { passive: true });
    });
  }

  async function tick() {
    if (state.hidden) return;
    const currentRows = rows();
    currentRows.forEach(bindJournal);
    render();

    if (Date.now() - state.lastRpc >= CFG.rpcMs) {
      state.lastRpc = Date.now();
      await refreshRpc();
      // Re-render after RPC state changes so confidence/status are truthful.
      render();
    }
  }

  function loop() {
    tick().catch(() => {});
    window.setTimeout(loop, CFG.scanMs);
  }

  function boot() {
    mount();
    document.addEventListener('visibilitychange', () => {
      state.hidden = document.hidden;
    });

    const target = document.getElementById('collections');
    if (target) {
      new MutationObserver(() => {
        if (!state.hidden) tick().catch(() => {});
      }).observe(target, { childList: true, subtree: true });
    }

    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
