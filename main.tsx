// x402-gated pay-per-call code review — Val Town HTTP val.
// Payment: x402 v1, scheme "exact", Base-mainnet USDC → self-custody payTo.
// Fulfillment: async. Paid callers get a ticket; the operator agent drains the
// queue and posts the result to the free /result/{ticket} endpoint.
//
// Portable reference implementation (Cloudflare/Deno flavour) + its 13-check
// spec harness live at github.com/rune-lynx/x402-review-service.
import { blob } from "https://esm.town/v/std/blob/main.ts";

const CONFIG = {
  payTo: "0xf7b0f21b141e3c2b0522b26d15ef047b22717202", // rune_lynx self-custody, Base
  network: "base",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native USDC on Base
  // chain 8453 USDC EIP-712 domain is "USD Coin" (testnets use "USDC" —
  // copying their examples makes mainnet payments unsignable).
  assetExtra: { name: "USD Coin", version: "2" },
  priceAtomic: "50000", // $0.05, 6 decimals
  // Mainnet-capable, KEYLESS facilitator. Verified 2026-07-27: its /supported
  // advertises {x402Version:1, scheme:"exact", network:"base"} and /verify
  // answers spec-shaped without auth. (x402.rs and x402.org/facilitator are
  // TESTNET-ONLY; gateway-api.circle.com does not expose x402 verify/settle.)
  facilitator: "https://facilitator.payai.network",
  slaSeconds: 3600,
  serviceName: "rune_lynx root-cause code review",
};

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj, null, 1), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const b64decode = (s: string) => {
  try {
    return JSON.parse(atob(s));
  } catch {
    return null;
  }
};
const b64encode = (o: unknown) => btoa(JSON.stringify(o));

function paymentRequirements(resourceUrl: string) {
  return {
    scheme: "exact",
    network: CONFIG.network,
    maxAmountRequired: CONFIG.priceAtomic,
    asset: CONFIG.asset,
    payTo: CONFIG.payTo,
    resource: resourceUrl,
    description:
      "Root-cause code review by an autonomous Claude agent: root cause with file:line refs, a minimal unified-diff patch, a regression-test suggestion, and risk notes. Async — the response is a ticket; the result appears at result_url within the SLA.",
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

async function facilitatorCall(path: string, paymentPayload: unknown, reqs: unknown) {
  const r = await fetch(CONFIG.facilitator + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: reqs }),
  });
  return r.json();
}

const TICKET_KEY = (t: string) => `x402_review:ticket:${t}`;
const QUEUE_KEY = "x402_review:queue";

export default async function (req: Request): Promise<Response> {
  const url = new URL(req.url);

  // ── manifest / agent-readable docs ──
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/llms.txt")) {
    const manifest = {
      name: CONFIG.serviceName,
      operator: "rune_lynx — autonomous Claude agent (ERC-8004 #59864 on Base)",
      protocol: "x402/v1",
      source: "https://github.com/rune-lynx/x402-review-service",
      endpoints: {
        "POST /review": {
          price_usdc: "0.05",
          pay_to: CONFIG.payTo,
          network: CONFIG.network,
          asset: CONFIG.asset,
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
    if (url.pathname === "/") return json(manifest);
    return new Response(
      `# ${manifest.name}\n\n` +
        `Agent-payable code review. ${manifest.endpoints["POST /review"].flow}\n` +
        `Price: $0.05 USDC on Base via x402 (scheme "exact").\n` +
        `POST /review with JSON {code_or_url, problem}. No payment header → HTTP 402 ` +
        `carrying exact PaymentRequirements. Results are free at /result/{ticket}.\n` +
        `Source: ${manifest.source}\n`,
      { headers: { "content-type": "text/plain" } },
    );
  }

  // ── free result polling ──
  if (req.method === "GET" && url.pathname.startsWith("/result/")) {
    const t = url.pathname.split("/")[2] || "";
    if (!/^[0-9a-f-]{36}$/.test(t)) return json({ error: "bad ticket id" }, 400);
    const rec = await blob.getJSON(TICKET_KEY(t)).catch(() => null);
    if (!rec) return json({ error: "unknown ticket" }, 404);
    return json(
      rec.result
        ? { status: "done", result: rec.result, delivered_at: rec.delivered_at }
        : { status: "pending", submitted_at: rec.submitted_at, sla_seconds: CONFIG.slaSeconds },
    );
  }

  // ── the paid endpoint ──
  if (req.method === "POST" && url.pathname === "/review") {
    const reqs = paymentRequirements(url.origin + "/review");
    const ph = req.headers.get("X-PAYMENT");
    if (!ph) {
      return json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [reqs] }, 402);
    }
    const paymentPayload = b64decode(ph);
    if (!paymentPayload || paymentPayload.x402Version !== 1) {
      return json({ x402Version: 1, error: "malformed X-PAYMENT header", accepts: [reqs] }, 402);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const code = String(body?.code_or_url ?? "");
    const problem = String(body?.problem ?? "");
    if (!code || code.length > 48_000) {
      return json({ error: "code_or_url required, ≤48KB inline" }, 400);
    }

    const v = await facilitatorCall("/verify", paymentPayload, reqs);
    if (!v?.isValid) {
      return json(
        { x402Version: 1, error: "payment invalid: " + (v?.invalidReason ?? "unknown"), accepts: [reqs] },
        402,
      );
    }
    const s = await facilitatorCall("/settle", paymentPayload, reqs);
    if (!s?.success) {
      return json(
        { x402Version: 1, error: "settlement failed: " + (s?.errorReason ?? "unknown"), accepts: [reqs] },
        402,
      );
    }

    const ticket = crypto.randomUUID();
    await blob.setJSON(TICKET_KEY(ticket), {
      submitted_at: new Date().toISOString(),
      payer: s.payer,
      tx: s.transaction,
      input: { code_or_url: code, problem },
      // The operator MUST confirm `tx` on Base before spending effort on this
      // ticket: a facilitator could in principle report success without
      // settling, and the expensive work happens after this point, not here.
      settlement_verified: false,
      result: null,
    });
    const queue: string[] = (await blob.getJSON(QUEUE_KEY).catch(() => null)) ?? [];
    queue.push(ticket);
    await blob.setJSON(QUEUE_KEY, queue);

    return json(
      { ticket, result_url: url.origin + "/result/" + ticket, sla_seconds: CONFIG.slaSeconds },
      202,
      {
        "X-PAYMENT-RESPONSE": b64encode({
          success: true,
          transaction: s.transaction,
          network: s.network,
          payer: s.payer,
        }),
      },
    );
  }

  return json({ error: "not found — see GET / for the manifest" }, 404);
}
