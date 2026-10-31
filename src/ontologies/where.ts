/**
 * Where clauses, in object form:
 *
 *     { total: { $gt: 100 }, status: "open", note: null, $or: [...], $not: {...} }
 *
 * The server's grammar is eq, gt, gte, lt, lte, range, regex, isNull, and, or, not. `$startsWith`
 * becomes a full-match regex, `$isNull: false` and `$ne` become not(...), and `$in` (the server
 * has no `in`) becomes an `or` of `eq`. and/or stay flat, a single-clause `or` is that clause, and
 * a double not cancels, because the server caps where depth at 5.
 */

/** The wire form the server takes. */
export interface WhereClause {
  type: string;
  property?: string;
  value?: unknown;
  conditions?: WhereClause[];
}

export interface PropertyFilter {
  $eq?: unknown;
  /** not(eq): also true for an object with no value; `$ne: null` is `$isNull: false`. */
  $ne?: unknown;
  /** One of these values; at least one. */
  $in?: unknown[];
  /** [lo, hi], both included. */
  $range?: [unknown, unknown];
  /** Matches the whole value; the server refuses ^ and $. */
  $regex?: string;
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $isNull?: boolean;
  $startsWith?: string;
}

/** A filter: `{ property: value }` for equality, `{ property: null }` for no value, or an operator
 * object; several keys must all match. */
export type Where = {
  $and?: Where[];
  $or?: Where[];
  $not?: Where;
} & { [property: string]: unknown };

const OPS = new Set(["$eq", "$gt", "$gte", "$lt", "$lte", "$isNull"]);

/** Clauses ANDed, nested ANDs flattened; undefined = no filter. */
export function andAll(cs: (WhereClause | undefined)[]): WhereClause | undefined {
  const flat = cs.flatMap((c) => (!c ? [] : c.type === "and" ? c.conditions ?? [] : [c]));
  return flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : { type: "and", conditions: flat };
}

/** Clauses ORed, nested ORs flattened, one clause is itself; none matches nothing. */
export function orAll(cs: WhereClause[]): WhereClause {
  const flat = cs.flatMap((c) => (c.type === "or" ? c.conditions ?? [] : [c]));
  return flat.length === 1 ? flat[0] : { type: "or", conditions: flat };
}

/** not(c); a double not cancels. */
export function not(c: WhereClause): WhereClause {
  return c.type === "not" && c.conditions?.length === 1 ? c.conditions[0] : { type: "not", conditions: [c] };
}

/** Object-form filter -> the wire clause; undefined = no filter. */
export function toClause(w: Where): WhereClause | undefined {
  if (w === null || typeof w !== "object" || Array.isArray(w)) throw new TypeError("where takes an object");
  const conds: (WhereClause | undefined)[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    if (k === "$and") {
      conds.push(andAll((v as Where[]).map((x) => toClause(x))));
    } else if (k === "$or") {
      const parts = (v as Where[]).map((x) => toClause(x));
      // a branch without a filter matches everything, so the whole $or does; $or: [] matches nothing
      if (!parts.some((x) => x === undefined)) conds.push(orAll(parts as WhereClause[]));
    } else if (k === "$not") {
      const inner = toClause(v as Where);
      // not(no filter) matches nothing
      conds.push(inner ? not(inner) : { type: "or", conditions: [] });
    } else if (k.startsWith("$")) {
      throw new TypeError(`where ${k} is not supported by this API`);
    } else if (v === null) {
      conds.push({ type: "isNull", property: k, value: true });
    } else if (typeof v !== "object" || Array.isArray(v)) {
      conds.push({ type: "eq", property: k, value: v });  // { prop: value } shorthand
    } else if (Object.getPrototypeOf(v) !== Object.prototype) {
      // a Date would go as a plain string and never equal a typed timestamp
      throw new TypeError(`where ${k}: pass an ISO string or { $eq: ... }, not a ${(v as object).constructor?.name}`);
    } else {
      const ops = Object.entries(v as Record<string, unknown>);
      // never widen silently: an operator without a value is a caller bug, not "no filter"
      if (ops.length === 0) throw new TypeError(`where ${k}: {} has no operator`);
      for (const [op, value] of ops) {
        if (value === undefined) throw new TypeError(`where ${k}.${op} is undefined`);
        if (op === "$startsWith") {
          // a full-match regex on the server; [\s\S] so multi-line values match too
          conds.push({ type: "regex", property: k, value: String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*" });
        } else if ((op === "$isNull" && value === false) || (op === "$ne" && value === null)) {
          conds.push(not({ type: "isNull", property: k, value: true }));
        } else if (op === "$isNull" && value !== true) {
          throw new TypeError("where $isNull takes true or false");
        } else if (op === "$ne") {
          conds.push(not({ type: "eq", property: k, value }));
        } else if (op === "$in") {
          if (!Array.isArray(value) || value.length === 0) throw new TypeError(`where ${k}.$in needs at least one value`);
          conds.push(orAll(value.map((x) => ({ type: "eq", property: k, value: x }))));
        } else if (op === "$range") {
          if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`where ${k}.$range takes [lo, hi]`);
          conds.push({ type: "range", property: k, value: [value[0], value[1]] });
        } else if (op === "$regex") {
          conds.push({ type: "regex", property: k, value: String(value) });
        } else if (OPS.has(op)) {
          conds.push({ type: op.slice(1), property: k, value });
        } else {
          throw new TypeError(`where ${op} is not supported by this API`);
        }
      }
    }
  }
  return andAll(conds);
}
