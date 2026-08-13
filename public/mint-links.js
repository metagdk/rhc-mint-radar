/* RHC Mint Radar — mint destination resolver.
 * Never allows the default Blockscout write-contract action to be used as a mint destination.
 * Resolution order: explicit mint/launchpad -> verified marketplace -> verified project site.
 * A click on the native Mint button is intercepted until a safe destination is resolved.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS_V5__) return;
  window.__RHC_MINT_LINKS_V5__ = true;

  const EXPLORER_HOST = "robinhoodchain.blockscout.com";
  const EXPLORER = `https://${EXPLORER_HOST}`;
  const API = `${EXPLORER}/api/v2`;
  const cache = new Map();
  const pending = new Map();
  const CACHE_MS = 10 * 60 * 1000;
  const CLICK_TIMEOUT = 7000;

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const u = new URL(value.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (host === EXPLORER_HOST) return null;
      if (host === "opensea.io" && path.includes("write_contract")) return null;
      return u.href;
    } catch { return null; }
  }

  function isBadExplorerMint(url) {
    try {
      const u = new URL(url || "", window.location.href);
      return u.hostname.toLowerCase() === EXPLORER_HOST && /write_contract/i.test(u.search + u.pathname);
    } catch { return false; }
  }

  function fetchJson(url, timeout = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    }).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).finally(() => clearTimeout(timer));
  }

  function rowName(row) {
    return (row?.querySelector(".col-copy .name, .col-copy h3, .collection-name, [data-collection-name]")?.textContent || row?.dataset?.collectionName || "")
      .replace(/\s+/g, " ").trim();
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ").replace(/[’'`]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-").toLowerCase();
  }

  function metadataCandidates(meta) {
    if (!meta || typeof meta !== "object") return [];
    const out = [];
    const keys = [
      "mint_url","mintUrl","mint_page","mintPage","mint_website","mintWebsite","mint_site","mintSite",
      "claim_url","claimUrl","claim_page","claimPage","launchpad_url","launchpadUrl","launchpad",
      "launch_page","launchPage","sale_url","saleUrl","presale_url","presaleUrl","drop_url","dropUrl",
      "public_sale_url","publicSaleUrl","external_app_url","external_url","website","homepage","project_url"
    ];
    for (const key of keys) {
      const url = safeUrl(meta[key]);
      if (url) out.push({ url, key, explicit: /mint|claim|launch|sale|drop|presale/i.test(key) });
    }
    if (Array.isArray(meta.attributes)) {
      for (const a of meta.attributes) {
        const key = String(a?.trait_type || a?.key || "");
        const url = safeUrl(a?.value);
        if (url && /mint|claim|launch|sale|drop|presale/i.test(key)) out.push({ url, key, explicit: true });
      }
    }
    if (meta.metadata && meta.metadata !== meta) out.push(...metadataCandidates(meta.metadata));
    return out;
  }

  async function metadataResolve(address) {
    try {
      // Token-level data is important: external_app_url/external_url often lives here,
      // while the instance endpoint may only expose NFT metadata.
      const [token, instances] = await Promise.all([
        fetchJson(`${API}/tokens/${encodeURIComponent(address)}`).catch(() => null),
        fetchJson(`${API}/tokens/${encodeURIComponent(address)}/instances?limit=8`).catch(() => null)
      ]);
      const candidates = [
        ...metadataCandidates(token?.metadata),
        ...metadataCandidates(token),
        ...(instances?.items || []).flatMap(item => [
          ...metadataCandidates(item),
          ...metadataCandidates(item?.metadata)
        ])
      ];
      return {
        mint: candidates.find(c => c.explicit) || null,
        site: candidates.find(c => !c.explicit) || null
      };
    } catch {
      return { mint: null, site: null };
    }
  }

  async function marketplaceResolve(address, name) {
    const qs = new URLSearchParams();
    if (address) qs.set("address", address);
    if (name) qs.set("name", name);
    try {
      const r = await fetchJson(`/api/marketplace?${qs.toString()}`, 6500);
      const url = safeUrl(r?.url);
      if (r?.found && url && !isBadExplorerMint(url)) return { url, source: r.source || "marketplace" };
    } catch {}
    return null;
  }

  async function resolve(address, name) {
    const key = `${String(address || "").toLowerCase()}|${String(name || "").toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
    if (pending.has(key)) return pending.get(key);

    const promise = (async () => {
      const metadata = await metadataResolve(address);
      if (metadata.mint) {
        const data = { url: metadata.mint.url, label: "Mint", source: "metadata" };
        cache.set(key, { at: Date.now(), data });
        return data;
      }

      const marketplace = await marketplaceResolve(address, name);
      if (marketplace) {
        const data = { url: marketplace.url, label: "OpenSea", source: marketplace.source };
        cache.set(key, { at: Date.now(), data });
        return data;
      }

      // Last resort: only offer a human-friendly OpenSea collection URL when a
      // real collection name exists. This is deliberately never a Blockscout URL.
      const slug = slugify(name);
      if (slug) {
        const data = { url: `https://opensea.io/collection/${encodeURIComponent(slug)}`, label: "OpenSea", source: "name-fallback" };
        cache.set(key, { at: Date.now(), data });
        return data;
      }

      if (metadata.site) {
        const data = { url: metadata.site.url, label: "Site", source: "metadata" };
        cache.set(key, { at: Date.now(), data });
        return data;
      }
      const data = null;
      cache.set(key, { at: Date.now(), data });
      return data;
    })();

    pending.set(key, promise);
    try { return await promise; }
    finally { pending.delete(key); }
  }

  function getRow(target) {
    return target?.closest?.("[data-addr], .rank-row, article");
  }

  function getMintButton(row) {
    if (!row) return null;
    const candidates = row.querySelectorAll("a,button");
    for (const el of candidates) {
      if (/^\s*mint\s*$/i.test(el.textContent || "")) return el;
    }
    return row.querySelector(".cell-act a.btn.primary, .cell-act button.btn.primary");
  }

  function setDestination(button, result) {
    if (!button || !result?.url) return false;
    const url = safeUrl(result.url);
    if (!url || isBadExplorerMint(url)) return false;
    if (button.tagName === "A") {
      button.href = url;
      button.target = "_blank";
      button.rel = "noopener noreferrer";
    } else {
      button.dataset.mintUrl = url;
    }
    button.dataset.mintResolved = "1";
    button.dataset.mintSource = result.source || "unknown";
    if (result.label === "OpenSea") button.title = "Open verified/likely OpenSea collection";
    return true;
  }

  async function resolveForRow(row) {
    const address = row?.dataset?.addr;
    if (!address) return null;
    return resolve(address, rowName(row));
  }

  // Critical fix: intercept the native button before its Blockscout write-contract
  // href can fire. This also handles a user clicking immediately after a new row appears.
  document.addEventListener("click", async (event) => {
    const target = event.target?.closest?.("a,button");
    if (!target || !/^\s*mint\s*$/i.test(target.textContent || "")) return;
    const row = getRow(target);
    if (!row?.dataset?.addr) return;
    const href = target.getAttribute("href") || target.href || "";
    if (!isBadExplorerMint(href) && target.dataset.mintResolved === "1") return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (target.dataset.mintResolving === "1") return;
    target.dataset.mintResolving = "1";
    const original = target.textContent;
    target.textContent = "Resolving…";
    try {
      const result = await Promise.race([
        resolveForRow(row),
        new Promise(resolve => setTimeout(() => resolve(null), CLICK_TIMEOUT))
      ]);
      if (result?.url && setDestination(target, result)) {
        // Preserve the user's click intent after asynchronous resolution.
        window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        target.title = "No verified mint/collection destination found";
      }
    } finally {
      target.textContent = original;
      target.dataset.mintResolving = "0";
    }
  }, true);

  async function processRow(row) {
    if (!row || row.dataset.mintLocationProcessing === "1") return;
    const address = row.dataset.addr;
    if (!address) return;
    const button = getMintButton(row);
    if (!button) return;
    // Never leave the dangerous write-contract URL as an active destination.
    if (isBadExplorerMint(button.getAttribute("href") || button.href || "")) {
      button.removeAttribute("href");
      button.dataset.mintPending = "1";
    }
    row.dataset.mintLocationProcessing = "1";
    try {
      const result = await resolveForRow(row);
      if (!document.contains(row) || !result?.url) return;
      setDestination(button, result);
      let side = row.querySelector(".mint-location-link");
      if (!side) {
        const copy = row.querySelector(".col-copy");
        const meta = copy?.querySelector(".col-meta") || copy;
        if (meta) {
          side = document.createElement("a");
          side.className = "mint-location-link";
          side.target = "_blank";
          side.rel = "noopener noreferrer";
          meta.appendChild(side);
        }
      }
      if (side) {
        side.href = result.url;
        side.textContent = result.label === "Mint" ? "↗ Mint" : result.label === "OpenSea" ? "↗ OpenSea" : "↗ Site";
        side.title = result.url;
      }
    } finally {
      row.dataset.mintLocationProcessing = "0";
    }
  }

  function scan() {
    document.querySelectorAll("#collections [data-addr]").forEach(row => processRow(row).catch(() => {}));
    document.querySelectorAll("#feed a[href]").forEach(link => {
      if (isBadExplorerMint(link.href)) link.removeAttribute("href");
    });
  }

  function boot() {
    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("beforeunload", () => observer.disconnect(), { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
