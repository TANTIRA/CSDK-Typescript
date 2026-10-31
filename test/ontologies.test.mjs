import assert from "node:assert/strict";
import { test } from "node:test";

import { ConvergeClient, toClause } from "../dist/index.js";
import { ok, stub } from "./stub.mjs";

const O = "/api/v2/ontologies/my%20onto";

test("where: object form -> the server's clause, with $not and flat and/or", () => {
  assert.deepEqual(toClause({ total: { $gt: 1, $lte: 9 }, status: "open", note: null }), { type: "and", conditions: [
    { type: "gt", property: "total", value: 1 }, { type: "lte", property: "total", value: 9 },
    { type: "eq", property: "status", value: "open" }, { type: "isNull", property: "note", value: true }] });
  assert.deepEqual(toClause({ $not: { status: "closed" } }), { type: "not", conditions: [{ type: "eq", property: "status", value: "closed" }] });
  assert.deepEqual(toClause({ note: { $isNull: false } }), { type: "not", conditions: [{ type: "isNull", property: "note", value: true }] });
  assert.deepEqual(toClause({ $not: {} }), { type: "or", conditions: [] });  // not(everything): nothing
  assert.deepEqual(toClause({ $or: [] }), { type: "or", conditions: [] });
  assert.equal(toClause({ $or: [{}, { a: 1 }] }), undefined);              // a filterless branch: no filter
  assert.equal(toClause({ a: undefined }), undefined);
  assert.deepEqual(toClause({ $and: [{ a: 1 }, { $and: [{ b: 2 }] }] }), { type: "and", conditions: [
    { type: "eq", property: "a", value: 1 }, { type: "eq", property: "b", value: 2 }] });
  assert.deepEqual(toClause({ id: { $startsWith: "o.1(" } }), { type: "regex", property: "id", value: "o\\.1\\([\\s\\S]*" });
  for (const [w, msg] of [[{ a: {} }, "{} has no operator"], [{ a: { $lt: undefined } }, "a.$lt is undefined"],
    [{ a: { $isNull: 0 } }, "$isNull takes true or false"], [{ a: { $nin: [1] } }, "$nin is not supported"],
    [{ a: { $in: [] } }, "$in needs at least one value"], [{ a: { $range: [1] } }, "$range takes [lo, hi]"],
    [{ $nope: 1 }, "$nope is not supported"], [{ at: new Date(0) }, "not a Date"]]) {
    assert.throws(() => toClause(w), (e) => e instanceof TypeError && e.message.includes(msg), msg);
  }
});

test("where: $ne, $in, $range, $regex, nested $or and double $not (depth parity with the Python SDK)", () => {
  const eq = (p, v) => ({ type: "eq", property: p, value: v });
  assert.deepEqual(toClause({ a: { $ne: 1 } }), { type: "not", conditions: [eq("a", 1)] });
  assert.deepEqual(toClause({ a: { $ne: null } }), { type: "not", conditions: [{ type: "isNull", property: "a", value: true }] });
  assert.deepEqual(toClause({ a: { $in: [1, 2] } }), { type: "or", conditions: [eq("a", 1), eq("a", 2)] });
  assert.deepEqual(toClause({ a: { $in: [1] } }), eq("a", 1));
  assert.deepEqual(toClause({ a: { $range: [1, 5] }, b: { $regex: "x.*" } }), { type: "and", conditions: [
    { type: "range", property: "a", value: [1, 5] }, { type: "regex", property: "b", value: "x.*" }] });
  assert.deepEqual(toClause({ $or: [{ a: 1 }, { $or: [{ b: 2 }, { c: { $in: [3, 4] } }] }] }),
    { type: "or", conditions: [eq("a", 1), eq("b", 2), eq("c", 3), eq("c", 4)] });
  assert.deepEqual(toClause({ $or: [{ a: 1 }] }), eq("a", 1));
  assert.deepEqual(toClause({ $not: { $not: { a: 1 } } }), eq("a", 1));
  assert.deepEqual(toClause({ $not: { a: { $ne: 1 } } }), eq("a", 1));
});

test("whereClause ANDs in a raw server clause", async () => {
  const s = await stub({ [`POST ${O}/objects/Order/search`]: ok({ data: [] }) });
  try {
    const set = new ConvergeClient({ hostname: s.base, token: "t" }).ontology("my onto").objects("Order")
      .where({ a: 1 }).whereClause({ type: "range", property: "t", value: [1, 2] });
    await set.fetchPage();
    assert.deepEqual(s.seen[0].body.where, { type: "and", conditions: [
      { type: "eq", property: "a", value: 1 }, { type: "range", property: "t", value: [1, 2] }] });
    assert.deepEqual(set.clause, s.seen[0].body.where);
    assert.throws(() => set.whereClause({ property: "x" }), TypeError);
  } finally {
    await s.close();
  }
});

