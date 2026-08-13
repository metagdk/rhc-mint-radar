/*
 * Mint Radar — isolated creator-history warning layer.
 * Does not touch the existing mint poller or ranking logic.
 * Uses only public Blockscout v2 endpoints.
 */
(() => {
  "use strict";

  const API = "https://robinhoodchain.blockscout.com/api/v2";
  const CHECK_INTERVAL_MS = 2500;
  const REQUEST_TIMEOUT_MS = 9000;
  const MAX_CREATOR_PAGES = 3;
  const MAX_CONCURRENT = 2;

  const cache = new Map();
  const queued = new Set();
  const queue = [];
  let active = 0;
  let observer = null;
  let loopTimer = null;

  const validAddress = (v) => typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getCreator(contract) {
    const info = await fetchJson(`${API}/addresses/${encodeURIComponent(contract)}`);
    const creator = info?.creator_address_hash;
    return validAddress(creator) ? creator : null;
  }

  // Internal transactions expose created_contract directly. This is more reliable than
  // guessing from normal transaction types and is the Blockscout v2 endpoint intended for it.
  async function getPreviousCollections(creator, currentContract) {
    const found = [];
    let next = null;

    for (let page = 0; page < MAX_CREATOR_PAGES; page += 1) {
      let url = `${API}/addresses/${encodeURIComponent(creator)}/internal-transactions?filter=from`;
      if (next) {
        const params = new URLSearchParams();
        Object.entries(next).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
        });
        url += `&${params}`;
      }

      const data = await fetchJson(url);
      for (const tx of data?.items || []) {
        const created = tx?.created_contract;
        const address = created?.hash;
        if (!validAddress(address) || address.toLowerCase() === currentContract.toLowerCase()) continue;
        if (!found.some((x) => x.address.toLowerCase() === address.toLowerCase())) {
          found.push({
            address,
            name: created.name || null,
            txHash: tx.transaction_hash || null,
            timestamp: tx.timestamp || null,
          });
        }
      }

      next = data?.next_page_params || null;
      if (!next || found.length >= 20) break;
    }

    return found;
  }

  async function scan(contract) {
    const key = contract.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.checkedAt < 15 * 60 * 1000) return cached;

    try {
      const creator = await getCreator(contract);
      if (!creator) {
        const result = { status: "unknown", checkedAt: Date.now() };
        cache.set(key, result);
        return result;
      }
      const previous = await getPreviousCollections(creator, contract);
      const result = { status: "ok", checkedAt: Date.now(), creator, previous, count: previous.length };
      cache.set(key, result);
      return result;
    } catch {
      // Do not disturb the mint tracker if Blockscout is temporarily unavailable.
      const result = { status: "error", checkedAt: Date.now() };
      cache.set(key, result);
      return result;
    }
  }

  function ensureStyles() {
    if (document.getElementById("creator-history-style")) return;
    const style = document.createElement("style");
    style.id = "creator-history-style";
    style.textContent = `
      .chip.creator-history-warning{color:#ffd166;border-color:rgba(255,209,102,.35);background:rgba(255,209,102,.08);cursor:help}
      .creator-history-tooltip{position:fixed;z-index:9999;max-width:min(360px,calc(100vw - 24px));padding:10px 12px;border:1px solid rgba(255,209,102,.25);border-radius:10px;background:rgba(8,10,16,.97);color:#f4f7fb;box-shadow:0 12px 40px rgba(0,0,0,.35);font:500 12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none}
      .creator-history-tooltip strong{color:#ffd166}.creator-history-tooltip .muted{opacity:.7}
    `;
    document.head.appendChild(style);
  }

  function hideTooltip() { document.getElementById("creator-history-tooltip")?.remove(); }

  function showTooltip(target, result) {
    hideTooltip();
    const tip = document.createElement("div");
    tip.className = "creator-history-tooltip";
    tip.id = "creator-history-tooltip";
    const names = (result.previous || []).slice(0, 5).map((x) => x.name || shortAddress(x.address));
    tip.innerHTML = `<strong>⚠ Creator history</strong><br>${esc(shortAddress(result.creator))} created <strong>${result.count}</strong> previous NFT collection${result.count === 1 ? "" : "s"}.${names.length ? `<br><span class="muted">${esc(names.join(" · "))}${result.count > names.length ? " · …" : ""}</span>` : ""}`;
    document.body.appendChild(tip);
    const rect = target.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - tip.offsetWidth - 8));
    const top = rect.bottom + 8 + tip.offsetHeight <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - tip.offsetHeight - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function applyResult(row, result) {
    const meta = row.querySelector(".col-meta");
    if (!meta || meta.querySelector(".creator-history-warning")) return;
    if (result?.status !== "ok" || !result.count) return;

    const badge = document.createElement("span");
    badge.className = "chip creator-history-warning";
    badge.textContent = `⚠ ${result.count} previous`;
    badge.title = `Creator ${shortAddress(result.creator)} has ${result.count} previous NFT collection${result.count === 1 ? "" : "s"}`;
    badge.setAttribute("aria-label", badge.title);
    badge.tabIndex = 0;
    badge.addEventListener("mouseenter", () => showTooltip(badge, result));
    badge.addEventListener("mouseleave", hideTooltip);
    badge.addEventListener("focus", () => showTooltip(badge, result));
    badge.addEventListener("blur", hideTooltip);
    meta.appendChild(badge);
  }

  function enqueue(contract, row) {
    if (!validAddress(contract)) return;
    const key = contract.toLowerCase();
    if (queued.has(key)) return;
    const cached = cache.get(key);
    if (cached && cached.status === "ok") { applyResult(row, cached); return; }
    queued.add(key);
    queue.push({ contract, row });
    drain();
  }

  async function drain() {
    while (active < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      active += 1;
      scan(job.contract)
        .then((result) => { if (job.row.isConnected) applyResult(job.row, result); })
        .finally(() => { active -= 1; queued.delete(job.contract.toLowerCase()); drain(); });
    }
  }

  function scanVisibleRows() {
    const root = document.getElementById("collections");
    if (!root) return;
    root.querySelectorAll("article.rank-row[data-addr]").forEach((row) => enqueue(row.getAttribute("data-addr"), row));
  }

  function start() {
    ensureStyles();
    const root = document.getElementById("collections");
    if (!root) { loopTimer = setTimeout(start, 500); return; }
    observer = new MutationObserver(scanVisibleRows);
    observer.observe(root, { childList: true, subtree: true });
    scanVisibleRows();
    const loop = () => { scanVisibleRows(); loopTimer = setTimeout(loop, CHECK_INTERVAL_MS); };
    loop();
  }

  window.addEventListener("beforeunload", () => { if (loopTimer) clearTimeout(loopTimer); observer?.disconnect(); }, { once: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
