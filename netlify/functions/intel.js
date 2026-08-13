const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_getCode",
  "eth_getBalance",
  "eth_chainId",
]);

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "same-origin",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(204, {});
  if (event.httpMethod !== "POST") return response(405, { error: "POST only" });

  const upstream = process.env.RHC_RPC_URL || process.env.RH_PRIVATE_INTEL_URL;
  if (!upstream) return response(503, { error: "private RPC not configured" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return response(400, { error: "invalid JSON" }); }

  const method = body?.method;
  if (!ALLOWED_METHODS.has(method)) return response(400, { error: "RPC method not allowed" });
  if (method === "eth_getCode" || method === "eth_getBalance") {
    if (!Array.isArray(body.params) || typeof body.params[0] !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(body.params[0])) {
      return response(400, { error: "invalid address" });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: Array.isArray(body.params) ? body.params : [] }),
      signal: controller.signal,
    });
    const text = await upstreamResponse.text();
    if (!upstreamResponse.ok) return response(502, { error: "RPC upstream failed" });
    let data;
    try { data = JSON.parse(text); }
    catch { return response(502, { error: "RPC returned invalid JSON" }); }
    return response(200, data);
  } catch {
    return response(502, { error: "RPC unavailable" });
  } finally {
    clearTimeout(timer);
  }
};
