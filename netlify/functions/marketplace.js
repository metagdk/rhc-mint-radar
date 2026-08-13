const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
const OPEN_SEA = "https://opensea.io";
const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const CHAIN = "robinhood";

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=600",
      "access-control-allow-origin": "same-origin",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
    body: JSON.stringify(body),
  };
}

function validAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function slugify(value) {
  return cleanName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

function safeExternalUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  try {
    const u = new URL(raw, BLOCKSCOUT);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname.toLowerCase() === new URL(BLOCKSCOUT).hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

function marketplaceHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return [
    "opensea.io", "magiceden.io", "blur.io", "tensor.trade", "rarible.com",
    "looksrare.org", "zora.co", "reservoir.market", "nftx.io", "element.market",
    "okx.com", "ordinals.com", "foundation.app"
  ].some(x => h === x || h.endsWith(`.${x}`));
}

function marketplaceLabel(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes("opensea")) return "OpenSea";
    if (h.includes("magiceden")) return "Magic Eden";
    if (h.includes("tensor")) return "Tensor";
    if (h.includes("blur")) return "Blur";
    if (h.includes("rarible")) return "Rarible";
    if (h.includes("looksrare")) return "LooksRare";
    if (h.includes("zora")) return "Zora";
    return "Marketplace";
  } catch { return "Marketplace"; }
}

