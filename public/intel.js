/* RHC Mint Radar — unified intelligence layer.
 * Additive to the existing mint engine. Never blocks the core feed.
 * All scores are evidence-based; unavailable signals are omitted rather than invented.
 */
(() => {
  'use strict';
  if (window.__RHC_INTEL_V2__) return;
  window.__RHC_INTEL_V2__ = true;

  const CFG = Object.freeze({
    scanMs: 5000,
    cacheMs: 5 * 60 * 1000,
    maxConcurrent: 2,
    timeoutMs: 7000,
    maxHistory: 60,
    journalKey: 'rhc-intel-journal-v2'
  });

  const state = {
    cache: new Map(),
    running: new Set(),
    queue: [],
    journal: loadJournal(),
    hidden: document.hidden,
    lastScan: 0,
    rpc: { latency: null, block: null, chainId: null, ok: false }
  };

  function loadJournal() {
    try { return JSON.parse(localStorage.getItem(CFG.journalKey) || '[]'); } catch { return []; }
  }
  function saveJournal() {
    try { localStorage.setItem(CFG.journalKey, JSON.stringify(state.journal.slice(-500))); } catch {}
  }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function text(el, selectors) {
    for (const s of selectors) { const n = el.querySelector(s); if (n?.textContent) return n.textContent.trim(); }
    return '';
  }
  function addressFrom(el) {
    const raw = el.dataset.address || el.dataset.contract || el.getAttribute('data-address') || text(el, ['[data-address]','.address','.contract-address']);
    const m = String(raw).match(/0x[a-fA-F0-9]{40}/);
    return m ? m[0] : '';
  }
  function idFor(el) {
    return addressFrom(el).toLowerCase() || el.dataset.collectionId || text(el,['.collection-name','.name']) || '';
  }
  function num(v) {
    const n = Number(String(v ?? '').replace(/,/g,''));
    return Number.isFinite(n) ? n : null;
  }
  function metric(el, selectors) {
    const n = num(text(el, selectors));
    return n == null ? null : n;
  }

  function collectRows() {
    const selectors = [
      '[data-contract]','[data-address]','.collection-card','.mint-card','.mint-item','.collection-row','article'
    ];
    const set = new Set();
    selectors.forEach(s => document.querySelectorAll(s).forEach(n => set.add(n)));
    return [...set].filter(n => idFor(n));
  }

  function evidence(row) {
    const minted = metric(row,['.minted','.mint-count','[data-minted]']);
    const supply = metric(row,['.supply','.max-supply','[data-supply]']);
    const heat = metric(row,['.heat','.score','[data-heat]']);
    const creator = text(row,['.creator','.creator-address','[data-creator]']);
    const velocity = metric(row,['.velocity','.mint-velocity','[data-velocity]']);
    const smart = metric(row,['.smart-wallets','[data-smart-wallets]']);
    return { minted, supply, heat, creator, velocity, smart };
  }

  function analyze(row) {
    const id = idFor(row);
    const now = Date.now();
    const ev = evidence(row);
    const prev = state.cache.get(id);
    const result = prev?.result || { samples: [] };
    const sample = { t: now, minted: ev.minted, heat: ev.heat };
    result.samples = (result.samples || []).filter(s => now - s.t < CFG.maxHistory * 10000);
    result.samples.push(sample);

    let velocity = ev.velocity;
    let acceleration = null;
    const valid = result.samples.filter(s => Number.isFinite(s.minted));
    if (valid.length >= 2) {
      const a = valid[valid.length - 2], b = valid[valid.length - 1];
      const dt = Math.max(1, (b.t - a.t) / 60000);
      velocity = velocity ?? (b.minted - a.minted) / dt;
      if (valid.length >= 3) {
        const p = valid[valid.length - 3];
        const dt1 = Math.max(1, (a.t - p.t) / 60000);
        const v1 = (a.minted - p.minted) / dt1;
        acceleration = velocity - v1;
      }
    }

    let score = 0, weight = 0;
    if (ev.heat != null) { score += Math.max(0, Math.min(100, ev.heat)) * .45; weight += .45; }
    if (velocity != null) { score += Math.max(0, Math.min(100, velocity * 2)) * .25; weight += .25; }
    if (acceleration != null) { score += Math.max(0, Math.min(100, 50 + acceleration * 2)) * .15; weight += .15; }
    if (ev.smart != null) { score += Math.max(0, Math.min(100, ev.smart * 20)) * .15; weight += .15; }
    const alpha = weight ? Math.round(score / weight) : null;

    const concentration = ev.minted != null && ev.supply != null && ev.supply > 0 ? Math.min(100, (ev.minted / ev.supply) * 100) : null;
    const risk = [];
    if (concentration != null && concentration > 90) risk.push('near sellout');
    if (ev.minted === 0 && ev.supply === 0) risk.push('no supply data');

    const confidence = Math.round(Math.min(100, [ev.heat, velocity, acceleration, ev.smart].filter(v => v != null).length * 25));
    const out = { ...ev, velocity, acceleration, concentration, risk, alpha, confidence, samples: result.samples };
    state.cache.set(id, { at: now, result: out });
    return out;
  }

  async function rpc(method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
    const t = performance.now();
    try {
      const r = await fetch('/api/intel', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({method,params}), signal:controller.signal });
      const data = await r.json();
      if (!r.ok || data?.error) throw new Error(data?.error || `HTTP ${r.status}`);
      state.rpc.latency = Math.round(performance.now() - t);
      state.rpc.ok = true;
      return data.result;
    } catch { state.rpc.ok = false; return null; }
    finally { clearTimeout(timer); }
  }

  async function refreshRpc() {
    const [block, chainId] = await Promise.all([rpc('eth_blockNumber'), rpc('eth_chainId')]);
    state.rpc.block = block ? parseInt(block,16) : null;
    state.rpc.chainId = chainId ? parseInt(chainId,16) : null;
  }

  function mountUI() {
    if (document.getElementById('rhc-intel-panel')) return;
    const panel = document.createElement('aside');
    panel.id = 'rhc-intel-panel';
    panel.setAttribute('aria-label','RHC intelligence');
    panel.innerHTML = `<div class="rhc-intel-head"><b>INTELLIGENCE</b><span id="rhc-intel-status">● LIVE</span></div><div class="rhc-intel-grid"><div><small>HOT</small><strong id="rhc-hot">0</strong></div><div><small>ALPHA</small><strong id="rhc-alpha">—</strong></div><div><small>VELOCITY</small><strong id="rhc-velocity">0</strong></div><div><small>RPC</small><strong id="rhc-rpc">—</strong></div></div><div id="rhc-hot-list"></div>`;
    document.body.appendChild(panel);
    const style = document.createElement('style');
    style.textContent = `#rhc-intel-panel{position:fixed;right:14px;bottom:14px;width:260px;z-index:9998;background:rgba(12,14,20,.94);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;font:12px system-ui;backdrop-filter:blur(12px);box-shadow:0 12px 40px rgba(0,0,0,.28)}#rhc-intel-panel .rhc-intel-head{display:flex;justify-content:space-between;margin-bottom:10px;letter-spacing:.08em}#rhc-intel-status{font-size:10px;opacity:.65}.rhc-intel-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.rhc-intel-grid div{padding:7px;background:rgba(255,255,255,.05);border-radius:8px;text-align:center}.rhc-intel-grid small{display:block;font-size:8px;opacity:.55}.rhc-intel-grid strong{display:block;margin-top:3px;font-size:14px}.rhc-hot-row{display:flex;justify-content:space-between;padding:7px 2px;border-top:1px solid rgba(255,255,255,.07)}.rhc-hot-row b{font-size:11px}.rhc-hot-row span{opacity:.75}#rhc-intel-panel.rhc-hidden{display:none}@media(max-width:700px){#rhc-intel-panel{left:10px;right:10px;bottom:10px;width:auto}}`;
    document.head.appendChild(style);
  }

  function render(rows) {
    const data = rows.map(r => ({ row:r, data:analyze(r), name:text(r,['.collection-name','.name','h2','h3']) || 'Collection' }));
    const scored = data.filter(x => x.data.alpha != null).sort((a,b) => b.data.alpha - a.data.alpha);
    const hot = scored.filter(x => x.data.alpha >= 75).slice(0,5);
    const alpha = scored[0]?.data.alpha ?? null;
    const velocity = scored.reduce((m,x) => Math.max(m, x.data.velocity ?? 0), 0);
    const hotEl = document.getElementById('rhc-hot');
    const alphaEl = document.getElementById('rhc-alpha');
    const velEl = document.getElementById('rhc-velocity');
    const rpcEl = document.getElementById('rhc-rpc');
    const list = document.getElementById('rhc-hot-list');
    if (hotEl) hotEl.textContent = String(hot.length);
    if (alphaEl) alphaEl.textContent = alpha == null ? '—' : String(alpha);
    if (velEl) velEl.textContent = velocity > 0 ? velocity.toFixed(1)+'/m' : '0';
    if (rpcEl) rpcEl.textContent = state.rpc.ok ? `${state.rpc.latency}ms` : '—';
    if (list) list.innerHTML = hot.length ? hot.map(x => `<div class="rhc-hot-row"><b>🔥 ${esc(x.name)}</b><span>${x.data.alpha} · ${x.data.confidence}%</span></div>`).join('') : '<div style="padding-top:8px;opacity:.5">No high-confidence opportunities yet</div>';
  }

  function processJournal(row) {
    if (!row || row.dataset.rhcJournalBound) return;
    row.dataset.rhcJournalBound = '1';
    ['MINT','PASS','WATCH'].forEach(action => {
      const btn = [...row.querySelectorAll('button')].find(b => (b.textContent||'').trim().toUpperCase() === action);
      if (!btn) return;
      btn.addEventListener('click', () => {
        state.journal.push({ t:Date.now(), action, id:idFor(row), name:text(row,['.collection-name','.name','h2','h3']) });
        saveJournal();
      }, { passive:true });
    });
  }

  async function tick() {
    if (state.hidden) return;
    const rows = collectRows();
    rows.forEach(processJournal);
    render(rows);
    if (Date.now() - state.lastScan > 15000) { state.lastScan = Date.now(); refreshRpc(); }
  }

  function loop() {
    tick().catch(() => {});
    setTimeout(loop, CFG.scanMs);
  }

  function boot() {
    mountUI();
    document.addEventListener('visibilitychange', () => { state.hidden = document.hidden; });
    new MutationObserver(() => { if (!state.hidden) tick().catch(() => {}); }).observe(document.body, {childList:true,subtree:true});
    loop();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true }); else boot();
})();
