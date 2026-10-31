/**
 * Where clauses, in the OSDK 2.x object form:
 *
 *     { total: { $gt: 100 }, status: "open", note: null, $or: [...], $not: {...} }
 *
 * The server's grammar is eq, gt, gte, lt, lte, range, regex, isNull, and, or, not. `$startsWith`
 * becomes a full-match regex, `$isNull: false` becomes not(isNull). and/or stay flat, because the
 * server caps where depth at 5.
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
      if (!parts.some((x) => x === undefined)) conds.push({ type: "or", conditions: parts as WhereClause[] });
    } else if (k === "$not") {
      const inner = toClause(v as Where);
      // not(no filter) matches nothing
      conds.push(inner ? { type: "not", conditions: [inner] } : { type: "or", conditions: [] });
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
        } else if (op === "$isNull" && value === false) {
          conds.push({ type: "not", conditions: [{ type: "isNull", property: k, value: true }] });
        } else if (op === "$isNull" && value !== true) {
          throw new TypeError("where $isNull takes true or false");
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
