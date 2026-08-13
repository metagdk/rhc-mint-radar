/*
 * Mint Radar Intelligence Layer
 * Additive module: does not replace the existing mint poller or renderer.
 * Public data: Blockscout v2. Optional private enrichment is requested only through
 * same-origin /api/intel; credentials never belong in this file.
 */
(() => {
  "use strict";

  const API = "https://robinhoodchain.blockscout.com/api/v2";
  const ROOT_ID = "radarIntel";
  const CACHE_TTL = 5 * 60 * 1000;
  const HISTORY_TTL = 30 * 60 * 1000;
  const ROW_SCAN_MS = 3500;
  const REQUEST_TIMEOUT = 7000;
  const MAX_CONCURRENT = 2;
  const MAX_HOT = 6;
  const JOURNAL_KEY = "rhc-mint-radar:journal:v1";
  const WALLET_KEY = "rhc-mint-radar:wallets:v1";

  const state = {
    cache: new Map(),
    queued: new Set(),
    queue: [],
    active: 0,
    velocity: new Map(),
    rows: new Map(),
    scores: new Map(),
    latency: [],
    observer: null,
    timer: null,
    journal: loadJson(JOURNAL_KEY, []),
    wallets: loadJson(WALLET_KEY, {}),
  };

  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v ?? fallback;
    } catch { return fallback; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  function validAddress(v) { return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v); }
  function short(v) { return validAddress(v) ? `${v.slice(0,6)}…${v.slice(-4)}` : "—"; }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  async function getJson(url, timeout = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      state.latency.push(performance.now() - started);
      if (state.latency.length > 30) state.latency.shift();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  async function privateEnrich(payload) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("/api/intel", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload), signal: controller.signal, credentials: "same-origin" });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  function ensureStyles() {
    if (document.getElementById("radar-intel-style")) return;
    const s = document.createElement("style");
    s.id = "radar-intel-style";
    s.textContent = `
      #radarIntel{margin:0 0 16px;border:1px solid rgba(120,150,255,.16);border-radius:18px;background:linear-gradient(180deg,rgba(13,17,28,.94),rgba(7,9,15,.9));box-shadow:0 14px 45px rgba(0,0,0,.22);overflow:hidden}
      #radarIntel .ri-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
      #radarIntel .ri-title{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:.02em}.ri-live{width:7px;height:7px;border-radius:50%;background:#7cffb2;box-shadow:0 0 14px #7cffb2}.ri-muted{opacity:.62;font-size:11px}
      #radarIntel .ri-grid{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;gap:8px;padding:12px 16px}.ri-kpi{padding:10px 11px;border:1px solid rgba(255,255,255,.055);border-radius:12px;background:rgba(255,255,255,.025)}.ri-kpi b{display:block;font-size:18px}.ri-kpi span{font-size:10px;opacity:.58;text-transform:uppercase;letter-spacing:.08em}
      #radarIntel .ri-body{display:grid;grid-template-columns:1.35fr 1fr;gap:12px;padding:0 16px 16px}.ri-card{border:1px solid rgba(255,255,255,.055);border-radius:13px;background:rgba(255,255,255,.02);overflow:hidden}.ri-card h4{margin:0;padding:10px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.68}.ri-hot{display:grid;grid-template-columns:34px 1fr auto;gap:9px;align-items:center;padding:9px 12px;border-top:1px solid rgba(255,255,255,.045)}.ri-hot:first-of-type{border-top:0}.ri-rank{font:700 12px ui-monospace,monospace;opacity:.5}.ri-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ri-sub{font-size:10px;opacity:.55;margin-top:2px}.ri-score{font:800 14px ui-monospace,monospace}.ri-score.hot{color:#ffcf66}.ri-score.good{color:#7cffb2}.ri-score.bad{color:#ff7d8a}.ri-actions{display:flex;gap:6px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.045)}.ri-btn{border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.035);color:inherit;border-radius:8px;padding:6px 9px;font-size:10px;cursor:pointer}.ri-btn:hover{background:rgba(255,255,255,.08)}
      .rank-row .ri-mini{margin-left:5px;padding:2px 5px;border-radius:6px;font:700 9px ui-monospace,monospace;border:1px solid rgba(255,207,102,.22);color:#ffcf66;background:rgba(255,207,102,.06)}
      .ri-drawer{position:fixed;right:14px;bottom:14px;width:min(440px,calc(100vw - 28px));max-height:min(72vh,680px);z-index:10000;border:1px solid rgba(130,160,255,.2);border-radius:16px;background:rgba(6,8,14,.98);box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:auto;display:none}.ri-drawer.open{display:block}.ri-drawer-head{position:sticky;top:0;background:rgba(6,8,14,.98);padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between}.ri-section{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.05)}.ri-section h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.65}.ri-metric{display:flex;justify-content:space-between;padding:5px 0;font-size:12px}.ri-note{font-size:11px;line-height:1.5;opacity:.65}.ri-log{font-size:10px;padding:6px 0;border-top:1px solid rgba(255,255,255,.04)}
      @media(max-width:900px){#radarIntel .ri-grid{grid-template-columns:repeat(2,1fr)}#radarIntel .ri-body{grid-template-columns:1fr}}@media(max-width:520px){#radarIntel .ri-grid{grid-template-columns:1fr 1fr}.ri-kpi b{font-size:15px}.ri-hot{grid-template-columns:26px 1fr auto}}
    `;
    document.head.appendChild(s);
  }

  function insertUI() {
    if (document.getElementById(ROOT_ID)) return;
    const main = document.getElementById("main");
    if (!main) return;
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.setAttribute("aria-label", "Mint Radar intelligence");
    root.innerHTML = `
      <div class="ri-head"><div class="ri-title"><i class="ri-live"></i> Intelligence Command Center <span class="ri-muted" id="riStatus">warming up…</span></div><button class="ri-btn" id="riOpen">Decision Journal</button></div>
      <div class="ri-grid"><div class="ri-kpi"><span>Top alpha</span><b id="riAlpha">—</b></div><div class="ri-kpi"><span>Hot queue</span><b id="riHot">0</b></div><div class="ri-kpi"><span>Smart wallets</span><b id="riWallets">0</b></div><div class="ri-kpi"><span>Risk flags</span><b id="riRisk">0</b></div><div class="ri-kpi"><span>Radar latency</span><b id="riLatency">—</b></div></div>
      <div class="ri-body"><div class="ri-card"><h4>🔥 Hot Queue</h4><div id="riQueue"><div class="ri-note" style="padding:12px">Waiting for live collections…</div></div></div><div class="ri-card"><h4>🧠 Decision signals</h4><div id="riSignals" style="padding:10px 12px"><div class="ri-note">Scoring velocity, acceleration, creator history, holder concentration, contract verification and wallet signals.</div></div><div class="ri-actions"><button class="ri-btn" id="riRefresh">Refresh intelligence</button><button class="ri-btn" id="riJournal">Log top signal</button></div></div></div>`;
    main.parentNode.insertBefore(root, main);

    const drawer = document.createElement("div");
    drawer.className = "ri-drawer";
    drawer.id = "riDrawer";
    drawer.innerHTML = `<div class="ri-drawer-head"><b>Decision Journal</b><button class="ri-btn" id="riClose">Close</button></div><div class="ri-section"><p class="ri-note">Your decisions stay in this browser. Nothing is uploaded by this module.</p><div id="riJournalList"></div></div>`;
    document.body.appendChild(drawer);
    document.getElementById("riOpen")?.addEventListener("click", () => { drawer.classList.add("open"); renderJournal(); });
    document.getElementById("riClose")?.addEventListener("click", () => drawer.classList.remove("open"));
    document.getElementById("riRefresh")?.addEventListener("click", () => scanRows(true));
    document.getElementById("riJournal")?.addEventListener("click", () => logTop());
  }

  function rowData(row) {
    const address = row?.dataset?.addr;
    if (!validAddress(address)) return null;
    const name = row.querySelector(".col-name")?.textContent?.trim() || address;
    const heatText = row.querySelector(".heat-val")?.textContent || "0";
    const heat = num(heatText.match(/[\d.]+/)?.[0]);
    const supply = num(row.querySelector(".supply-top b")?.textContent?.replace(/,/g, ""));
    const holdersText = row.querySelector(".supply-sub")?.textContent || "";
    const holders = num(holdersText.match(/holders\s+([\d,]+)/i)?.[1]?.replace(/,/g, ""));
    return { address, name, heat, supply, holders, row };
  }

  function updateVelocity(c) {
    const key = c.address.toLowerCase();
    const now = Date.now();
    let h = state.velocity.get(key);
    if (!h) h = { points: [] };
    h.points.push({ t: now, v: c.heat });
    h.points = h.points.filter((x) => now - x.t <= 120000);
    state.velocity.set(key, h);
    const old = h.points.find((x) => now - x.t >= 20000) || h.points[0];
    const acceleration = old ? c.heat - old.v : 0;
    const pct = old && old.v > 0 ? ((c.heat - old.v) / old.v) * 100 : 0;
    return { acceleration, accelerationPct: pct };
  }

  async function analyze(c, force = false) {
    const key = c.address.toLowerCase();
    const cached = state.cache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

    let creator = null, previous = 0, verified = false, proxy = false, holderConcentration = null, smartWallets = 0, privateData = null;
    try {
      const info = await getJson(`${API}/addresses/${encodeURIComponent(c.address)}`);
      creator = info?.creator_address_hash || null;
      verified = !!(info?.is_verified || info?.is_verified_contract);
      proxy = !!(info?.is_proxy || info?.implementation_address_hash);
      if (creator && validAddress(creator)) {
        const tx = await getJson(`${API}/addresses/${encodeURIComponent(creator)}/internal-transactions?filter=from&limit=50`).catch(() => null);
        previous = (tx?.items || []).filter((x) => validAddress(x?.created_contract?.hash) && x.created_contract.hash.toLowerCase() !== c.address.toLowerCase() && x.created_contract.is_contract !== false).length;
      }
    } catch { /* partial intelligence is better than blocking the radar */ }

    try {
      const holders = await getJson(`${API}/tokens/${encodeURIComponent(c.address)}/holders?limit=20`);
      const items = holders?.items || [];
      const total = items.reduce((s, x) => s + num(x.value), 0);
      const top = items.slice(0, 10).reduce((s, x) => s + num(x.value), 0);
      if (total > 0) holderConcentration = clamp((top / total) * 100, 0, 100);
      smartWallets = items.filter((x) => x?.address_hash?.is_contract).length;
    } catch { /* endpoint may not be indexed yet */ }

    privateData = await privateEnrich({ action: "collection_intel", contract: c.address, creator }).catch(() => null);
    if (privateData) {
      smartWallets = num(privateData.smartWallets ?? smartWallets);
    }

    const vel = updateVelocity(c);
    const velocityScore = clamp(c.heat * 8, 0, 100);
    const accelScore = clamp(50 + vel.accelerationPct * 1.5, 0, 100);
    const creatorScore = creator ? clamp(50 + previous * 8, 0, 100) : 35;
    const distributionScore = holderConcentration == null ? 50 : clamp(100 - Math.max(0, holderConcentration - 20) * 1.4, 0, 100);
    const contractScore = verified ? (proxy ? 70 : 92) : (proxy ? 48 : 62);
    const walletScore = clamp(45 + smartWallets * 15, 0, 100);
    const risk = clamp((proxy ? 18 : 0) + (holderConcentration != null && holderConcentration > 65 ? 28 : 0) + (!verified ? 12 : 0), 0, 70);
    const alpha = Math.round(clamp(velocityScore * .27 + accelScore * .20 + creatorScore * .14 + distributionScore * .15 + contractScore * .10 + walletScore * .14 - risk * .15, 0, 100));

    const data = { at: Date.now(), creator, previous, verified, proxy, holderConcentration, smartWallets, alpha, risk, acceleration: vel.acceleration, accelerationPct: vel.accelerationPct, velocity: c.heat, private: privateData };
    state.cache.set(key, { at: Date.now(), data });
    state.scores.set(key, data);
    return data;
  }

  function enqueue(c, force = false) {
    const key = c.address.toLowerCase();
    if (state.queued.has(key)) return;
    state.queued.add(key); state.queue.push({ c, force }); drain();
  }
  async function drain() {
    while (state.active < MAX_CONCURRENT && state.queue.length) {
      const job = state.queue.shift(); state.active++;
      try { await analyze(job.c, job.force); } catch { /* never break queue */ }
      state.active--; state.queued.delete(job.c.address.toLowerCase());
    }
    render();
  }

  function scanRows(force = false) {
    document.querySelectorAll("#collections article.rank-row[data-addr]").forEach((row) => {
      const c = rowData(row); if (!c) return;
      state.rows.set(c.address.toLowerCase(), c);
      enqueue(c, force);
      const score = state.scores.get(c.address.toLowerCase());
      if (score && score.previous > 0 && !row.querySelector(".ri-mini")) {
        const meta = row.querySelector(".col-meta");
        if (meta) { const b = document.createElement("span"); b.className = "ri-mini"; b.textContent = `⚠ ${score.previous} history`; b.title = `${short(score.creator)} has ${score.previous} previous contract(s)`; meta.appendChild(b); }
      }
    });
    render();
  }

  function label(score) { if (score >= 85) return "hot"; if (score >= 65) return "good"; if (score < 40) return "bad"; return ""; }
  function render() {
    const root = document.getElementById(ROOT_ID); if (!root) return;
    const list = [...state.scores.entries()].map(([address, score]) => ({ address, score, c: state.rows.get(address) })).filter(x => x.c).sort((a,b) => b.score.alpha - a.score.alpha).slice(0, MAX_HOT);
    const queue = document.getElementById("riQueue");
    if (queue) queue.innerHTML = list.length ? list.map((x,i) => `<div class="ri-hot"><div class="ri-rank">${i+1}</div><div><div class="ri-name">${esc(x.c.name)}</div><div class="ri-sub">${x.score.velocity}/min · ${x.score.accelerationPct >= 0 ? "↑" : "↓"}${Math.abs(x.score.accelerationPct).toFixed(0)}% · ${x.score.smartWallets} smart</div></div><div class="ri-score ${label(x.score.alpha)}">${x.score.alpha}</div></div>`).join("") : `<div class="ri-note" style="padding:12px">Waiting for enough signals…</div>`;
    const top = list[0]?.score;
    const alpha = document.getElementById("riAlpha"); if (alpha) alpha.textContent = top ? `${top.alpha}/100` : "—";
    const hot = document.getElementById("riHot"); if (hot) hot.textContent = String(list.filter(x => x.score.alpha >= 80).length);
    const wallets = document.getElementById("riWallets"); if (wallets) wallets.textContent = String(list.reduce((s,x) => s + x.score.smartWallets, 0));
    const risk = document.getElementById("riRisk"); if (risk) risk.textContent = String(list.filter(x => x.score.risk >= 35).length);
    const latency = document.getElementById("riLatency"); if (latency) { const l = state.latency.slice(-10); latency.textContent = l.length ? `${Math.round(l.reduce((a,b)=>a+b,0)/l.length)}ms` : "—"; }
    const status = document.getElementById("riStatus"); if (status) status.textContent = state.active ? `scanning ${state.active}` : `${list.length} ranked`;
    const sig = document.getElementById("riSignals");
    if (sig && top) sig.innerHTML = `<div class="ri-metric"><span>Velocity</span><b>${top.velocity}/min</b></div><div class="ri-metric"><span>Acceleration</span><b>${top.accelerationPct >= 0 ? "+" : ""}${top.accelerationPct.toFixed(0)}%</b></div><div class="ri-metric"><span>Creator history</span><b>${top.previous}</b></div><div class="ri-metric"><span>Holder concentration</span><b>${top.holderConcentration == null ? "—" : top.holderConcentration.toFixed(1)+"%"}</b></div><div class="ri-metric"><span>Contract</span><b>${top.verified ? (top.proxy ? "verified / proxy" : "verified") : "unverified"}</b></div><div class="ri-metric"><span>Risk</span><b>${top.risk}/70</b></div>`;
  }

  function renderJournal() {
    const el = document.getElementById("riJournalList"); if (!el) return;
    el.innerHTML = state.journal.length ? state.journal.slice().reverse().slice(0,50).map(x => `<div class="ri-log"><b>${esc(x.action)}</b> · ${esc(x.name)} · score ${esc(x.score)} · ${new Date(x.at).toLocaleString()}</div>`).join("") : `<div class="ri-note">No decisions logged yet.</div>`;
  }
  function logTop() {
    const top = [...state.scores.entries()].map(([address,score])=>({address,score,c:state.rows.get(address)})).filter(x=>x.c).sort((a,b)=>b.score.alpha-a.score.alpha)[0];
    if (!top) return;
    state.journal.push({ at: Date.now(), action: "WATCH", name: top.c.name, address: top.address, score: top.score.alpha });
    state.journal = state.journal.slice(-200); saveJson(JOURNAL_KEY, state.journal); renderJournal();
  }

  function start() {
    ensureStyles(); insertUI();
    const collections = document.getElementById("collections");
    if (!collections) { state.timer = setTimeout(start, 700); return; }
    state.observer = new MutationObserver(() => scanRows(false));
    state.observer.observe(collections, { childList: true, subtree: true });
    scanRows(false);
    const loop = () => { scanRows(false); state.timer = setTimeout(loop, ROW_SCAN_MS); };
    loop();
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (state.timer) clearTimeout(state.timer); } else { scanRows(false); state.timer = setTimeout(loop, 1000); } });
  }

  window.addEventListener("beforeunload", () => { if (state.timer) clearTimeout(state.timer); state.observer?.disconnect(); }, { once: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
