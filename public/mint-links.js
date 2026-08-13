/* RHC Mint Radar — verified mint-location resolver.
 * Priority: explicit mint/launchpad metadata -> verified OpenSea collection -> project site.
 * Never uses a Blockscout write-contract URL as a mint destination.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS_V4__) return;
  window.__RHC_MINT_LINKS_V4__ = true;

  const EXPLORER_HOST = "robinhoodchain.blockscout.com";
  const API = `https://${EXPLORER_HOST}/api/v2`;
  const cache = new Map();
  const pending = new Set();
  const MAX_CONCURRENT = 3;
  const CACHE_MS = 10 * 60 * 1000;
  const KNOWN_MINT_HOSTS = [
    "launchmynft.io", "heymint.xyz", "mint.fun", "manifold.xyz",
    "thirdweb.com", "zora.co", "highlight.xyz", "premint.xyz",
    "mintgate.io", "nftport.xyz", "foundation.app"
  ];
  const MINT_KEYS = /(^|_)(mint|minting|mintpage|mint_page|claim|claimpage|claim_page|launchpad|launch_page|drop|sale|presale|presale_page|public_sale)(_|$)/i;
  const MINT_TEXT = /(^|[/.\\-_])(mint|minting|claim|launchpad|drop|presale)([/.\\-_]|$)/i;

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const u = new URL(value.trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      if (u.hostname.toLowerCase() === EXPLORER_HOST) return null;
      if (u.hostname.toLowerCase() === "opensea.io" && u.pathname.includes("write_contract")) return null;
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

  function collectionName(row) {
    if (!row) return "";
    const el = row.querySelector(".col-copy .name, .col-copy h3, .collection-name, [data-collection-name]");
    return (el?.textContent || row.dataset.collectionName || "").replace(/\s+/g, " ").trim();
  }

  function inspectMetadata(meta) {
    if (!meta || typeof meta !== "object") return { mint: null, site: null };
    const candidates = [];
    const push = (value, source, explicit = false) => {
      const url = safeUrl(value);
      if (url) candidates.push({ url, source, explicit, confidence: likelyMintUrl(url) ? "high" : "medium" });
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
    push(meta.external_url, "external_url");
    if (meta.metadata && meta.metadata !== meta) {
      const nested = inspectMetadata(meta.metadata);
      if (nested.mint) candidates.push(nested.mint);
      if (nested.site) candidates.push(nested.site);
    }
    return {
      mint: candidates.find((c) => c.explicit || c.confidence === "high") || null,
      site: candidates.find((c) => !likelyMintUrl(c.url)) || null
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

  async function metadataResolve(address) {
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
      return { mint, site };
    } catch {
      return { mint: null, site: null };
    }
  }

  async function marketplaceResolve(address, name) {
    const params = new URLSearchParams();
    if (address) params.set("address", address);
    if (name) params.set("name", name);
    try {
      const result = await fetchJson(`/api/marketplace?${params.toString()}`);
      return result?.found && safeUrl(result.url) ? { url: result.url, source: result.source || "opensea" } : null;
    } catch {
      return null;
    }
  }

  async function resolve(address, name) {
    const key = `${String(address || "").toLowerCase()}|${String(name || "").toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
    if (pending.has(key) || pending.size >= MAX_CONCURRENT) return null;
    pending.add(key);
    try {
      const metadata = await metadataResolve(address);
      // An explicit mint/claim/launchpad URL is the highest-confidence target.
      if (metadata.mint) {
        const result = { ...metadata, marketplace: null };
        cache.set(key, { at: Date.now(), data: result });
        return result;
      }

      // Resolve the actual OpenSea collection server-side. This is not a
      // guessed slug: the function searches OpenSea and verifies the result.
      const marketplace = await marketplaceResolve(address, name);
      if (marketplace) {
        const result = { mint: null, site: metadata.site, marketplace };
        cache.set(key, { at: Date.now(), data: result });
        return result;
      }

      // If OpenSea does not contain the collection, a real project site is
      // still more useful than a blockchain write-contract screen.
      const result = { mint: null, site: metadata.site, marketplace: null };
      cache.set(key, { at: Date.now(), data: result });
      return result;
    } finally {
      pending.delete(key);
    }
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
    anchor.title = label === "Mint" ? "Open detected mint / launchpad" : label === "OpenSea" ? "Open verified OpenSea collection" : "Open project site";
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
    link.title = label === "Mint" ? "Open detected mint / launchpad" : label === "OpenSea" ? "Open verified OpenSea collection" : "Open project site";
  }

  async function processRow(row) {
    if (!row || row.dataset.mintLocationResolved === "1" || row.dataset.mintLocationProcessing === "1") return;
    const address = row.dataset.addr;
    if (!address) return;
    row.dataset.mintLocationProcessing = "1";
    const primary = row.querySelector(".cell-act a.btn.primary");
    try {
      const result = await resolve(address, collectionName(row));
      if (!document.contains(row)) return;
      const mint = result?.mint?.url || null;
      const marketplace = result?.marketplace?.url || null;
      const site = result?.site?.url || null;

      if (mint) {
        setAnchor(primary, mint, "Mint");
        addSideLink(row, mint, "Mint");
      } else if (marketplace) {
        setAnchor(primary, marketplace, "OpenSea");
        addSideLink(row, marketplace, "OpenSea");
      } else if (site) {
        setAnchor(primary, site, "Site");
        addSideLink(row, site, "Site");
      } else {
        setAnchor(primary, null, "Mint unavailable", true);
        row.querySelector(".mint-location-link")?.remove();
      }
      row.dataset.mintLocationResolved = "1";
    } finally {
      row.dataset.mintLocationProcessing = "0";
    }
  }

  function processFeed() {
    document.querySelectorAll("#feed .feed-item").forEach((item) => {
      const links = item.querySelectorAll(".feed-links a");
      links.forEach((link) => {
        const href = link.href || "";
        if (href.includes(EXPLORER_HOST) && href.includes("write_contract")) link.remove();
      });
    });
  }

  function scan() {
    document.querySelectorAll("#collections .rank-row[data-addr]").forEach((row) => processRow(row).catch(() => { row.dataset.mintLocationProcessing = "0"; }));
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
