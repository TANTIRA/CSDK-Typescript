import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvergeClient, SqlError, csvRecords, parseCsv } from "../dist/index.js";
import { ok, stub } from "./stub.mjs";

const D = "/api/v2/datasets";

test("catalog, branches, schema and paging build the requests the server takes", async () => {
  const s = await stub({
    [`POST ${D}`]: ok({ rid: "ri.ds.1" }),
    [`GET ${D}`]: (r) => ok(r.query.includes("pageToken=p2") ? { data: [{ rid: "b" }] } : { data: [{ rid: "a" }], nextPageToken: "p2" }),
    [`POST ${D}/ri.ds.1/branches`]: ok({ name: "dev" }),
    [`GET ${D}/ri.ds.1/branches`]: ok({ data: [{ name: "master" }] }),
    [`PUT ${D}/ri.ds.1/branches/dev/schema`]: ok({}),
    [`GET ${D}/ri.ds.1/branches/master/readTable`]: (r) => ok(r.query.includes("pageToken=t2")
      ? { rows: [{ id: 2 }] } : { rows: [{ id: 1 }], nextPageToken: "t2" }),
  });
  try {
    const c = new ConvergeClient({ hostname: s.base, token: "t" });
    assert.equal((await c.datasets.create("orders", { parentFolderRid: "ri.f.1" })).rid, "ri.ds.1");
    const all = [];
    for await (const d of c.datasets.iterate(1)) all.push(d.rid);
    assert.deepEqual(all, ["a", "b"]);
    await c.datasets.createBranch("ri.ds.1", "dev", { parentBranch: "master" });
    assert.deepEqual(await c.datasets.listBranches("ri.ds.1"), [{ name: "master" }]);
    await c.datasets.putSchema("ri.ds.1", [{ name: "id", type: "LONG" }], { branch: "dev", primaryKey: ["id"] });
    const rows = [];
    for await (const r of c.datasets.iterateRows("ri.ds.1", { limit: 1, filterColumn: "id", filterOp: "eq", filterValue: "1" })) rows.push(r.id);
    assert.deepEqual(rows, [1, 2]);
    assert.deepEqual(s.seen[0].body, { name: "orders", parentFolderRid: "ri.f.1" });
    assert.equal(s.seen[1].query, "?pageSize=1");
    assert.deepEqual(s.seen[3].body, { name: "dev", parentBranch: "master" });
    assert.deepEqual(s.seen[5].body, { columns: [{ name: "id", type: "LONG" }], primaryKey: ["id"] });
    assert.equal(s.seen[6].query, "?format=json&limit=1&filterColumn=id&filterOp=eq&filterValue=1");
  } finally {
    await s.close();
  }
});

test("withTransaction commits on success and aborts when the callback throws", async () => {
  let n = 0;
  const s = await stub({
    [`POST ${D}/ri.ds.1/branches/master/transactions`]: () => ok({ rid: `ri.tx.${++n}` }),
    [`POST ${D}/ri.ds.1/transactions/ri.tx.1/rows`]: ok({ staged: 1 }),
    [`POST ${D}/ri.ds.1/transactions/ri.tx.1/files`]: ok({ path: "more.csv" }),
    [`POST ${D}/ri.ds.1/transactions/ri.tx.1/commit`]: ok({ status: "COMMITTED" }),
    [`POST ${D}/ri.ds.1/transactions/ri.tx.2/abort`]: ok({ status: "ABORTED" }),
  });
  try {
    const c = new ConvergeClient({ hostname: s.base, token: "t" });
    const staged = await c.datasets.withTransaction("ri.ds.1", "master", "APPEND", async (tx) => {
      await tx.uploadFile('a"\r\nX: 1.csv', new TextEncoder().encode("id\n1\n"), "text/csv");
      return tx.writeRows([{ id: 1 }]);
    });
    assert.equal(staged, 1);
    await assert.rejects(c.datasets.withTransaction("ri.ds.1", "master", "APPEND", async () => { throw new Error("boom"); }), /boom/);
    assert.deepEqual(s.seen.map((r) => r.path.split("/").pop()), ["transactions", "files", "rows", "commit", "transactions", "abort"]);
    const part = s.seen[1].raw.toString();
    assert.match(s.seen[1].headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.ok(part.includes("id\n1\n") && part.includes("Content-Type: text/csv"));
    assert.ok(!/filename="a"\r\n/.test(part) && !part.includes("\r\nX: 1.csv"), part);  // the filename cannot add a header
    await assert.rejects(new ConvergeClient({ hostname: s.base, token: "t" }).datasets.transaction("ri.ds.1")
      .then((tx) => tx.uploadFile("a", new Uint8Array(1), "text/csv\r\nX: 1")), TypeError);
  } finally {
    await s.close();
  }
});

test("SQL polls until done and returns the CSV rows as objects", async () => {
  let polls = 0;
  const s = await stub({
    "POST /api/v2/sqlQueries/execute": ok({ type: "running", queryId: "q/1" }),
    "GET /api/v2/sqlQueries/q%2F1/getStatus": () => ok(++polls < 2 ? { type: "running", queryId: "q/1" } : { type: "succeeded", queryId: "q/1" }),
    "GET /api/v2/sqlQueries/q%2F1/getResults": ok('n,note\r\n2,"a, ""b""\nc"\r\n\r\n3,\r\n'),
    "POST /api/v2/sqlQueries/bad": ok({}),
  });
  try {
    const c = new ConvergeClient({ hostname: s.base, token: "t" });
    assert.deepEqual(await c.sql.execute("SELECT 1", { pollMs: 1 }), [{ n: "2", note: 'a, "b"\nc' }, { n: "3", note: "" }]);
    assert.deepEqual(s.seen[0].body, { query: "SELECT 1", fallbackBranchIds: [], serializationFormat: "CSV" });
  } finally {
    await s.close();
  }
  const f = await stub({ "POST /api/v2/sqlQueries/execute": ok({ type: "failed", errorMessage: "no table" }) });
  try {
    await assert.rejects(new ConvergeClient({ hostname: f.base, token: "t" }).sql.execute("x"), (e) => e instanceof SqlError && e.message === "no table");
  } finally {
    await f.close();
  }
});

test("CSV: quotes, doubled quotes, line breaks in a field, short rows", () => {
  assert.deepEqual(parseCsv('a,b\n"x,1","y""z"\n'), [["a", "b"], ["x,1", 'y"z']]);
  assert.deepEqual(csvRecords("a,b\n1\n"), [{ a: "1", b: null }]);
  assert.deepEqual(csvRecords(""), []);
});
