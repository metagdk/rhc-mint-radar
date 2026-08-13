/* RHC Mint Radar — hard mint-destination guard.
 * This file runs before app.js and removes Blockscout write-contract navigation.
 * It replaces the generated Mint anchor with a safe button until a real destination
 * has been resolved. This prevents app.js re-renders from ever restoring the bad href.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS_V8__) return;
  window.__RHC_MINT_LINKS_V8__ = true;

  const EXPLORER_HOST = "robinhoodchain.blockscout.com";
  const EXPLORER = `https://${EXPLORER_HOST}`;
  const API = `${EXPLORER}/api/v2`;
  const cache = new Map();
  const pending = new Map();
  const CACHE_MS = 10 * 60 * 1000;
  const RESOLVE_TIMEOUT = 7000;

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

  function rowOf(el) {
    return el?.closest?.("[data-addr]");
  }

  function rowName(row) {
    return (row?.querySelector(".col-name, .collection-name, [data-collection-name]")?.textContent || row?.dataset?.collectionName || "")
      .replace(/\s+/g, " ").trim();
  }

  function mintAnchor(row) {
    if (!row) return null;
    return [...row.querySelectorAll("a.btn.primary, .cell-act a")]
      .find(el => /^\s*mint\s*$/i.test(el.textContent || "")) || null;
  }

  function isMintControl(el) {
    return !!el && /^\s*mint\s*$/i.test(el.textContent || "");
  }

  async function json(url, timeout = RESOLVE_TIMEOUT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function metadataUrls(value) {
    if (!value || typeof value !== "object") return [];
    const keys = [
      "mint_url","mintUrl","mint_page","mintPage","mint_website","mintWebsite",
      "mint_site","mintSite","claim_url","claimUrl","claim_page","claimPage",
      "launchpad_url","launchpadUrl","launchpad","launch_page","launchPage",
      "sale_url","saleUrl","presale_url","presaleUrl","drop_url","dropUrl",
      "public_sale_url","publicSaleUrl"
    ];
    const out = [];
    for (const key of keys) {
      const u = safeUrl(value[key]);
      if (u) out.push(u);
    }
    if (Array.isArray(value.attributes)) {
      for (const a of value.attributes) {
        if (/mint|claim|launch|sale|drop|presale/i.test(String(a?.trait_type || a?.key || ""))) {
          const u = safeUrl(a?.value);
          if (u) out.push(u);
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
      const mintCandidates = [
        ...metadataUrls(token?.metadata),
        ...metadataUrls(token),
        ...(instances?.items || []).flatMap(x => [...metadataUrls(x), ...metadataUrls(x?.metadata)])
      ];
      const siteCandidates = [];
      for (const x of [token, ...(instances?.items || [])]) {
        for (const v of [x?.external_app_url, x?.external_url, x?.website, x?.homepage, x?.project_url, x?.metadata?.external_url]) {
          const u = safeUrl(v);
          if (u) siteCandidates.push(u);
        }
      }
      return { mint: mintCandidates[0] || null, site: siteCandidates[0] || null };
    } catch {
      return { mint: null, site: null };
    }
  }

  async function marketplaceResolve(address, name) {
    try {
      const q = new URLSearchParams();
      if (address) q.set("address", address);
      if (name) q.set("name", name);
      const r = await json(`/api/marketplace?${q.toString()}`, RESOLVE_TIMEOUT);
      const u = safeUrl(r?.url);
      if (r?.found && u) return { url: u, label: "OpenSea", source: r.source || "marketplace" };
    } catch {}
    return null;
  }

  async function verifyOpenSeaSlug(name) {
    const slug = slugify(name);
    if (!slug) return null;
    const url = `https://opensea.io/collection/${encodeURIComponent(slug)}`;
    try {
      const r = await fetch(url, { method: "HEAD", redirect: "manual", cache: "no-store" });
      if (r.status >= 200 && r.status < 400) return { url, label: "OpenSea", source: "verified-slug" };
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

      const verified = await verifyOpenSeaSlug(name);
      if (verified) return verified;

      return null;
    })();

    pending.set(key, p);
    try {
      const data = await Promise.race([
        p,
        new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), RESOLVE_TIMEOUT + 800))
      ]);
      cache.set(key, { at: Date.now(), data });
      return data;
    } finally {
      pending.delete(key);
    }
  }

  function makeSafeMintButton(anchor) {
    if (!anchor || !anchor.parentNode) return anchor;
    if (anchor.dataset.rhcSafeMint === "1") return anchor;

    const button = document.createElement("button");
    button.type = "button";
    button.className = anchor.className;
    button.textContent = "Mint";
    for (const name of anchor.getAttributeNames()) {
      if (["href", "target", "rel", "onclick"].includes(name)) continue;
      if (name === "class") continue;
      const value = anchor.getAttribute(name);
      if (value != null) button.setAttribute(name, value);
    }
    button.dataset.rhcSafeMint = "1";
    button.dataset.mintPending = "1";
    button.title = "Resolving mint destination…";
    anchor.replaceWith(button);
    return button;
  }

  function installSideLink(row, result) {
    if (!row || !result?.url) return;
    let side = row.querySelector(".mint-location-link");
    if (!side) {
      const meta = row.querySelector(".col-meta");
      if (!meta) return;
      side = document.createElement("a");
      side.className = "mint-location-link";
      meta.appendChild(side);
    }
    side.href = result.url;
    side.target = "_blank";
    side.rel = "noopener noreferrer";
    side.textContent = result.label === "Mint" ? "↗ Mint" : result.label === "Site" ? "↗ Site" : "↗ OpenSea";
    side.title = result.url;
  }

  async function prepareRow(row) {
    if (!row?.dataset?.addr) return;
    let button = mintAnchor(row);
    if (!button) return;
    if (isBlocked(button.getAttribute("href") || button.href || "")) {
      button = makeSafeMintButton(button);
    }
    if (!button || button.dataset.mintResolved === "1" || button.dataset.mintResolving === "1") return;

    button.dataset.mintResolving = "1";
    button.disabled = false;
    button.title = "Resolving mint destination…";

    const result = await resolve(row.dataset.addr, rowName(row));
    if (!document.contains(row)) return;
    const current = mintAnchor(row) || row.querySelector("button[data-rhc-safe-mint=\"1\"]");
    if (!current) return;

    if (result?.url && !isBlocked(result.url)) {
      current.dataset.mintResolved = "1";
      current.dataset.mintSource = result.source || "resolved";
      current.dataset.mintUrl = result.url;
      current.dataset.mintLabel = result.label || "Mint";
      current.title = result.url;
      installSideLink(row, result);
    } else {
      current.dataset.mintUnavailable = "1";
      current.title = "No verified mint/marketplace destination found";
    }
    delete current.dataset.mintResolving;
  }

  function sanitize(root = document) {
    root.querySelectorAll?.("#collections [data-addr] .cell-act a.btn.primary, #feed [data-addr] a").forEach(anchor => {
      if (!isMintControl(anchor)) return;
      const href = anchor.getAttribute("href") || anchor.href || "";
      if (isBlocked(href)) makeSafeMintButton(anchor);
    });
  }

  async function handleMint(event) {
    const target = event.target?.closest?.("button[data-rhc-safe-mint], a.btn.primary");
    if (!target || !isMintControl(target)) return;
    const row = rowOf(target);
    if (!row?.dataset?.addr) return;

    const href = target.dataset.mintUrl || target.getAttribute("href") || target.href || "";
    const resolved = target.dataset.mintResolved === "1" && safeUrl(href) && !isBlocked(href);

    // If app.js somehow recreated a bad anchor, block it unconditionally.
    if (isBlocked(href) || !resolved) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    if (resolved) return;
    if (target.dataset.rhcClickBusy === "1") return;
    target.dataset.rhcClickBusy = "1";
    const old = target.textContent;
    target.textContent = "Resolving…";

    let popup = null;
    try {
      popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    } catch {}

    try {
      const result = await resolve(row.dataset.addr, rowName(row));
      if (result?.url && !isBlocked(result.url)) {
        target.dataset.mintResolved = "1";
        target.dataset.mintUrl = result.url;
        target.dataset.mintSource = result.source || "resolved";
        target.title = result.url;
        installSideLink(row, result);
        if (popup && !popup.closed) popup.location.replace(result.url);
        else window.open(result.url, "_blank", "noopener,noreferrer");
      } else if (popup && !popup.closed) {
        popup.close();
      }
    } finally {
      target.textContent = old;
      target.dataset.rhcClickBusy = "0";
    }
  }

  // Capture multiple input paths. This makes navigation impossible even if another
  // listener is attached by the mint engine or a row is re-rendered.
  for (const type of ["click", "auxclick", "pointerdown"]) {
    document.addEventListener(type, event => {
      const target = event.target?.closest?.("button[data-rhc-safe-mint], a.btn.primary");
      if (!target || !isMintControl(target)) return;
      const href = target.dataset.mintUrl || target.getAttribute("href") || target.href || "";
      if (isBlocked(href) || target.dataset.mintResolved !== "1") {
        event.preventDefault();
        if (type !== "pointerdown") event.stopImmediatePropagation();
      }
      if (type === "click") handleMint(event).catch(() => {});
    }, true);
  }

  function scan() {
    sanitize(document);
    document.querySelectorAll("#collections [data-addr]").forEach(row => prepareRow(row).catch(() => {}));
  }

  function boot() {
    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "class"]
    });
    setInterval(() => { if (!document.hidden) scan(); }, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