test("objects: search body, paging, fetchOne, linked, aggregate and count", async () => {
  const s = await stub({
    [`POST ${O}/objects/Order/search`]: (r) => ok(r.body.pageToken
      ? { data: [{ $rid: "order/o2", orderId: "o2" }], nextPageToken: null, totalCount: "2" }
      : { data: [{ $rid: "order/o1", orderId: "o1" }], nextPageToken: "p2", totalCount: "2" }),
    [`GET ${O}/objects/Order/order%2Fo1`]: ok({ $rid: "order/o1", orderId: "o1" }),
    [`GET ${O}/objects/Order/o1/links/placedBy`]: ok({ data: [{ $rid: "customer/c1" }], nextPageToken: null }),
    [`GET ${O}/objects/Order/o1/links/placedBy/c1`]: ok({ $rid: "customer/c1" }),
    [`POST ${O}/objects/Order/aggregate`]: ok({ data: [{ group: {}, metrics: [{ name: "count", value: 2 }] }] }),
  });
  try {
    const o = new ConvergeClient({ hostname: s.base, token: "t" }).ontology("my onto");
    const set = o.objects("Order").where({ total: { $gt: 1 } }).where({ $not: { orderId: "x" } });
    const page = await set.orderBy({ total: "desc" }).select(["orderId"]).fetchPage({ $pageSize: 1 });
    assert.deepEqual(page, { data: [{ $rid: "order/o1", orderId: "o1" }], nextPageToken: "p2", totalCount: "2" });
    assert.deepEqual((await set.take(5)).map((x) => x.orderId), ["o1", "o2"]);
    assert.equal((await o.objects("Order").fetchOne("o1")).orderId, "o1");
    assert.equal((await o.objects("Order").fetchOne("order/o1")).orderId, "o1");
    const linked = o.objects("Order").linked("order/o1", "placedBy");
    assert.deepEqual((await linked.fetchPage()).data, [{ $rid: "customer/c1" }]);
    assert.equal((await linked.fetchOne("customer/c1")).$rid, "customer/c1");
    assert.equal(await set.count(), 2);
    await o.objects("Order").aggregate("sum", { field: "total", groupBy: ["status", { field: "total", fixedWidth: 10 }] });
    const where = { type: "and", conditions: [{ type: "gt", property: "total", value: 1 },
      { type: "not", conditions: [{ type: "eq", property: "orderId", value: "x" }] }] };
    assert.deepEqual(s.seen[0].body, { pageSize: 1, where, orderBy: { property: "total", direction: "desc" }, select: ["orderId"] });
    assert.deepEqual(s.seen[1].body, { pageSize: 5, where });
    assert.deepEqual(s.seen[2].body, { pageSize: 5, where, pageToken: "p2" });
    assert.equal(s.seen[5].query, "?pageSize=100");
    assert.deepEqual(s.seen[7].body, { aggregation: { type: "count", where } });
    assert.deepEqual(s.seen[8].body, { aggregation: { type: "sum", field: "total", group_by: ["status", { field: "total", fixedWidth: 10 }] } });
    assert.throws(() => o.objects("Order").orderBy({ a: "asc", b: "desc" }), TypeError);
    const e = await o.objects("Order").fetchOne("missing").catch((x) => x);
    assert.equal(e.status, 404);
    assert.equal(e.errorName, "NotFound");
  } finally {
    await s.close();
  }
});

test("actions, batch actions, queries and attachments", async () => {
  const s = await stub({
    [`POST ${O}/actions/place_order/apply`]: ok({ validation: { result: "VALID" }, edits: null }),
    [`POST ${O}/actions/place_order/applyBatch`]: ok({ results: [{}, {}] }),
    [`POST ${O}/queries/clv/execute`]: ok({ value: 42 }),
    "POST /api/v2/ontologies/attachments/upload": ok({ rid: "ri.att.1" }),
    "GET /api/v2/ontologies/attachments/ri.att.1": ok({ rid: "ri.att.1", filename: "a.txt" }),
    "GET /api/v2/ontologies/attachments/ri.att.1/content": ok("abc"),
  });
  try {
    const o = new ConvergeClient({ hostname: s.base, token: "t" }).ontology("my onto");
    const r = await o.action("place_order")({ order_id: "o9" }, { mode: "VALIDATE_ONLY", returnEdits: "ALL" });
    assert.deepEqual(r, { validation: { result: "VALID" }, edits: null });
    await o.action("place_order")({ order_id: "o9" });
    await o.batchAction("place_order")([{ order_id: "a" }, { order_id: "b" }], { returnEdits: "NONE" });
    await assert.rejects(o.batchAction("place_order")([]), RangeError);
    assert.equal(await o.query("clv")({ customer: "c1" }), 42);
    assert.equal((await o.attachments.upload(new TextEncoder().encode("abc"), "a.txt", "text/plain")).rid, "ri.att.1");
    await assert.rejects(o.attachments.upload(new Uint8Array(1), "a", "text/plain\r\nX: 1"), TypeError);
    await assert.rejects(o.attachments.upload("not bytes", "a", "text/plain"), TypeError);
    assert.equal((await o.attachments.get("ri.att.1")).filename, "a.txt");
    assert.equal(new TextDecoder().decode(await o.attachments.read("ri.att.1")), "abc");
    assert.deepEqual(s.seen[0].body, { parameters: { order_id: "o9" }, options: { mode: "VALIDATE_ONLY", returnEdits: "ALL" } });
    assert.deepEqual(s.seen[1].body, { parameters: { order_id: "o9" } });
    assert.deepEqual(s.seen[2].body, { requests: [{ parameters: { order_id: "a" } }, { parameters: { order_id: "b" } }], options: { returnEdits: "NONE" } });
    assert.deepEqual(s.seen[3].body, { parameters: { customer: "c1" } });
    assert.ok(s.seen[4].raw.toString().includes('filename="a.txt"'));
  } finally {
    await s.close();
  }
});
