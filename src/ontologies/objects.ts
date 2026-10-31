/** Objects, object sets and linked objects, by api name. */
import { quote, type Transport } from "../core/transport.js";
import { andAll, toClause, type Where, type WhereClause } from "./where.js";

/** One ontology on one transport. */
export class Ontology {
  readonly transport: Transport;
  readonly rid: string;
  readonly base: string;

  constructor(transport: Transport, ontologyRid: string) {
    this.transport = transport;
    this.rid = ontologyRid;
    this.base = "/v2/ontologies/" + quote(ontologyRid);
  }

  request(method: string, path: string, body?: unknown): Promise<any> {
    return this.transport.request(method, this.base + path, body);
  }
}

/** An object as the API returns it: `$rid` and its visible properties by api name. */
export type OntologyObject = { $rid?: string } & Record<string, unknown>;

export interface Page<T> {
  data: T[];
  nextPageToken: string | null;
  totalCount?: string | null;
}

export interface FetchPageOptions {
  $pageSize?: number;
  $nextPageToken?: string;
}

export type OrderBy = Record<string, "asc" | "desc">;

/** count | sum | avg | min | max | exactDistinct | approximateDistinct. */
export type AggregationType = "count" | "sum" | "avg" | "min" | "max" | "exactDistinct" | "approximateDistinct";

export type DurationUnit = "SECONDS" | "MINUTES" | "HOURS" | "DAYS" | "WEEKS" | "MONTHS" | "QUARTERS" | "YEARS";

/** A property, a range or fixed-width bucket, a date/time bucket (UTC; weeks start on Monday;
 * months, quarters and years follow the calendar), or the maxGroupCount largest exact groups. */
export type GroupBy = string
  | { field: string; ranges: [unknown, unknown][] }
  | { field: string; fixedWidth: number }
  | { field: string; duration: number; unit: DurationUnit }
  | { field: string; maxGroupCount: number };

export interface Metric {
  type: AggregationType;
  field?: string;
  /** Default `<type>`, or `<type>_<field>`; names must be unique. */
  name?: string;
}

/** The link routes take the bare primary key: "c1" from "c1" or from the $rid "customer/c1". */
export function bareKey(primaryKey: string | number): string {
  const k = String(primaryKey);
  const i = k.indexOf("/");
  return i >= 0 ? k.slice(i + 1) : k;
}

/** The objects of one type, narrowed by where(); immutable, so a set can be reused. */
export class ObjectSet<T extends OntologyObject = OntologyObject> {
  readonly #o: Ontology;
  readonly #type: string;
  readonly #filter: WhereClause | undefined;
  readonly #order: { property: string; direction: string } | undefined;
  readonly #select: string[] | undefined;

  constructor(o: Ontology, apiName: string, filter?: WhereClause, order?: { property: string; direction: string }, select?: string[]) {
    this.#o = o;
    this.#type = apiName;
    this.#filter = filter;
    this.#order = order;
    this.#select = select;
  }

  /** The wire where clause of this set, or undefined. */
  get clause(): WhereClause | undefined {
    return this.#filter;
  }

  #path(suffix = ""): string {
    return "/objects/" + quote(this.#type) + suffix;
  }

