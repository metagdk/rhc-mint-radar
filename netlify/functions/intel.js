const ALLOWED_ACTIONS = new Set(["collection_intel"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "same-origin",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const upstream = process.env.RH_PRIVATE_INTEL_URL;
  if (!upstream) return json(503, { error: "private intelligence endpoint not configured" });

  try {
    const body = JSON.parse(event.body || "{}");
    if (!ALLOWED_ACTIONS.has(body.action)) return json(400, { error: "unsupported action" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (process.env.RH_PRIVATE_INTEL_TOKEN) headers.authorization = `Bearer ${process.env.RH_PRIVATE_INTEL_TOKEN}`;

    const response = await fetch(upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await response.text();
    if (!response.ok) return json(502, { error: "private intelligence upstream failed" });

    let data;
    try { data = JSON.parse(text); } catch { return json(502, { error: "private intelligence returned invalid JSON" }); }
    return json(200, data);
  } catch {
    return json(502, { error: "private intelligence unavailable" });
  }
};
