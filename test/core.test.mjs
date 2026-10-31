import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import util from "node:util";

import { ConfigError, ConvergeClient, ConvergeRPCError, UserTokenAuth, parseConfig, resolve } from "../dist/index.js";
import { ok, stub } from "./stub.mjs";

const SECRET = "tok-secret-123";

function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of ["CONVERGE_HOSTNAME", "CONVERGE_TOKEN", "FOUNDRY_TOKEN"]) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("arguments, then the environment, then the config file", () => {
  const none = path.join(os.tmpdir(), "csdk-none-" + process.pid);
  withEnv({}, () => assert.deepEqual(resolve("h.example", SECRET, none), { base: "https://h.example", token: SECRET }));
  withEnv({ CONVERGE_HOSTNAME: "http://e.example/api/", CONVERGE_TOKEN: "env-tok" },
    () => assert.deepEqual(resolve(undefined, undefined, none), { base: "http://e.example/api", token: "env-tok" }));
  withEnv({ CONVERGE_HOSTNAME: "e.example", FOUNDRY_TOKEN: "f-tok" },
    () => assert.deepEqual(resolve(undefined, undefined, none), { base: "https://e.example", token: "f-tok" }));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csdk-")), "config");
  fs.writeFileSync(file, "[other]\ntoken = no\n[default]\nhostname = f.example\ntoken: file-tok\n");
  withEnv({}, () => assert.deepEqual(resolve(undefined, undefined, file), { base: "https://f.example", token: "file-tok" }));
  assert.deepEqual(parseConfig("# c\n[default]\n; c\nHostName = a=b\n"), { hostname: "a=b" });
});

test("a missing value is named, never a value", () => {
  withEnv({ CONVERGE_TOKEN: SECRET }, () => {
    assert.throws(() => resolve(undefined, undefined, "/nonexistent/config"), (e) => {
      assert.ok(e instanceof ConfigError && e.message.includes("hostname") && !e.message.includes(SECRET));
      return true;
    });
  });
});

test("the token never shows in toString, JSON, inspect or an error", async () => {
  const s = await stub({ "GET /api/v2/datasets/ri.x": ok({ message: "nope" }, 403) });
  try {
    const client = new ConvergeClient({ hostname: s.base, token: SECRET });
    const err = await client.datasets.get("ri.x").catch((e) => e);
    assert.ok(err instanceof ConvergeRPCError && err.status === 403);
    const auth = new UserTokenAuth(SECRET);
    for (const text of [String(client), JSON.stringify(client), util.inspect(client, { depth: 9 }),
      String(auth), JSON.stringify({ auth }), util.inspect(auth, { depth: 9, showHidden: true }),
      String(err), util.inspect(err), JSON.stringify(err), String(client.transport), util.inspect(client.transport)]) {
      assert.ok(!text.includes(SECRET), text);
    }
    assert.equal(s.seen[0].headers.authorization, "Bearer " + SECRET);
  } finally {
    await s.close();
  }
});

test("a token with a space or line break is refused without echoing it", async () => {
  const s = await stub({ "GET /api/v2/datasets/ri.x": ok({}) });
  try {
    for (const bad of [SECRET + "\n", SECRET + "\r\nX-Evil: 1", "a b"]) {
      const client = new ConvergeClient({ hostname: s.base, token: bad });
      const e = await client.datasets.get("ri.x").catch((x) => x);
      assert.ok(e instanceof ConfigError && !e.message.includes(SECRET), String(e));
    }
    assert.equal(s.seen.length, 0);
    // a function token is read per request
    let n = 0;
    const c = new ConvergeClient({ hostname: s.base, auth: async () => `t${++n}` });
    await c.datasets.get("ri.x");
    await c.datasets.get("ri.x");
    assert.deepEqual(s.seen.map((r) => r.headers.authorization), ["Bearer t1", "Bearer t2"]);
  } finally {
    await s.close();
  }
});

test("a token is never sent over plain http, except to localhost", () => {
  for (const base of ["http://converge.example.com/api", "ftp://converge.example.com/api",
    "http://127.0.0.1.evil.example/api", "http://localhost@evil.example/api", "http://localhost.evil.example/api",
    "https://user:pw@converge.example.com/api", "not a url"]) {
    assert.throws(() => new ConvergeClient({ hostname: base, token: SECRET }), (e) => {
      assert.ok(e instanceof ConfigError && !e.message.includes(SECRET) && !e.message.includes("pw"), String(e));
      return true;
    }, base);
  }
  for (const base of ["https://converge.example.com/api", "HTTPS://Converge.Example.com/api", "http://127.0.0.1:8080/api",
    "http://localhost/api", "HTTP://LOCALHOST/api", "http://[::1]:9/api"]) {
    new ConvergeClient({ hostname: base, token: SECRET });
  }
});

test("a redirect is refused and the token never follows it", async () => {
  const elsewhere = await stub({ "GET /steal": ok({}) });
  const s = await stub({ "GET /api/v2/datasets/ri.x": ok(undefined, 302, { Location: elsewhere.base.replace("/api", "") + "/steal" }) });
  try {
    const e = await new ConvergeClient({ hostname: s.base, token: SECRET }).datasets.get("ri.x").catch((x) => x);
    assert.ok(e instanceof ConvergeRPCError && e.status === 302);
    assert.equal(elsewhere.seen.length, 0);
  } finally {
    await s.close();
    await elsewhere.close();
  }
});
