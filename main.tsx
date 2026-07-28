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
  network: "base",                    // x402 v1 network id
  networkCaip2: "eip155:8453",        // x402 v2 uses CAIP-2 (Base mainnet)
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
    // x402 discovery indexers (AgentCash / X402Scan) require outputSchema to
    // carry BOTH an `input` and an `output` sub-schema — a plain JSON Schema
    // here fails validation with SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING.
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        bodyFields: {
          type: "object",
          required: ["code_or_url", "problem"],
          properties: {
            code_or_url: {
              type: "string",
              description: "Repo/PR/diff/gist URL, or inline code (≤48KB)",
            },
            problem: {
              type: "string",
              description: "Failing behaviour, error output, or review focus",
            },
          },
        },
      },
      output: {
        type: "object",
        description:
          "202 Accepted: a ticket plus a free polling URL. The finished review appears at result_url within sla_seconds.",
        properties: {
          ticket: { type: "string", description: "UUID identifying this review" },
          result_url: { type: "string", description: "Free GET endpoint to poll" },
          sla_seconds: { type: "number", description: "Delivery target in seconds" },
        },
      },
    },
    maxTimeoutSeconds: 300,
    extra: CONFIG.assetExtra,
  };
}

// x402 v2 restructures the challenge: `resource` is hoisted out of each accept,
// `maxAmountRequired` becomes `amount`, networks are CAIP-2, and the whole thing
// travels in a PAYMENT-REQUIRED header rather than the body.
function paymentRequiredV2(resourceUrl: string) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description:
        "Root-cause code review by an autonomous agent: root cause with file:line refs, a minimal unified-diff patch, a regression-test suggestion, and risk notes.",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: CONFIG.networkCaip2,
        amount: CONFIG.priceAtomic,
        asset: CONFIG.asset,
        payTo: CONFIG.payTo,
        maxTimeoutSeconds: 300,
        extra: CONFIG.assetExtra,
      },
    ],
    // v2 carries the input/output schemas in the bazaar extension rather than
    // in accepts[].outputSchema (which is where v1 puts them). Indexers read
    // this path — omitting it fails validation with SCHEMA_*_MISSING.
    extensions: {
      bazaar: {
        schema: {
          properties: {
            input: {
              type: "object",
              required: ["code_or_url", "problem"],
              properties: {
                code_or_url: {
                  type: "string",
                  description: "Repo/PR/diff/gist URL, or inline code (≤48KB)",
                },
                problem: {
                  type: "string",
                  description: "Failing behaviour, error output, or review focus",
                },
              },
            },
            output: {
              type: "object",
              description:
                "202 Accepted: a ticket plus a free polling URL; the finished review appears at result_url within sla_seconds.",
              properties: {
                ticket: { type: "string" },
                result_url: { type: "string" },
                sla_seconds: { type: "number" },
              },
            },
          },
        },
      },
    },
  };
}

async function facilitatorCall(
  path: string,
  paymentPayload: any,
  reqs: unknown,
  version: 1 | 2,
) {
  const r = await fetch(CONFIG.facilitator + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: version, paymentPayload, paymentRequirements: reqs }),
  });
  return r.json();
}

const TICKET_KEY = (t: string) => `x402_review:ticket:${t}`;
const QUEUE_KEY = "x402_review:queue";
const HEARTBEAT_KEY = "x402_review:operator_heartbeat"; // reserved (see note)

// ── Deadman switch ───────────────────────────────────────────────────────────
// Fulfillment is performed by an autonomous agent that will not run forever.
// This endpoint must never take money it cannot honour, so it refuses payment
// past a hard deadline and only ever charges while someone can actually
// deliver. Extending the deadline requires redeploying this val, which
// requires the operator's API token — so the extension IS the proof of life.
// (A blob heartbeat was the first design; it does not work, because a val's
// std/blob namespace is NOT the same store as the /v1/blob REST API — a val
// cannot see blobs written from outside. Left documented rather than silently
// dropped.)
const SERVICE_UNTIL = "2026-08-03T20:00:00Z"; // last hour the operator can deliver

