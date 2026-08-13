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

function validAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(204, {});
  if (event.httpMethod !== "POST") return response(405, { error: "POST only", code: "METHOD_NOT_ALLOWED" });

  const upstream = process.env.RHC_RPC_URL || process.env.RH_PRIVATE_INTEL_URL;
  if (!upstream) return response(503, { error: "private RPC not configured", code: "RPC_NOT_CONFIGURED" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "invalid JSON", code: "INVALID_JSON" });
  }

  const method = body?.method;
  if (!ALLOWED_METHODS.has(method)) {
    return response(400, { error: "RPC method not allowed", code: "RPC_METHOD_NOT_ALLOWED" });
  }

  if ((method === "eth_getCode" || method === "eth_getBalance") && !validAddress(body?.params?.[0])) {
    return response(400, { error: "invalid address", code: "INVALID_ADDRESS" });
  }

  const params = Array.isArray(body.params) ? body.params : [];

  // Two short attempts protect the UI from transient edge/RPC failures without
  // turning the function into a slow polling relay.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const upstreamResponse = await fetch(upstream, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });

      const text = await upstreamResponse.text();
      if (!upstreamResponse.ok) {
        if (attempt === 0) continue;
        return response(502, { error: "RPC upstream failed", code: "RPC_UPSTREAM_HTTP" });
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (attempt === 0) continue;
        return response(502, { error: "RPC returned invalid JSON", code: "RPC_BAD_JSON" });
      }

      if (data?.error) {
        return response(502, { error: "RPC returned an error", code: "RPC_UPSTREAM_ERROR" });
      }

      return response(200, data);
    } catch (error) {
      if (attempt === 1) {
        const code = error?.name === "AbortError" ? "RPC_TIMEOUT" : "RPC_UNAVAILABLE";
        return response(502, { error: "RPC unavailable", code });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return response(502, { error: "RPC unavailable", code: "RPC_UNAVAILABLE" });
};