function extractUrls(text) {
  const urls = new Set();
  const source = String(text || "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003A/gi, ":")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');

  const patterns = [
    /https?:\\/\\/[^\s"'<>\\\\]+/gi,
    /(?:href|url|external_app_url|external_url)\\s*[:=]\\s*["']([^"']+)["']/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) {
      const candidate = m[1] || m[0];
      const url = safeExternalUrl(candidate);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function marketplaceCandidatesFromHtml(html, address) {
  const source = String(html || "");
  const urls = extractUrls(source);
  const candidates = [];

  // Prefer links appearing near the Blockscout "Marketplaces" section.
  const marker = /marketplaces?/i.exec(source);
  if (marker) {
    const nearby = source.slice(Math.max(0, marker.index - 3000), marker.index + 8000);
    for (const url of extractUrls(nearby)) {
      try {
        if (marketplaceHost(new URL(url).hostname)) candidates.push({ url, label: marketplaceLabel(url), source: "blockscout-token-marketplaces" });
      } catch {}
    }
  }

  // Then inspect all marketplace URLs embedded in the server-rendered page.
  for (const url of urls) {
    try {
      const u = new URL(url);
      if (marketplaceHost(u.hostname)) candidates.push({ url, label: marketplaceLabel(url), source: "blockscout-token-page" });
    } catch {}
  }

  // OpenSea sometimes renders the collection asset URL rather than a collection URL.
  // Preserve that exact marketplace destination instead of inventing a slug.
  const unique = new Map();
  for (const c of candidates) unique.set(c.url, c);
  return [...unique.values()];
}

async function fetchText(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 RHC-Mint-Radar/1.0"
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}, timeout = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractMetadataMarketplace(value) {
  if (!value || typeof value !== "object") return [];
  const out = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const [key, val] of Object.entries(v)) {
      if (typeof val === "string") {
        const u = safeExternalUrl(val);
        if (u) {
          try {
            if (marketplaceHost(new URL(u).hostname)) out.push({ url: u, label: marketplaceLabel(u), source: `blockscout-metadata:${key}` });
          } catch {}
        }
      } else walk(val);
    }
  };
  walk(value);
  return out;
}

async function resolveFromBlockscout(address) {
  if (!validAddress(address)) return null;

  // This intentionally follows the same route a human takes:
  // write-contract address -> token page -> Marketplace link.
  const tokenPage = `${BLOCKSCOUT}/token/${encodeURIComponent(address)}`;
  try {
    const html = await fetchText(tokenPage);
    const candidates = marketplaceCandidatesFromHtml(html, address);
    if (candidates[0]) return { ...candidates[0], tokenPage };
  } catch {}

  // The explorer's v2 NFT instance data exposes external_app_url/metadata.
  // Use it as a data-level equivalent of the Marketplace section if the page
  // is client-rendered and the HTML does not contain the link.
  try {
    const instances = await fetchJson(`${BLOCKSCOUT}/api/v2/tokens/${encodeURIComponent(address)}/instances?limit=8`);
    const candidates = [];
    for (const item of instances?.items || []) {
      for (const value of [item?.external_app_url, item?.metadata?.external_app_url, item?.metadata?.external_url]) {
        const url = safeExternalUrl(value);
        if (!url) continue;
        try {
          if (marketplaceHost(new URL(url).hostname)) candidates.push({ url, label: marketplaceLabel(url), source: "blockscout-token-instance", tokenPage });
        } catch {}
      }
      candidates.push(...extractMetadataMarketplace(item?.metadata).map(x => ({ ...x, tokenPage })));
    }
    if (candidates[0]) return candidates[0];
  } catch {}

  return null;
}

function scoreName(actual, wanted) {
  const a = slugify(actual), b = slugify(wanted);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return a.replace(/-/g, "") === b.replace(/-/g, "") ? 0.8 : 0;
}

function extractCollections(payload) {
  const out = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const slug = value.collection || value.slug;
    const name = value.name || value.collection_name || value.collectionName;
    if (typeof slug === "string" && typeof name === "string") out.push({ slug, name, url: `${OPEN_SEA}/collection/${encodeURIComponent(slug)}` });
    if (typeof value.opensea_url === "string") out.push({ slug: null, name: name || "", url: value.opensea_url });
    for (const v of Object.values(value)) walk(v);
  };
  walk(payload);
  return out;
}

async function resolveWithOpenSeaApi(address, name, key) {
  const headers = { "x-api-key": key };
  if (validAddress(address)) {
    try {
      const contract = await fetchJson(`${OPEN_SEA_API}/chain/${CHAIN}/contract/${encodeURIComponent(address)}`, headers);
      const candidates = extractCollections(contract).map(c => ({ ...c, score: scoreName(c.name, name) })).sort((a,b) => b.score - a.score);
      if (candidates[0]?.url) return { ...candidates[0], source: "opensea-contract" };
    } catch {}
  }
  if (!name) return null;
  try {
    const search = await fetchJson(`${OPEN_SEA_API}/search?query=${encodeURIComponent(name)}&asset_types=collection&limit=20`, headers);
    const candidates = extractCollections(search).map(c => ({ ...c, score: scoreName(c.name, name) })).filter(c => c.score >= 0.8).sort((a,b) => b.score - a.score);
    if (candidates[0]) return { ...candidates[0], source: "opensea-search" };
  } catch {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(204, {});
  if (event.httpMethod !== "GET") return response(405, { error: "GET only", code: "METHOD_NOT_ALLOWED" });

  const params = event.queryStringParameters || {};
  const address = String(params.address || "").trim();
  const name = cleanName(params.name);
  if (address && !validAddress(address)) return response(400, { error: "invalid address", code: "INVALID_ADDRESS" });
  if (!address && !name) return response(400, { error: "address or name required", code: "MISSING_QUERY" });

  // FIRST: reproduce the exact explorer flow requested by the user.
  // Do not guess a slug before checking the token page's own Marketplace data.
  if (address) {
    const blockscout = await resolveFromBlockscout(address);
    if (blockscout) {
      return response(200, {
        found: true,
        url: blockscout.url,
        label: blockscout.label,
        source: blockscout.source,
        tokenPage: blockscout.tokenPage,
      });
    }
  }

  // SECOND: optional authenticated OpenSea lookup.
  const apiKey = process.env.OPENSEA_API_KEY || "";
  if (apiKey) {
    const openSea = await resolveWithOpenSeaApi(address, name, apiKey);
    if (openSea) return response(200, { found: true, url: openSea.url, label: "OpenSea", source: openSea.source });
  }

  return response(404, {
    found: false,
    code: "MARKETPLACE_NOT_FOUND",
    tokenPage: address ? `${BLOCKSCOUT}/token/${encodeURIComponent(address)}` : null,
  });
};
