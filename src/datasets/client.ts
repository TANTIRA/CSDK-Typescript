/**
 * Datasets: catalog, branches, schema, transactions, files, rows and SQL. Covers the routes
 * the server has under /v2/datasets and /v2/sqlQueries. Not available yet (no server route the
 * SDK uses): dataset views, projections, retention policies, Iceberg tables and the SQL job list.
 */
import { ConvergeError } from "../core/errors.js";
import { parse, quote, type Transport } from "../core/transport.js";
import { csvRecords } from "./csv.js";

const DS = "/v2/datasets";

export type TransactionType = "APPEND" | "UPDATE" | "DELETE" | "SNAPSHOT";

function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? "?" + s : "";
}

async function* pages(fetch: (token?: string) => Promise<any>): AsyncGenerator<any> {
  let token: string | undefined;
  do {
    const r = (await fetch(token)) ?? {};
    yield* r.data ?? [];
    token = r.nextPageToken || undefined;
  } while (token);
}

/** Bytes for a multipart part: a Uint8Array, an ArrayBuffer or a Blob. */
export type Bytes = Uint8Array | ArrayBuffer | Blob;

/** A multipart body with one `file` part. FormData escapes the filename for the header. */
export function filePart(data: Bytes, filename: string, mediaType: string): FormData {
  if (!(data instanceof Uint8Array || data instanceof ArrayBuffer || data instanceof Blob)) {
    throw new TypeError("data must be a Uint8Array, an ArrayBuffer or a Blob");
  }
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart], { type: mediaType }), String(filename) || "unnamed");
  return form;
}

/** An open transaction. `withTransaction` commits it, or aborts it when the callback throws. */
export class Transaction {
  readonly datasetRid: string;
  readonly rid: string;
  info: any;
  readonly #t: Transport;

  constructor(transport: Transport, datasetRid: string, info: any) {
    this.#t = transport;
    this.datasetRid = datasetRid;
    this.info = info;
    this.rid = info.rid;
  }

