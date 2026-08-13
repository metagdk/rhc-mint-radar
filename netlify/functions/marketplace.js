const OPEN_SEA_API = "https://api.opensea.io/api/v2";
const OPEN_SEA_WEB = "https://opensea.io";
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

function scoreName(actual, wanted) {
  const a = slugify(actual);
  const b = slugify(wanted);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const compactA = a.replace(/-/g, "");
  const compactB = b.replace(/-/g, "");
  return compactA === compactB ? 0.8 : 0;
}

function extractCollections(payload) {
  const out = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const slug = value.collection || value.slug;
    const name = value.name || value.collection_name || value.collectionName;
    if (typeof slug === "string" && typeof name === "string") {
      out.push({ slug, name, url: `${OPEN_SEA_WEB}/collection/${encodeURIComponent(slug)}` });
    }
    if (typeof value.opensea_url === "string") {
      out.push({ slug: null, name: name || "", url: value.opensea_url });
    }
    for (const v of Object.values(value)) walk(v);
  };
  walk(payload);
  return out;
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
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

async function verifyCollectionUrl(url) {
  if (!/^https:\/\/opensea\.io\/collection\/[a-zA-Z0-9._~-]+$/.test(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: controller.signal,
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWithApi(address, name, key) {
  const headers = { "x-api-key": key };

  if (validAddress(address)) {
    try {
      const contract = await fetchJson(`${OPEN_SEA_API}/chain/${CHAIN}/contract/${encodeURIComponent(address)}`, headers);
      const candidates = extractCollections(contract);
      const exact = candidates
        .map(c => ({ ...c, score: scoreName(c.name, name) }))
        .sort((a,b) => b.score - a.score)[0];
      if (exact && exact.url) return { ...exact, source: "opensea-contract" };
    } catch {}
  }

  if (!name) return null;
  try {
    const search = await fetchJson(`${OPEN_SEA_API}/search?query=${encodeURIComponent(name)}&asset_types=collection&limit=20`, headers);
    const candidates = extractCollections(search)
      .map(c => ({ ...c, score: scoreName(c.name, name) }))
      .filter(c => c.score >= 0.8)
      .sort((a,b) => b.score - a.score);
    if (candidates[0]) return { ...candidates[0], source: "opensea-search" };
  } catch {}
  return null;
}

function extractWebCollectionLinks(html, wantedName) {
  const links = new Map();
  const re = /(?:href|url)\s*[=:]\s*["']?(\/collection\/[a-zA-Z0-9._~-]+)["']?/gi;
  let match;
  while ((match = re.exec(html || ""))) {
    const path = match[1];
    const slug = decodeURIComponent(path.split("/").pop() || "");
    const url = `${OPEN_SEA_WEB}${path}`;
    links.set(slug.toLowerCase(), { slug, name: slug.replace(/-/g, " "), url, score: scoreName(slug, wantedName) });
  }
  return [...links.values()].sort((a,b) => b.score - a.score);
}

async function resolveWithWebSearch(name) {
  if (!name) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const url = `${OPEN_SEA_WEB}/search?q=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 RHC-Mint-Radar/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const candidates = extractWebCollectionLinks(html, name).filter(c => c.score >= 0.8);
    if (candidates[0]) return { ...candidates[0], source: "opensea-web-search" };
  } catch {}
  finally { clearTimeout(timer); }
  return null;
}

async function verifySlugCandidates(name) {
  const base = slugify(name);
  const candidates = [...new Set([base, base.replace(/-/g, "")].filter(Boolean))];
  for (const slug of candidates) {
    const url = `${OPEN_SEA_WEB}/collection/${encodeURIComponent(slug)}`;
    if (await verifyCollectionUrl(url)) return { slug, name, url, source: "opensea-verified-slug" };
  }
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

  const apiKey = process.env.OPENSEA_API_KEY || "";
  let result = null;

  if (apiKey) result = await resolveWithApi(address, name, apiKey);
  if (!result) result = await resolveWithWebSearch(name);
  if (!result) result = await verifySlugCandidates(name);

  if (!result) return response(404, { found: false, code: "OPENSEA_COLLECTION_NOT_FOUND" });
  return response(200, { found: true, url: result.url, slug: result.slug || null, name: result.name || name, source: result.source });
};