  where(w: Where): ObjectSet<T> {
    return new ObjectSet(this.#o, this.#type, andAll([this.#filter, toClause(w)]), this.#order, this.#select);
  }

  /** AND in a clause already in the server's wire form (`{ type, property, value, conditions }`). */
  whereClause(raw: WhereClause): ObjectSet<T> {
    if (raw === null || typeof raw !== "object" || typeof raw.type !== "string") {
      throw new TypeError("whereClause takes a { type, ... } clause");
    }
    return new ObjectSet(this.#o, this.#type, andAll([this.#filter, raw]), this.#order, this.#select);
  }

  /** One property: `{ total: "desc" }`. */
  orderBy(order: OrderBy): ObjectSet<T> {
    const keys = Object.entries(order);
    if (keys.length !== 1) throw new TypeError("orderBy takes exactly one property");
    const [property, direction] = keys[0];
    if (direction !== "asc" && direction !== "desc") throw new TypeError("orderBy direction is asc or desc");
    return new ObjectSet(this.#o, this.#type, this.#filter, { property, direction }, this.#select);
  }

  /** Load only these properties; `$rid` always comes back. */
  select(properties: string[]): ObjectSet<T> {
    return new ObjectSet(this.#o, this.#type, this.#filter, this.#order, [...properties]);
  }

  async fetchPage(options: FetchPageOptions = {}): Promise<Page<T>> {
    const body: Record<string, unknown> = { pageSize: options.$pageSize ?? 50 };
    if (this.#filter) body.where = this.#filter;
    if (this.#order) body.orderBy = this.#order;
    if (options.$nextPageToken) body.pageToken = options.$nextPageToken;
    if (this.#select) body.select = this.#select;
    const r = (await this.#o.request("POST", this.#path("/search"), body)) ?? {};
    return { data: r.data ?? [], nextPageToken: r.nextPageToken ?? null, totalCount: r.totalCount ?? null };
  }

  /** Every object, page by page. */
  async *asyncIter(options: { $pageSize?: number } = {}): AsyncGenerator<T> {
    let token: string | undefined;
    do {
      const p = await this.fetchPage({ $pageSize: options.$pageSize, $nextPageToken: token });
      yield* p.data;
      token = p.nextPageToken || undefined;
    } while (token);
  }

  /** At most n objects. */
  async take(n: number): Promise<T[]> {
    const out: T[] = [];
    if (n <= 0) return out;
    for await (const o of this.asyncIter({ $pageSize: Math.min(n, 1000) })) {
      out.push(o);
      if (out.length >= n) break;
    }
    return out;
  }

  /** One object by primary key ("c1") or by its $rid ("customer/c1", what GET takes). */
  fetchOne(primaryKey: string | number): Promise<T> {
    let k = String(primaryKey);
    if (!k.includes("/")) k = this.#type.toLowerCase() + "/" + k;
    return this.#o.request("GET", this.#path("/" + quote(k)));
  }

  /** The objects linked to one object ("c1" or "customer/c1") through linkType. */
  linked<U extends OntologyObject = OntologyObject>(primaryKey: string | number, linkType: string): LinkedObjects<U> {
    return new LinkedObjects(this.#o, this.#path("/" + quote(bareKey(primaryKey)) + "/links/" + quote(linkType)));
  }

  /** One aggregation over this set; the server's answer as is. */
  aggregate(type: AggregationType, options: { field?: string; groupBy?: GroupBy[] } = {}): Promise<any> {
    const agg: Record<string, unknown> = { type };
    if (this.#filter) agg.where = this.#filter;
    if (options.field !== undefined) agg.field = options.field;
    if (options.groupBy?.length) agg.group_by = [...options.groupBy];
    return this.#o.request("POST", this.#path("/aggregate"), { aggregation: agg });
  }

  /** Several metrics (1 to 10) in one call, optionally ordering the groups by one of them (nulls last). */
  aggregateMetrics(metrics: Metric[], options: { groupBy?: GroupBy[]; order?: { metric: string; direction?: "asc" | "desc" } } = {}): Promise<any> {
    const agg: Record<string, unknown> = { metrics: metrics.map((m) => ({ ...m })) };
    if (this.#filter) agg.where = this.#filter;
    if (options.groupBy?.length) agg.group_by = [...options.groupBy];
    if (options.order) agg.order = { direction: "asc", ...options.order };
    return this.#o.request("POST", this.#path("/aggregate"), { aggregation: agg });
  }

  /** The numNeighbors objects of this set whose vector property is closest to query (exact cosine
   * similarity, best first): `{ data: [object + $score], skipped }`, skipped counting readable
   * objects with no comparable vector. */
  nearestNeighbors(query: number[], numNeighbors: number, property: string): Promise<any> {
    const body: Record<string, unknown> = { property, numNeighbors, query: { type: "vector", value: [...query] } };
    if (this.#filter) body.where = this.#filter;
    return this.#o.request("POST", this.#path("/nearestNeighbors"), body);
  }

  /** How many objects are in this set. */
  async count(): Promise<number> {
    const data = (await this.aggregate("count"))?.data ?? [];
    return data.length ? Number(data[0].metrics[0].value) : 0;
  }
}

/** Objects linked to one object through one link type, as the caller may read them. */
export class LinkedObjects<T extends OntologyObject = OntologyObject> {
  readonly #o: Ontology;
  readonly #path: string;

  constructor(o: Ontology, path: string) {
    this.#o = o;
    this.#path = path;
  }

  async fetchPage(options: FetchPageOptions = {}): Promise<Page<T>> {
    let q = `?pageSize=${options.$pageSize ?? 100}`;
    if (options.$nextPageToken) q += "&pageToken=" + quote(options.$nextPageToken);
    const r = (await this.#o.request("GET", this.#path + q)) ?? {};
    return { data: r.data ?? [], nextPageToken: r.nextPageToken ?? null };
  }

  async *asyncIter(options: { $pageSize?: number } = {}): AsyncGenerator<T> {
    let token: string | undefined;
    do {
      const p = await this.fetchPage({ $pageSize: options.$pageSize ?? 1000, $nextPageToken: token });
      yield* p.data;
      token = p.nextPageToken || undefined;
    } while (token);
  }

  /** One linked object; a ConvergeRPCError 404 when it is not linked. */
  fetchOne(primaryKey: string | number): Promise<T> {
    return this.#o.request("GET", this.#path + "/" + quote(bareKey(primaryKey)));
  }
}