  #path(suffix: string): string {
    return `${DS}/${quote(this.datasetRid)}/transactions/${quote(this.rid)}${suffix}`;
  }

  /** Stage rows in this transaction -> how many were staged. */
  async writeRows(rows: Record<string, unknown>[]): Promise<number | undefined> {
    return ((await this.#t.request("POST", this.#path("/rows"), { rows: [...rows] })) ?? {}).staged;
  }

  /** Stage one file. A .csv file is parsed into rows on commit. */
  async uploadFile(filename: string, data: Bytes, mediaType = "application/octet-stream"): Promise<any> {
    if (/[\r\n]/.test(mediaType)) throw new TypeError("uploadFile: mediaType may not contain a line break");
    return parse(await this.#t.send("POST", this.#t.base + this.#path("/files"), filePart(data, filename, mediaType)));
  }

  async commit(): Promise<any> {
    this.info = await this.#t.request("POST", this.#path("/commit"));
    return this.info;
  }

  async abort(): Promise<any> {
    this.info = await this.#t.request("POST", this.#path("/abort"));
    return this.info;
  }
}

export class DatasetsClient {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  // ---- catalog
  create(name: string, options: { parentFolderRid?: string; description?: string } = {}): Promise<any> {
    return this.#t.request("POST", DS, { name, ...options });
  }

  get(rid: string): Promise<any> {
    return this.#t.request("GET", `${DS}/${quote(rid)}`);
  }

  /** Every dataset the caller can read, page by page. */
  iterate(pageSize = 100): AsyncGenerator<any> {
    return pages((token) => this.#t.request("GET", DS + qs({ pageSize, pageToken: token })));
  }

  delete(rid: string): Promise<any> {
    return this.#t.request("DELETE", `${DS}/${quote(rid)}`);
  }

  // ---- branches
  createBranch(rid: string, name: string, options: { parentBranch?: string; fromTransaction?: string } = {}): Promise<any> {
    return this.#t.request("POST", `${DS}/${quote(rid)}/branches`, { name, ...options });
  }

  async listBranches(rid: string): Promise<any[]> {
    return ((await this.#t.request("GET", `${DS}/${quote(rid)}/branches`)) ?? {}).data ?? [];
  }

  deleteBranch(rid: string, branch: string): Promise<any> {
    return this.#t.request("DELETE", `${DS}/${quote(rid)}/branches/${quote(branch)}`);
  }

  // ---- schema
  getSchema(rid: string, branch = "master"): Promise<any> {
    return this.#t.request("GET", `${DS}/${quote(rid)}/branches/${quote(branch)}/schema`);
  }

  /** `columns`: [{ name, type }, ...]. */
  putSchema(rid: string, columns: { name: string; type: string }[], options: { branch?: string; primaryKey?: string[] } = {}): Promise<any> {
    const body: Record<string, unknown> = { columns: [...columns] };
    if (options.primaryKey) body.primaryKey = [...options.primaryKey];
    return this.#t.request("PUT", `${DS}/${quote(rid)}/branches/${quote(options.branch ?? "master")}/schema`, body);
  }

  // ---- transactions
  /** Open a transaction; commit or abort it yourself, or use withTransaction. */
  async transaction(rid: string, branch = "master", type: TransactionType = "APPEND"): Promise<Transaction> {
    const info = await this.#t.request("POST", `${DS}/${quote(rid)}/branches/${quote(branch)}/transactions`,
      { transactionType: type });
    return new Transaction(this.#t, rid, info);
  }

  /** Run `fn` in a transaction: commit when it resolves, abort when it throws (and rethrow). */
  async withTransaction<R>(rid: string, branch: string, type: TransactionType, fn: (tx: Transaction) => Promise<R>): Promise<R> {
    const tx = await this.transaction(rid, branch, type);
    let out: R;
    try {
      out = await fn(tx);
    } catch (e) {
      await tx.abort();
      throw e;
    }
    await tx.commit();
    return out;
  }

  // ---- files and rows
  async listFiles(rid: string, branch = "master"): Promise<any[]> {
    return ((await this.#t.request("GET", `${DS}/${quote(rid)}/branches/${quote(branch)}/files`)) ?? {}).data ?? [];
  }

  /** The bytes of one file. */
  readFile(rid: string, fileRid: string): Promise<Uint8Array> {
    return this.#t.send("GET", `${this.#t.base}${DS}/${quote(rid)}/files/${quote(fileRid)}/content`);
  }

  /** One page of committed rows: { schema, rows, nextPageToken }. */
  readTable(rid: string, options: ReadTableOptions = {}): Promise<any> {
    return this.#t.request("GET", `${DS}/${quote(rid)}/branches/${quote(options.branch ?? "master")}/readTable` + qs({
      format: "json", limit: options.limit ?? 1000, pageToken: options.pageToken,
      filterColumn: options.filterColumn, filterOp: options.filterOp, filterValue: options.filterValue,
    }));
  }

  /** Every committed row, page by page. */
  async *iterateRows(rid: string, options: Omit<ReadTableOptions, "pageToken"> = {}): AsyncGenerator<any> {
    let token: string | undefined;
    do {
      const r = (await this.readTable(rid, { ...options, pageToken: token })) ?? {};
      yield* r.rows ?? [];
      token = r.nextPageToken || undefined;
    } while (token);
  }
}

export interface ReadTableOptions {
  branch?: string;
  limit?: number;
  pageToken?: string;
  /** One single-column filter. */
  filterColumn?: string;
  filterOp?: string;
  filterValue?: string;
}

/** The SQL query failed or was canceled on the server, or did not finish in time. */
export class SqlError extends ConvergeError {}

/** SQL over datasets (backtick their paths or rids) or the platform tables. */
export class SqlClient {
  readonly #t: Transport;

  constructor(transport: Transport) {
    this.#t = transport;
  }

  /** Run a query -> its rows as objects (values as text, from CSV). */
  async execute(query: string, options: { fallbackBranchIds?: string[]; timeoutMs?: number; pollMs?: number } = {}): Promise<Record<string, string | null>[]> {
    let r = (await this.#t.request("POST", "/v2/sqlQueries/execute", {
      query, fallbackBranchIds: [...(options.fallbackBranchIds ?? [])], serializationFormat: "CSV",
    })) ?? {};
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (r.type === "running") {
      if (Date.now() > deadline) throw new SqlError(`query ${r.queryId} still running after ${options.timeoutMs ?? 60_000} ms`);
      await new Promise((ok) => setTimeout(ok, options.pollMs ?? 250));
      r = (await this.#t.request("GET", `/v2/sqlQueries/${quote(r.queryId)}/getStatus`)) ?? {};
    }
    if (r.type !== "succeeded") throw new SqlError(r.errorMessage || `query ${r.type}`);
    const raw = await this.#t.send("GET", `${this.#t.base}/v2/sqlQueries/${quote(r.queryId)}/getResults`);
    return csvRecords(new TextDecoder().decode(raw));
  }
}