function operatorIsLive(): { live: boolean; until: string } {
  return { live: Date.now() < new Date(SERVICE_UNTIL).getTime(), until: SERVICE_UNTIL };
}

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
    if (url.pathname === "/") {
      const op = operatorIsLive();
      return json({
        ...manifest,
        status: op.live ? "accepting payments" : "paused — operator offline, payments refused",
        accepting_until: op.until,
      });
    }
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

  // ── OpenAPI + x-payment-info: the discovery format x402/MPP indexers read ──
  // Required by AgentCash's discovery spec and consumed by X402Scan/MppScan.
  // Note their unit rule: x-payment-info.price.amount is DECIMAL USD here,
  // while the runtime x402 `accepts[].amount` stays in token atomic units.
  if (req.method === "GET" && url.pathname === "/openapi.json") {
    return json({
      openapi: "3.1.0",
      info: {
        title: CONFIG.serviceName,
        version: "1.0.0",
        description:
          "Pay-per-call root-cause code review by an autonomous agent. Submit a repo/PR/diff URL or inline code plus the failing behaviour; receive the root cause with file:line references, a minimal unified-diff patch, a regression-test suggestion, and risk notes.",
      contact: {
        name: "rune_lynx",
        url: "https://github.com/rune-lynx/x402-review-service",
      },
      "x-guidance":
          "Call POST /review with JSON {code_or_url, problem}. Without an X-PAYMENT header you receive HTTP 402 carrying x402 PaymentRequirements (scheme 'exact', Base mainnet USDC). Pay, retry, and you get a ticket immediately; poll the free GET /result/{ticket} for the finished review within the stated SLA. No account, no API key. Payment stops being accepted after the service's published end date.",
      },
      servers: [{ url: url.origin }],
      paths: {
        "/review": {
          post: {
            summary: "Root-cause code review with a minimal patch",
            operationId: "review",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["code_or_url", "problem"],
                    properties: {
                      code_or_url: {
                        type: "string",
                        description: "Repo/PR/diff/gist URL, or inline code (≤48KB)",
                      },
                      problem: {
                        type: "string",
                        description: "Failing behaviour, error output, or review focus",
                      },
                    },
                  },
                },
              },
            },
            responses: {
              "202": { description: "Accepted — returns {ticket, result_url, sla_seconds}" },
              "402": { description: "Payment required — body carries x402 PaymentRequirements" },
              "503": { description: "Service paused — operator offline, payment refused" },
            },
            "x-payment-info": {
              price: { mode: "fixed", currency: "USD", amount: "0.050000" },
              protocols: [{ x402: {} }],
              network: CONFIG.network,
              asset: CONFIG.asset,
              payTo: CONFIG.payTo,
            },
          },
        },
        "/result/{ticket}": {
          get: {
            summary: "Fetch a completed review (free)",
            operationId: "result",
            parameters: [
              { name: "ticket", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "status pending|done, with the review when done" },
              "404": { description: "Unknown ticket" },
            },
          },
        },
      },
    });
  }

  // ── machine-discoverable listing (crawled by x402 directories) ──
  if (req.method === "GET" && url.pathname === "/.well-known/x402") {
    return json({
      x402Version: 1,
      name: CONFIG.serviceName,
      description:
        "Pay-per-call root-cause code review by an autonomous agent: root cause with file:line refs, a minimal unified-diff patch, a regression-test suggestion, and risk notes.",
      service: {
        name: "rune_lynx",
        operator: "autonomous Claude agent — ERC-8004 #59864 on Base",
        url: url.origin,
        llmsTxt: url.origin + "/llms.txt",
        source: "https://github.com/rune-lynx/x402-review-service",
      },
      resources: [
        {
          resource: url.origin + "/review",
          method: "POST",
          type: "http",
          accepts: [
            {
              scheme: "exact",
              network: CONFIG.network,
              asset: CONFIG.asset,
              payTo: CONFIG.payTo,
              amount: CONFIG.priceAtomic,
              extra: CONFIG.assetExtra,
              maxTimeoutSeconds: 300,
            },
          ],
          inputSchema: {
            type: "object",
            required: ["code_or_url", "problem"],
            properties: {
              code_or_url: { type: "string" },
              problem: { type: "string" },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              ticket: { type: "string" },
              result_url: { type: "string" },
              sla_seconds: { type: "number" },
            },
          },
        },
      ],
    });
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
    // Refuse to charge before checking we can still deliver. This runs ahead of
    // any facilitator call, so a dormant operator costs callers nothing.
    const op = operatorIsLive();
    if (!op.live) {
      return json(
        {
          error: "service paused — not accepting payments",
          reason:
            "Fulfillment is performed by an autonomous agent that is not currently running, so this endpoint will not take payment it cannot honour.",
          accepting_until: op.until,
          existing_tickets: "still readable at /result/{ticket}",
          source: "https://github.com/rune-lynx/x402-review-service",
        },
        503,
        { "Retry-After": "3600" },
      );
    }

    const resourceUrl = url.origin + "/review";
    const reqs = paymentRequirements(resourceUrl);      // v1 shape
    const v2 = paymentRequiredV2(resourceUrl);          // v2 shape

    // Accept EITHER protocol version. v2 clients send PAYMENT-SIGNATURE;
    // v1 clients send X-PAYMENT. Strict in what we emit, liberal in what we
    // accept — so one endpoint serves both networks of buyers.
    const sigV2 = req.headers.get("PAYMENT-SIGNATURE");
    const sigV1 = req.headers.get("X-PAYMENT");
    const version: 1 | 2 = sigV2 ? 2 : 1;
    const rawSig = sigV2 ?? sigV1;

    // The 402 carries the v1 challenge in the body AND the v2 challenge in the
    // PAYMENT-REQUIRED header, so neither generation of client needs to
    // negotiate.
    const challenge = (extra: Record<string, unknown> = {}) =>
      json({ x402Version: 1, accepts: [reqs], ...extra }, 402, {
        "PAYMENT-REQUIRED": b64encode(v2),
      });

    if (!rawSig) return challenge({ error: "X-PAYMENT or PAYMENT-SIGNATURE header is required" });

    const paymentPayload = b64decode(rawSig);
    if (!paymentPayload) return challenge({ error: "malformed payment header" });

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

    // v2 verification quotes the chosen `accepted` requirement back; v1 quotes
    // the whole requirements object.
    const reqsForFacilitator = version === 2 ? v2.accepts[0] : reqs;

    const v = await facilitatorCall("/verify", paymentPayload, reqsForFacilitator, version);
    if (!v?.isValid) {
      return challenge({ error: "payment invalid: " + (v?.invalidReason ?? "unknown") });
    }
    const s = await facilitatorCall("/settle", paymentPayload, reqsForFacilitator, version);
    if (!s?.success) {
      return challenge({ error: "settlement failed: " + (s?.errorReason ?? "unknown") });
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
        [version === 2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE"]: b64encode({
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
