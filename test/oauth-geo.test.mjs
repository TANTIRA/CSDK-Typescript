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

test("discovery refuses another issuer or another origin, so the secret is never sent", async () => {
  const good = { issuer: kc, authorization_endpoint: `${kc}/protocol/openid-connect/auth`,
                 token_endpoint: `${kc}/protocol/openid-connect/token` };
  for (const [config, why] of [[{ ...good, token_endpoint: "https://evil.example/token" }, /not on the issuer's origin/],
                               [{ ...good, issuer: "https://evil.example" }, /another issuer/]]) {
    const urls = [];
    const fetch = async (u) => { urls.push(String(u)); return Response.json(config); };
    await assert.rejects(createConfidentialOauthClient("svc", "TOP-SECRET", "https://h.example/api", [], fetch)(),
                         (e) => why.test(String(e.body)));
    assert.deepEqual(urls, [`${kc}/.well-known/openid-configuration`]);
  }
});

test("refresh: one at a time with rotation, a 503 keeps the session, short tokens cached briefly", async () => {
  let live = "rt-0", issued = 0, outage = false, refreshes = 0, grants = 0;
  const fetch = async (input, init) => {
    if (String(input).endsWith("/openid-configuration")) {
      return Response.json({ issuer: kc, authorization_endpoint: `${kc}/a`, token_endpoint: `${kc}/t` });
    }
    const form = new URLSearchParams(String(init?.body));
    if (outage) return new Response("down", { status: 503 });
    if (form.get("grant_type") === "client_credentials") return Response.json({ access_token: `cc-${++grants}`, expires_in: 10 });
    refreshes++;
    if (form.get("refresh_token") !== live) return Response.json({ error: "invalid_grant" }, { status: 400 });
    live = `rt-${++issued}`;
    return Response.json({ access_token: `at-${issued}`, expires_in: 0, refresh_token: live });
  };
  const store = new Map([["osdk-oauth:app:refresh", live]]);
  let href = "https://app.example/cb";
  Object.assign(globalThis, {
    location: { get href() { return href; }, assign() {} },
    history: { state: null, replaceState(_d, _u, u) { href = u; } },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  });
  try {
    const pub = createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { fetch, storage: "sessionStorage" });
    const race = await Promise.all([pub(), pub.refresh(), pub.refresh()]);
    assert.equal(refreshes, 1);
    assert.equal(new Set(race).size, 1);
    outage = true;
    await assert.rejects(pub.refresh(), (e) => e.status === 503);
    outage = false;
    assert.equal(await pub.refresh(), `at-${issued}`);
    assert.equal(store.get("osdk-oauth:app:refresh"), live);

    // the code leaves the address bar as soon as the client is created
    store.set("osdk-oauth:app:pkce", JSON.stringify({ verifier: "v", state: "s1" }));
    href = "https://app.example/cb?code=c9&state=s1&keep=1";
    createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { fetch });
    assert.equal(href, "https://app.example/cb?keep=1");
  } finally {
    for (const k of ["location", "history", "sessionStorage"]) delete globalThis[k];
  }
  const cc = createConfidentialOauthClient("svc", "s", "https://h.example", [], fetch);
  await cc();
  await cc();
  assert.equal(grants, 1);  // 10 s to live: cached for 5 s, not stretched to 30 s
});

test("a web worker is a browser too", () => {
  globalThis.importScripts = () => {};
  try {
    assert.throws(() => createConfidentialOauthClient("svc", "x", "https://h.example"), /server-side only/);
  } finally {
    delete globalThis.importScripts;
  }
});

test("geo values are validated", () => {
  for (const bad of ["0x10,0x20", "91,0", "1,181", "1e2,3", " ,1", "1,2,3"]) assert.equal(geoPoint(bad), undefined, bad);
  assert.equal(geoPoint({ type: "Point", coordinates: [200, 0] }), undefined);
  assert.equal(geoShape('{"type":"Polygon","coordinates":[[[0,0],[1,"x"]]]}'), undefined);
  assert.equal(geoShape('{"type":"toString","coordinates":[]}'), undefined);
  assert.deepEqual(geoShape({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }] }),
                   { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }] });
});

test("the public client can be built in Node (SSR) without a page", () => {
  assert.equal(typeof globalThis.location, "undefined");
  assert.equal(typeof createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { storage: "sessionStorage" }),
               "function");
});

test("discovery failures and 429s keep the session; a sign-out during a refresh stays signed out; no expires_in caches", async () => {
  let live = "rt-0", issued = 0, noDiscovery = false, limited = false, slow = false, grants = 0;
  const fetch = async (input, init) => {
    if (String(input).endsWith("/openid-configuration")) {
      return noDiscovery ? Response.json({}, { status: 404 })
        : Response.json({ issuer: kc, authorization_endpoint: `${kc}/a`, token_endpoint: `${kc}/t` });
    }
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "client_credentials") return Response.json({ access_token: `cc-${++grants}` });
    if (limited) return Response.json({ error: "slow_down" }, { status: 429 });
    if (slow) await new Promise((r) => setTimeout(r, 20));
    if (form.get("refresh_token") !== live) return Response.json({ error: "invalid_grant" }, { status: 400 });
    live = `rt-${++issued}`;
    return Response.json({ access_token: `at-${issued}`, expires_in: 0, refresh_token: live });
  };
  const store = new Map([["osdk-oauth:app:refresh", live]]);
  Object.assign(globalThis, {
    location: { href: "https://app.example/cb", assign() {} },
    history: { state: null, replaceState() {} },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  });
  try {
    const pub = createPublicOauthClient("app", "https://h.example", "https://app.example/cb", { fetch, storage: "sessionStorage" });
    noDiscovery = true;
    await assert.rejects(pub.refresh(), (e) => e.status === 404);
    noDiscovery = false;
    limited = true;
    await assert.rejects(pub.refresh(), (e) => e.status === 429);
    limited = false;
    assert.equal(store.get("osdk-oauth:app:refresh"), "rt-0");
    slow = true;
    const inflight = pub.refresh();
    await pub.signOut();
    await assert.rejects(inflight, /signed out while the token was requested/);
    assert.equal(await pub.refresh(), undefined);
    assert.equal(store.get("osdk-oauth:app:refresh"), undefined);
  } finally {
    for (const k of ["location", "history", "sessionStorage"]) delete globalThis[k];
  }
  const cc = createConfidentialOauthClient("svc", "s", "https://h.example", [], fetch);
  await cc();
  await cc();
  assert.equal(grants, 1);
});
