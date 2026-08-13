/* RHC Mint Radar — authoritative mint-destination guard.
 * IMPORTANT: this file must run before app.js. It owns Mint-button navigation.
 * A Blockscout write-contract URL is NEVER an allowed mint destination.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS_V6__) return;
  window.__RHC_MINT_LINKS_V6__ = true;

  const EXPLORER_HOST = "robinhoodchain.blockscout.com";
  const EXPLORER = `https://${EXPLORER_HOST}`;
  const API = `${EXPLORER}/api/v2`;
  const cache = new Map();
  const pending = new Map();
  const CACHE_MS = 10 * 60 * 1000;
  const RESOLVE_TIMEOUT = 6500;

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const u = new URL(value.trim(), location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      if (u.hostname.toLowerCase() === EXPLORER_HOST) return null;
      return u.href;
    } catch { return null; }
  }

  function isBlocked(url) {
    try {
      const u = new URL(url || "", location.href);
      return u.hostname.toLowerCase() === EXPLORER_HOST && /write_contract/i.test(`${u.pathname}${u.search}`);
    } catch { return false; }
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ").replace(/[’'`]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-").toLowerCase();
  }

  function rowName(row) {
    return (row?.querySelector(".col-name, .collection-name, [data-collection-name]")?.textContent || row?.dataset?.collectionName || "")
      .replace(/\s+/g, " ").trim();
  }

  function getButton(row) {
    if (!row) return null;
    return [...row.querySelectorAll("a,button")].find(el => /^\s*mint\s*$/i.test(el.textContent || "")) ||
      row.querySelector(".cell-act .btn.primary");
  }

  async function json(url, timeout = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function metadataUrls(value) {
    if (!value || typeof value !== "object") return [];
    const keys = [
      "mint_url","mintUrl","mint_page","mintPage","mint_website","mintWebsite","mint_site","mintSite",
      "claim_url","claimUrl","claim_page","claimPage","launchpad_url","launchpadUrl","launchpad",
      "launch_page","launchPage","sale_url","saleUrl","presale_url","presaleUrl","drop_url","dropUrl",
      "public_sale_url","publicSaleUrl"
    ];
    const out = [];
    for (const key of keys) {
      const u = safeUrl(value[key]);
      if (u && !isBlocked(u)) out.push(u);
    }
    if (Array.isArray(value.attributes)) {
      for (const a of value.attributes) {
        if (/mint|claim|launch|sale|drop|presale/i.test(String(a?.trait_type || a?.key || ""))) {
          const u = safeUrl(a?.value);
          if (u && !isBlocked(u)) out.push(u);
        }
      }
    }
    return out;
  }

  async function metadataResolve(address) {
    try {
      const [token, instances] = await Promise.all([
        json(`${API}/tokens/${encodeURIComponent(address)}`).catch(() => null),
        json(`${API}/tokens/${encodeURIComponent(address)}/instances?limit=8`).catch(() => null)
      ]);
      const tokenCandidates = [
        ...metadataUrls(token?.metadata), ...metadataUrls(token),
        ...(instances?.items || []).flatMap(x => [...metadataUrls(x), ...metadataUrls(x?.metadata)])
      ];
      const siteCandidates = [];
      for (const x of [token, ...(instances?.items || [])]) {
        for (const v of [x?.external_app_url, x?.external_url, x?.website, x?.homepage, x?.project_url, x?.metadata?.external_url]) {
          const u = safeUrl(v);
          if (u && !isBlocked(u)) siteCandidates.push(u);
        }
      }
      return { mint: tokenCandidates[0] || null, site: siteCandidates[0] || null };
    } catch { return { mint: null, site: null }; }
  }

  async function marketplaceResolve(address, name) {
    try {
      const q = new URLSearchParams();
      if (address) q.set("address", address);
      if (name) q.set("name", name);
      const r = await json(`/api/marketplace?${q.toString()}`, RESOLVE_TIMEOUT);
      const u = safeUrl(r?.url);
      if (r?.found && u && !isBlocked(u)) return { url: u, label: "OpenSea", source: r.source || "marketplace" };
    } catch {}
    return null;
  }

  async function resolve(address, name) {
    const key = `${String(address).toLowerCase()}|${String(name).toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
    if (pending.has(key)) return pending.get(key);

    const p = (async () => {
      const meta = await metadataResolve(address);
      if (meta.mint) return { url: meta.mint, label: "Mint", source: "metadata" };

      const market = await marketplaceResolve(address, name);
      if (market) return market;

      if (meta.site) return { url: meta.site, label: "Site", source: "metadata" };

      // OpenSea is a common launch destination for these collections. This is a
      // safe marketplace URL, never a contract-write URL. The server resolver is
      // attempted first, so this is only the final marketplace fallback.
      const slug = slugify(name);
      if (slug) return { url: `https://opensea.io/collection/${encodeURIComponent(slug)}`, label: "OpenSea", source: "name-fallback" };
      return null;
    })();

    pending.set(key, p);
    try {
      const data = await Promise.race([
        p,
        new Promise(resolve => setTimeout(() => resolve(null), RESOLVE_TIMEOUT + 500))
      ]);
      cache.set(key, { at: Date.now(), data });
      return data;
    } finally { pending.delete(key); }
  }

  function rowOf(el) { return el?.closest?.("[data-addr], .rank-row, article"); }

  function stripBadLinks(root = document) {
    root.querySelectorAll?.("a[href], button[data-mint-url]").forEach(el => {
      const href = el.getAttribute("href") || el.dataset.mintUrl || "";
      if (isBlocked(href)) {
        el.removeAttribute("href");
        delete el.dataset.mintUrl;
        el.dataset.mintPending = "1";
      }
    });
  }

  async function prepareRow(row) {
    if (!row?.dataset?.addr || row.dataset.mintPreparing === "1") return;
    const button = getButton(row);
    if (!button) return;
    row.dataset.mintPreparing = "1";
    // Strip the dangerous destination SYNCHRONOUSLY before any await.
    if (isBlocked(button.getAttribute("href") || button.href || "")) {
      button.removeAttribute("href");
      button.dataset.mintPending = "1";
    }
    try {
      const result = await resolve(row.dataset.addr, rowName(row));
      if (!document.contains(row) || !result?.url || isBlocked(result.url)) return;
      button.href = result.url;
      button.target = "_blank";
      button.rel = "noopener noreferrer";
      button.dataset.mintResolved = "1";
      button.dataset.mintSource = result.source;
      button.title = result.url;

      let side = row.querySelector(".mint-location-link");
      if (!side) {
        const meta = row.querySelector(".col-meta");
        if (meta) { side = document.createElement("a"); side.className = "mint-location-link"; meta.appendChild(side); }
      }
      if (side) {
        side.href = result.url;
        side.target = "_blank";
        side.rel = "noopener noreferrer";
        side.textContent = result.label === "Mint" ? "↗ Mint" : result.label === "Site" ? "↗ Site" : "↗ OpenSea";
      }
    } finally {
      row.dataset.mintPreparing = "0";
    }
  }

  // Capture-phase guard: even if app.js recreates a Blockscout href, it cannot navigate there.
  document.addEventListener("click", async event => {
    const target = event.target?.closest?.("a,button");
    if (!target || !/^\s*mint\s*$/i.test(target.textContent || "")) return;
    const row = rowOf(target);
    if (!row?.dataset?.addr) return;
    const href = target.getAttribute("href") || target.href || "";
    if (!isBlocked(href) && target.dataset.mintResolved === "1") return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (target.dataset.mintClickBusy === "1") return;
    target.dataset.mintClickBusy = "1";
    const old = target.textContent;
    target.textContent = "Resolving…";
    try {
      const result = await resolve(row.dataset.addr, rowName(row));
      if (result?.url && !isBlocked(result.url)) {
        target.removeAttribute("href");
        window.open(result.url, "_blank", "noopener,noreferrer");
        target.href = result.url;
        target.target = "_blank";
        target.rel = "noopener noreferrer";
        target.dataset.mintResolved = "1";
      } else {
        target.title = "No mint/marketplace destination found";
      }
    } finally {
      target.textContent = old;
      target.dataset.mintClickBusy = "0";
    }
  }, true);

  function scan() {
    stripBadLinks(document);
    document.querySelectorAll("#collections [data-addr]").forEach(row => prepareRow(row).catch(() => {}));
    document.querySelectorAll("#feed [data-addr], #feed article").forEach(row => prepareRow(row).catch(() => {}));
  }

  function boot() {
    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });
    // Defensive heartbeat: if another script restores a Blockscout href, remove it again.
    setInterval(() => { if (!document.hidden) scan(); }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();