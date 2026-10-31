import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvergeClient, createConfidentialOauthClient, createPublicOauthClient, geoPoint, geoShape } from "../dist/index.js";

const kc = "https://h.example/kc/realms/converge";

function idp() {
  const calls = [];
  const fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? ""), auth: new Headers(init?.headers).get("Authorization") });
    if (url === `${kc}/.well-known/openid-configuration`) {
      return Response.json({ issuer: kc, authorization_endpoint: `${kc}/protocol/openid-connect/auth`,
        token_endpoint: `${kc}/protocol/openid-connect/token` });
    }
    const form = new URLSearchParams(String(init?.body));
    if (form.get("code") === "bad") return Response.json({ error: "invalid_grant", access_token: "leak" }, { status: 400 });
    return Response.json({ access_token: `at-${form.get("grant_type")}-${calls.length}`, expires_in: 300, refresh_token: "rt" });
  };
  return { calls, fetch };
}

test("client credentials: Basic auth, cached token, never in a browser", async () => {
  const { calls, fetch } = idp();
  const auth = createConfidentialOauthClient("svc", "s3cr3t:/", "https://h.example/api", ["api"], fetch);
  const a = await auth(), b = await auth();
  assert.equal(a, b);
  assert.match(a, /^at-client_credentials/);
  const tok = calls.find((c) => c.url.endsWith("/token"));
  assert.equal(tok.body, "grant_type=client_credentials&scope=api");  // the secret is not in the body
  assert.equal(Buffer.from(tok.auth.split(" ")[1], "base64").toString(), "svc:s3cr3t%3A%2F");
  // the token function is what ConvergeClient takes as auth
  assert.equal(String(new ConvergeClient({ hostname: "https://h.example/api", auth })), "ConvergeClient(https://h.example/api)");
  globalThis.document = {};
  try {
    assert.throws(() => createConfidentialOauthClient("svc", "x", "https://h.example"), /server-side only/);
  } finally {
    delete globalThis.document;
  }
  await assert.rejects(createConfidentialOauthClient("svc", "x", "http://h.example", [], fetch)(), /must be https/);
});

test("public client: PKCE round trip, state check, no token in errors", async () => {
  const { calls, fetch } = idp();
  let href = "https://app.example/home";
  const assigned = [];
  const store = new Map();
  Object.assign(globalThis, {
    location: { get href() { return href; }, assign(u) { assigned.push(u); } },
    history: { state: null, replaceState(_d, _u, url) { href = url; } },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  });
  try {
    void createPublicOauthClient("app", "https://h.example/api", "https://app.example/cb", { fetch })();
    for (let i = 0; i < 100 && !assigned.length; i++) await new Promise((r) => setTimeout(r, 2));
    const u = new URL(assigned[0]);
    assert.equal(u.origin + u.pathname, `${kc}/protocol/openid-connect/auth`);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("code_challenge").length, 43);
    href = `https://app.example/cb?code=c1&state=${u.searchParams.get("state")}`;
    const back = createPublicOauthClient("app", "https://h.example/api", "https://app.example/cb", { fetch });
    assert.match(await back(), /^at-authorization_code/);
    assert.equal(href, "https://app.example/cb");
    assert.ok(calls.some((c) => c.body.includes("code_verifier=")));
    assert.match(await back.refresh(), /^at-refresh_token/);

    store.set("osdk-oauth:app:pkce", JSON.stringify({ verifier: "v", state: "good" }));
    href = "https://app.example/cb?code=c2&state=evil";
    await assert.rejects(createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { fetch })(),
                         /state does not match/);
    assert.ok(!calls.some((c) => c.body.includes("code=c2")));

    store.set("osdk-oauth:app:pkce", JSON.stringify({ verifier: "v", state: "s" }));
    href = "https://app.example/cb?code=bad&state=s";
    await assert.rejects(createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { fetch })(), (e) => {
      assert.ok(!JSON.stringify(e.body).includes("leak") && e.body.error === "invalid_grant");
      return true;
    });
  } finally {
    for (const k of ["location", "history", "sessionStorage"]) delete globalThis[k];
  }
});

test("geo values as GeoJSON", () => {
  assert.deepEqual(geoPoint("52.1, 4.3"), { type: "Point", coordinates: [4.3, 52.1] });
  assert.deepEqual(geoPoint('{"type":"Point","coordinates":[1,2]}'), { type: "Point", coordinates: [1, 2] });
  assert.equal(geoPoint("not a point"), undefined);
  assert.equal(geoPoint({ type: "Polygon", coordinates: [] }), undefined);
  const poly = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  assert.deepEqual(geoShape(JSON.stringify({ type: "Feature", geometry: poly })), poly);
  assert.equal(geoShape("{oops"), undefined);
});

test("an action that needs approval keeps its approval id", async () => {
  const fetch = async () => new Response(JSON.stringify({ status: "pending_approval", approval_id: "a1", action: "refund",
    requested_by: "u1" }), { status: 202, headers: { "Content-Type": "application/json" } });
  const c = new ConvergeClient({ hostname: "https://h.example/api", token: "t", fetch });
  assert.deepEqual(await c.ontology("o").action("refund")({ order: "o1" }),
                   { status: "pending_approval", approval_id: "a1", action: "refund", requested_by: "u1" });
});
