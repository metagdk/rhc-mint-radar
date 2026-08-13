const ALLOWED_ACTIONS = new Set(["collection_intel", "rpc_health"]);
const ALLOWED_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_getCode",
  "eth_getBalance",
]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "same-origin",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function rpcUrl() {
  return process.env.RH_PRIVATE_INTEL_URL || process.env.RH_RPC_URL || "";
}

async function rpcCall(method, params = []) {
  if (!ALLOWED_RPC_METHODS.has(method)) throw new Error("RPC method not allowed");
  const upstream = rpcUrl();
  if (!upstream) throw new Error("RPC endpoint not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const started = Date.now();

  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error("upstream RPC error");

    return { result: payload?.result, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  try {
    const body = JSON.parse(event.body || "{}");
    if (!ALLOWED_ACTIONS.has(body.action)) {
      return json(400, { error: "unsupported action" });
    }

    if (!rpcUrl()) {
      return json(503, { error: "private RPC endpoint not configured" });
    }

    if (body.action === "rpc_health") {
      const block = await rpcCall("eth_blockNumber");
      return json(200, {
        ok: true,
        blockNumber: Number.parseInt(block.result || "0x0", 16),
        latencyMs: block.latencyMs,
      });
    }

    const contract = String(body.contract || "");
    const creator = body.creator && isAddress(body.creator) ? body.creator : null;
    if (!isAddress(contract)) return json(400, { error: "invalid contract" });

    const [code, block] = await Promise.all([
      rpcCall("eth_getCode", [contract, "latest"]),
      rpcCall("eth_blockNumber"),
    ]);

    let creatorBalance = null;
    if (creator) {
      try {
        const balance = await rpcCall("eth_getBalance", [creator, "latest"]);
        creatorBalance = balance.result || null;
      } catch {
        creatorBalance = null;
      }
    }

    const codeHex = typeof code.result === "string" ? code.result : "0x";
    const codeBytes = codeHex === "0x" ? 0 : Math.max(0, (codeHex.length - 2) / 2);

    return json(200, {
      ok: true,
      contract,
      hasCode: codeBytes > 0,
      contractCodeBytes: codeBytes,
      blockNumber: Number.parseInt(block.result || "0x0", 16),
      rpcLatencyMs: Math.max(code.latencyMs, block.latencyMs),
      creatorBalanceWei: creatorBalance,
      smartWallets: 0,
      note: "Private RPC enrichment is limited to allowlisted read-only methods.",
    });
  } catch (error) {
    return json(502, { error: "private RPC unavailable" });
  }
};
