// x402-gated code-review service — portable fetch-handler.
// Deploy targets: Cloudflare Workers (export default), Deno Deploy, Val Town.
// Payment: x402 v1, scheme "exact", Base mainnet USDC → self-custody payTo.
// Fulfillment: async — paid requests get a ticket; the operator agent (or a
// scheduled Action) fills results; buyers poll the free result URL.
"use strict";

const CONFIG = {
  payTo: "0xf7b0f21b141e3c2b0522b26d15ef047b22717202", // rune_lynx self-custody, Base
  network: "base",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native USDC on Base
  // ⚠ VERIFY AT DEPLOY: EIP-712 domain for Base-mainnet USDC ("USDC" vs "USD Coin")
  // against coinbase/x402 packages' known-asset config; wrong name = unsignable.
  assetExtra: { name: "USDC", version: "2" },
  priceAtomic: "50000", // $0.05 (6 decimals)
  // ⚠ VERIFY AT DEPLOY: keyless facilitator with base-mainnet settle support.
  facilitator: "https://facilitator.x402.rs",
  slaSeconds: 3600,
  serviceName: "rune_lynx root-cause code review",
};

const te = new TextEncoder();
const b64decode = (s) => {
  try { return JSON.parse(atob(s)); } catch { return null; }
};
const b64encode = (o) => btoa(JSON.stringify(o));

function paymentRequirements(resourceUrl) {
  return {
    scheme: "exact",
    network: CONFIG.network,
    maxAmountRequired: CONFIG.priceAtomic,
    asset: CONFIG.asset,
    payTo: CONFIG.payTo,
    resource: resourceUrl,
    description:
      "Root-cause code review by an autonomous Claude agent: root cause with file:line refs, minimal unified-diff patch, regression-test suggestion, risk notes. Async: response is a ticket; result at result_url within the SLA (usually much faster).",
    mimeType: "application/json",
    outputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        result_url: { type: "string" },
        sla_seconds: { type: "number" },
      },
    },
    maxTimeoutSeconds: 300,
    extra: CONFIG.assetExtra,
  };
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 1), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function manifest(origin) {
  return {
    name: CONFIG.serviceName,
    operator: "rune_lynx — autonomous Claude agent (ERC-8004 #59864 on Base)",
    protocol: "x402/v1",
    endpoints: {
      "POST /review": {
        price_usdc: "0.05",
        pay_to: CONFIG.payTo,
        network: CONFIG.network,
        input: {
          code_or_url: "string — inline code/diff (≤48KB) or a public raw URL",
          problem: "string — failing behavior, error output, or review focus",
        },
        flow: "402 → pay via x402 exact/Base-USDC → 202 ticket → poll result_url",
        sla_seconds: CONFIG.slaSeconds,
      },
      "GET /result/{ticket}": { price_usdc: "0", note: "free polling endpoint" },
    },
  };
}

async function facilitator(path, paymentPayload, reqs) {
  const r = await fetch(CONFIG.facilitator + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 1,
      paymentPayload,
      paymentRequirements: reqs,
    }),
  });
  return r.json();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const kv = env.TICKETS; // KV namespace: get/put

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/llms.txt")) {
      const m = manifest(url.origin);
      return url.pathname === "/"
        ? json(m)
        : new Response(
            `# ${m.name}\n\nAgent-payable code review. ${m.endpoints["POST /review"].flow}\n` +
              `Price: $0.05 USDC on Base via x402 (scheme "exact"). POST /review with JSON {code_or_url, problem}.\n` +
              `No payment header → HTTP 402 with exact PaymentRequirements. Results are free at /result/{ticket}.\n`,
            { headers: { "content-type": "text/plain" } }
          );
    }

    if (req.method === "GET" && url.pathname.startsWith("/result/")) {
      const t = url.pathname.split("/")[2] || "";
      if (!/^[0-9a-f-]{36}$/.test(t)) return json({ error: "bad ticket id" }, 400);
      const rec = await kv.get("t:" + t);
      if (!rec) return json({ error: "unknown ticket" }, 404);
      const r = JSON.parse(rec);
      return json(
        r.result
          ? { status: "done", result: r.result, delivered_at: r.delivered_at }
          : { status: "pending", submitted_at: r.submitted_at, sla_seconds: CONFIG.slaSeconds }
      );
    }

    if (req.method === "POST" && url.pathname === "/review") {
      const reqs = paymentRequirements(url.origin + "/review");
      const ph = req.headers.get("X-PAYMENT");
      if (!ph)
        return json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [reqs] }, 402);
      const paymentPayload = b64decode(ph);
      if (!paymentPayload || paymentPayload.x402Version !== 1)
        return json({ x402Version: 1, error: "malformed X-PAYMENT header", accepts: [reqs] }, 402);

      let body;
      try { body = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
      const code = (body.code_or_url || "").toString();
      const problem = (body.problem || "").toString();
      if (!code || code.length > 48_000)
        return json({ error: "code_or_url required, ≤48KB inline" }, 400);

      const v = await facilitator("/verify", paymentPayload, reqs);
      if (!v.isValid)
        return json({ x402Version: 1, error: "payment invalid: " + (v.invalidReason || "unknown"), accepts: [reqs] }, 402);
      const s = await facilitator("/settle", paymentPayload, reqs);
      if (!s.success)
        return json({ x402Version: 1, error: "settlement failed: " + (s.errorReason || "unknown"), accepts: [reqs] }, 402);

      const ticket = crypto.randomUUID();
      await kv.put(
        "t:" + ticket,
        JSON.stringify({
          submitted_at: new Date().toISOString(),
          payer: s.payer,
          tx: s.transaction,
          input: { code_or_url: code, problem },
          result: null,
        })
      );
      await kv.put("queue:" + ticket, "1"); // operator scans queue:* prefix
      return json(
        { ticket, result_url: url.origin + "/result/" + ticket, sla_seconds: CONFIG.slaSeconds },
        202,
        { "X-PAYMENT-RESPONSE": b64encode({ success: true, transaction: s.transaction, network: s.network, payer: s.payer }) }
      );
    }

    return json({ error: "not found — see GET / for the manifest" }, 404);
  },
};
