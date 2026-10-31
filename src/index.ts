/**
 * Converge SDK: the Converge platform's REST API from TypeScript and JavaScript, with no
 * dependencies.
 *
 *     import { ConvergeClient } from "@convergehq/sdk";
 *
 *     const client = new ConvergeClient();   // CONVERGE_HOSTNAME / CONVERGE_TOKEN, or ~/.converge/config
 *     await client.datasets.get("ri.example.dataset.1");
 *     await client.sql.execute("SELECT count(*) AS n FROM `/Project/orders`");
 *     const o = client.ontology("my-ontology");
 *     await o.objects("Order").where({ total: { $gt: 100 } }).take(10);
 */
import { UserTokenAuth, type TokenProvider } from "./core/auth.js";
import { resolve } from "./core/config.js";
import { Transport, type FetchLike } from "./core/transport.js";
import { DatasetsClient, SqlClient } from "./datasets/client.js";
import { action, batchAction, query } from "./ontologies/actions.js";
import { Attachments } from "./ontologies/attachments.js";
import { MediaClient } from "./ontologies/media.js";
import { ObjectSet, Ontology, type OntologyObject } from "./ontologies/objects.js";

export const VERSION = "0.1.0";

export interface ConvergeClientOptions {
  /** The API base, for example `https://converge.example.com/api`. */
  hostname?: string;
  token?: string;
  /** Instead of `token`: a UserTokenAuth (for example one that returns a fresh token per request). */
  auth?: UserTokenAuth | TokenProvider;
  /** Per request; default 60 000. */
  timeoutMs?: number;
  /** Default `~/.converge/config` (Node.js only). */
  configFile?: string;
  /** A fetch implementation; default the global one. */
  fetch?: FetchLike;
}

/** Any ontology the caller can see, by api names. */
export class OntologyClient {
  readonly #o: Ontology;
  readonly attachments: Attachments;
  readonly media: MediaClient;

  constructor(transport: Transport, ontologyRid: string) {
    this.#o = new Ontology(transport, ontologyRid);
    this.attachments = new Attachments(transport);
    this.media = new MediaClient(this.#o);
  }

  objects<T extends OntologyObject = OntologyObject>(apiName: string): ObjectSet<T> {
    return new ObjectSet<T>(this.#o, apiName);
  }

  action(apiName: string) {
    return action(this.#o, apiName);
  }

  batchAction(apiName: string) {
    return batchAction(this.#o, apiName);
  }

  query(apiName: string) {
    return query(this.#o, apiName);
  }
}

export class ConvergeClient {
  readonly #transport: Transport;
  readonly datasets: DatasetsClient;
  readonly sql: SqlClient;

  constructor(options: ConvergeClientOptions = {}) {
    let auth: UserTokenAuth;
    let base: string;
    if (options.auth !== undefined) {
      auth = options.auth instanceof UserTokenAuth ? options.auth : new UserTokenAuth(options.auth);
      base = resolve(options.hostname, "unused", options.configFile).base;
    } else {
      const r = resolve(options.hostname, options.token, options.configFile);
      auth = new UserTokenAuth(r.token);
      base = r.base;
    }
    this.#transport = new Transport(base, auth, { timeoutMs: options.timeoutMs, fetch: options.fetch });
    this.datasets = new DatasetsClient(this.#transport);
    this.sql = new SqlClient(this.#transport);
  }

  /** The transport, for routes the SDK does not wrap (`request(method, path, body)`). */
  get transport(): Transport {
    return this.#transport;
  }

  ontology(ontologyRid: string): OntologyClient {
    return new OntologyClient(this.#transport, ontologyRid);
  }

  toString(): string {
    return `ConvergeClient(${this.#transport.base})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export { UserTokenAuth, type TokenProvider } from "./core/auth.js";
export { resolve, parseConfig } from "./core/config.js";
export { ConfigError, ConvergeError, ConvergeRPCError } from "./core/errors.js";
export { Transport, checkBase, type FetchLike, type TransportOptions } from "./core/transport.js";
export { DatasetsClient, SqlClient, SqlError, Transaction, type ReadTableOptions, type TransactionType } from "./datasets/client.js";
export { parseCsv, csvRecords } from "./datasets/csv.js";
export { ActionMode, ReturnEditsMode, type ActionOptions, type ActionResult, type Parameters } from "./ontologies/actions.js";
export { Attachments } from "./ontologies/attachments.js";
export { Media, MediaClient, mediaReference, type MediaMetadata, type MediaReference } from "./ontologies/media.js";
export {
  LinkedObjects, ObjectSet, Ontology, type AggregationType, type FetchPageOptions, type GroupBy,
  type OntologyObject, type OrderBy, type Page,
} from "./ontologies/objects.js";
export { andAll, not, orAll, toClause, type PropertyFilter, type Where, type WhereClause } from "./ontologies/where.js";
