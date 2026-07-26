import svc from "./service.js";

// ── stubs ──
const store = new Map();
const env = { TICKETS: {
  get: async (k) => store.get(k) ?? null,
  put: async (k, v) => { store.set(k, v); },
}};
let facilitatorCalls = [];
let facilitatorMode = "ok";
globalThis.fetch = async (url, opts) => {
  facilitatorCalls.push({ url, body: JSON.parse(opts.body) });
  const path = new URL(url).pathname;
  if (facilitatorMode === "reject" && path === "/verify")
    return { json: async () => ({ isValid: false, invalidReason: "insufficient_funds", payer: "0xPAYER" }) };
  if (path === "/verify") return { json: async () => ({ isValid: true, payer: "0xPAYER" }) };
  if (path === "/settle") return { json: async () => ({ success: true, transaction: "0xTX", network: "base", payer: "0xPAYER" }) };
  throw new Error("unexpected facilitator path " + path);
};

const base = "https://svc.example";
const call = (method, path, { headers = {}, body } = {}) =>
  svc.fetch(new Request(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);

const payment = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: "base",
  payload: { signature: "0xsig", authorization: { from: "0xPAYER", to: "0xf7b0f21b141e3c2b0522b26d15ef047b22717202", value: "50000", validAfter: "0", validBefore: "9999999999", nonce: "0x00" } },
})).toString("base64");

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log("✗", name)); cond && console.log("✓", name); };

// 1. manifest
let r = await call("GET", "/");
check("manifest 200", r.status === 200 && (await r.json()).protocol === "x402/v1");
// 2. llms.txt
r = await call("GET", "/llms.txt");
check("llms.txt 200 text", r.status === 200 && (await r.text()).includes("402"));
// 3. no payment → 402 with exact requirements
r = await call("POST", "/review", { body: { code_or_url: "x", problem: "y" } });
let j = await r.json();
check("402 without X-PAYMENT", r.status === 402 && j.accepts[0].scheme === "exact"
  && j.accepts[0].payTo === "0xf7b0f21b141e3c2b0522b26d15ef047b22717202"
  && j.accepts[0].maxAmountRequired === "50000" && j.x402Version === 1);
// 4. malformed header → 402
r = await call("POST", "/review", { headers: { "X-PAYMENT": "!!notb64!!" }, body: { code_or_url: "x" } });
check("402 malformed header", r.status === 402);
// 5. happy path → 202 + ticket + settlement header
r = await call("POST", "/review", { headers: { "X-PAYMENT": payment }, body: { code_or_url: "function f(){}", problem: "returns undefined" } });
j = await r.json();
const settleHdr = r.headers.get("X-PAYMENT-RESPONSE");
check("202 with ticket", r.status === 202 && /^[0-9a-f-]{36}$/.test(j.ticket));
check("X-PAYMENT-RESPONSE settlement header", !!settleHdr && JSON.parse(Buffer.from(settleHdr, "base64").toString()).transaction === "0xTX");
check("verify then settle called in order", facilitatorCalls.length === 2 && facilitatorCalls[0].url.endsWith("/verify") && facilitatorCalls[1].url.endsWith("/settle"));
check("queue entry written", store.has("queue:" + j.ticket));
// 6. result pending → operator fills → done
r = await call("GET", "/result/" + j.ticket);
check("result pending", (await r.json()).status === "pending");
const rec = JSON.parse(store.get("t:" + j.ticket));
rec.result = { root_cause: "…", patch: "…" }; rec.delivered_at = "2026-07-26T12:00:00Z";
store.set("t:" + j.ticket, JSON.stringify(rec));
r = await call("GET", "/result/" + j.ticket);
check("result done after fill", (await r.json()).status === "done");
// 7. facilitator rejects → 402
facilitatorMode = "reject"; facilitatorCalls = [];
r = await call("POST", "/review", { headers: { "X-PAYMENT": payment }, body: { code_or_url: "x" } });
j = await r.json();
check("402 on facilitator reject with reason", r.status === 402 && j.error.includes("insufficient_funds"));
// 8. unknown ticket 404, bad id 400
check("unknown ticket 404", (await call("GET", "/result/" + crypto.randomUUID())).status === 404);
check("bad ticket id 400", (await call("GET", "/result/nope")).status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
