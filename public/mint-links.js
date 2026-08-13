/* RHC Mint Radar — real mint-location resolver.
 * Priority: explicit mint/launchpad metadata -> project site -> OpenSea collection.
 * Never falls back to Blockscout contract-write URLs.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS_V3__) return;
  window.__RHC_MINT_LINKS_V3__ = true;

  const EXPLORER_HOST = "robinhoodchain.blockscout.com";
  const API = `https://${EXPLORER_HOST}/api/v2`;
  const OPEN_SEA = "https://opensea.io/collection/";
  const cache = new Map();
  const pending = new Set();
  const MAX_CONCURRENT = 3;
  const KNOWN_MINT_HOSTS = [
    "launchmynft.io", "heymint.xyz", "mint.fun", "manifold.xyz",
    "thirdweb.com", "zora.co", "highlight.xyz", "premint.xyz",
    "mintgate.io", "nftport.xyz", "foundation.app"
  ];
  const MINT_KEYS = /(^|_)(mint|minting|mintpage|mint_page|claim|claimpage|claim_page|launchpad|launch_page|drop|sale|presale|presale_page|public_sale)(_|$)/i;
  const MINT_TEXT = /(^|[/.\\-_])(mint|minting|claim|launchpad|drop|presale|sale)([/.\\-_]|$)/i;

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const u = new URL(value.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      if (u.hostname.toLowerCase() === EXPLORER_HOST) return null;
      return u.href;
    } catch { return null; }
  }
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
  }
  function knownMintHost(url) {
    const host = hostOf(url);
    return KNOWN_MINT_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  }
  function likelyMintUrl(url) {
    return !!url && (knownMintHost(url) || MINT_TEXT.test(url.toLowerCase()));
  }
  function normalizeCandidate(value) {
    const url = safeUrl(value);
    if (!url) return null;
    return { url, confidence: likelyMintUrl(url) ? "high" : "medium" };
  }

  function collectionName(row) {
    if (!row) return "";
    const el = row.querySelector(".col-copy .name, .col-copy h3, .collection-name, [data-collection-name]");
    return (el?.textContent || row.dataset.collectionName || "").replace(/\s+/g, " ").trim();
  }

  // OpenSea uses a human-readable collection slug. There is no on-chain
  // canonical OpenSea slug, so we generate conservative candidates from
  // the collection name and only use this as a marketplace fallback.
  function openSeaSlugCandidates(name) {
    const raw = String(name || "").trim();
    if (!raw) return [];
    const base = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[’'`]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .toLowerCase();
    if (!base) return [];
    const compact = base.replace(/-/g, "");
    return [...new Set([base, compact])].slice(0, 2);
  }

  function openSeaCandidate(name) {
    const slug = openSeaSlugCandidates(name)[0];
    return slug ? { url: `${OPEN_SEA}${encodeURIComponent(slug)}`, confidence: "low", source: "opensea-name" } : null;
  }

  function inspectMetadata(meta) {
    if (!meta || typeof meta !== "object") return { mint: null, site: null, openSea: null };
    const candidates = [];
    const push = (value, source, explicit = false) => {
      const c = normalizeCandidate(value);
      if (c) candidates.push({ ...c, source, explicit });
    };
    const keys = [
      "mint_url", "mintUrl", "mint_page", "mintPage", "mint_website", "mintWebsite", "mint_site", "mintSite",
      "claim_url", "claimUrl", "claim_page", "claimPage", "launchpad_url", "launchpadUrl", "launchpad",
      "launch_page", "launchPage", "sale_url", "saleUrl", "presale_url", "presaleUrl", "drop_url", "dropUrl",
      "public_sale_url", "publicSaleUrl"
    ];
    for (const key of keys) if (meta[key]) push(meta[key], key, true);
    if (Array.isArray(meta.attributes)) {
      for (const a of meta.attributes) {
        const key = String(a?.trait_type || a?.key || "").trim();
        if (key && a?.value != null && MINT_KEYS.test(key)) push(String(a.value), key, true);
      }
    }
    push(meta.external_app_url, "external_app_url");
    push(meta.home_url, "home_url");
    push(meta.external_url, "external_url");
    if (meta.metadata && meta.metadata !== meta) {
      const nested = inspectMetadata(meta.metadata);
      if (nested.mint) candidates.push({ ...nested.mint, source: `nested:${nested.mint.source}` });
      if (nested.site) candidates.push({ ...nested.site, source: `nested:${nested.site.source}` });
    }
    return {
      mint: candidates.find((c) => c.explicit || c.confidence === "high") || null,
      site: candidates.find((c) => c.url && !likelyMintUrl(c.url)) || null
    };
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  async function resolve(address, name) {
    const key = String(address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(key)) return null;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
    if (pending.has(key) || pending.size >= MAX_CONCURRENT) return null;
    pending.add(key);
    try {
      const data = await fetchJson(`${API}/tokens/${encodeURIComponent(address)}/instances?limit=8`);
      let mint = null, site = null;
      for (const item of data?.items || []) {
        for (const meta of [item, item?.metadata]) {
          const found = inspectMetadata(meta);
          if (!mint && found.mint) mint = found.mint;
          if (!site && found.site) site = found.site;
        }
        if (mint) break;
      }
      // If the collection is represented on OpenSea but doesn't expose a
      // launchpad URL in metadata, its OpenSea collection page is the useful
      // marketplace/mint destination. This is intentionally last priority.
      const openSea = openSeaCandidate(name);
      const result = { mint, site, openSea };
      cache.set(key, { at: Date.now(), data: result });
      return result;
    } catch {
      // Still provide the deterministic OpenSea candidate when the explorer
      // metadata request is temporarily unavailable.
      const result = { mint: null, site: null, openSea: openSeaCandidate(name) };
      cache.set(key, { at: Date.now(), data: result });
      return result;
    } finally { pending.delete(key); }
  }

  function setAnchor(anchor, url, label, disabled = false) {
    if (!anchor) return;
    if (disabled || !url) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
      anchor.classList.add("disabled");
      anchor.textContent = label;
      anchor.setAttribute("aria-disabled", "true");
      anchor.title = "No verified mint location found";
      return;
    }
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.classList.remove("disabled");
    anchor.removeAttribute("aria-disabled");
    anchor.textContent = label;
    anchor.title = label === "Mint" ? "Open detected mint / launchpad" : label === "OpenSea" ? "Open collection on OpenSea" : "Open project site";
  }

  function addSideLink(row, url, label) {
    const copy = row.querySelector(".col-copy");
    if (!copy || !url) return;
    let link = copy.querySelector(".mint-location-link");
    if (!link) {
      link = document.createElement("a");
      link.className = "mint-location-link";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      (copy.querySelector(".col-meta") || copy).appendChild(link);
    }
    link.href = url;
    link.textContent = label === "Mint" ? "↗ Mint" : label === "OpenSea" ? "↗ OpenSea" : "↗ Site";
    link.title = label === "Mint" ? "Open detected mint / launchpad" : label === "OpenSea" ? "Open collection on OpenSea" : "Open project site";
  }

  async function processRow(row) {
    if (!row || row.dataset.mintLocationResolved === "1" || row.dataset.mintLocationProcessing === "1") return;
    const address = row.dataset.addr;
    if (!address) return;
    row.dataset.mintLocationProcessing = "1";
    const primary = row.querySelector(".cell-act a.btn.primary");
    const result = await resolve(address, collectionName(row));
    if (!document.contains(row)) return;
    row.dataset.mintLocationProcessing = "0";
    if (result === null && !cache.has(String(address).toLowerCase())) return;

    const mint = result?.mint?.url || null;
    const site = result?.site?.url || null;
    const openSea = result?.openSea?.url || null;

    if (mint) {
      setAnchor(primary, mint, "Mint");
      addSideLink(row, mint, "Mint");
    } else if (site) {
      setAnchor(primary, site, "Site");
      addSideLink(row, site, "Site");
    } else if (openSea) {
      setAnchor(primary, openSea, "OpenSea");
      addSideLink(row, openSea, "OpenSea");
    } else {
      setAnchor(primary, null, "Mint unavailable", true);
      row.querySelector(".mint-location-link")?.remove();
    }
    row.dataset.mintLocationResolved = "1";
  }

  function processFeed() {
    document.querySelectorAll("#feed .feed-item").forEach((item) => {
      const mint = item.querySelector(".feed-links a:last-child");
      if (mint && (mint.href || "").includes(EXPLORER_HOST) && (mint.href || "").includes("write_contract")) mint.remove();
    });
  }

  function scan(root = document) {
    root.querySelectorAll("#collections .rank-row[data-addr]").forEach((row) => processRow(row).catch(() => { row.dataset.mintLocationProcessing = "0"; }));
    processFeed();
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
