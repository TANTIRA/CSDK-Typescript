/**
 * HTTP transport: JSON in and out, bearer auth, and no redirects. A redirect would carry the
 * Authorization header to its target, and the API never redirects, so every redirect is refused.
 */
import type { UserTokenAuth } from "./auth.js";
import { ConfigError, ConvergeRPCError } from "./errors.js";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API base as given, without a trailing slash. Refuses anything but https, except plain
 * http to localhost, and refuses credentials in the URL. */
export function checkBase(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new ConfigError("the API base is not a URL; it looks like https://converge.example.com/api");
  }
  if (u.username || u.password) {
    throw new ConfigError("the API base may not contain a user name or password");
  }
  const local = u.protocol === "http:" && LOCAL.has(u.hostname);
  if (u.protocol !== "https:" && !local) {
    throw new ConfigError(`refusing ${u.protocol}//${u.hostname}: the API base must be https`
      + " (plain http only for localhost)");
  }
  return base.replace(/\/+$/, "");
}

/** JSON, else the text, else null for an empty body. */
export function parse(raw: Uint8Array): unknown {
  const text = new TextDecoder().decode(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One path segment. */
export function quote(s: unknown): string {
  return encodeURIComponent(String(s));
}

export type FetchLike = typeof globalThis.fetch;

export interface TransportOptions {
  /** Per request; default 60 000. */
  timeoutMs?: number;
  /** A fetch implementation; default the global one. */
  fetch?: FetchLike;
}

/** Requests against one API base URL (for example `https://host/api`). */
export class Transport {
  readonly base: string;
  readonly #auth: UserTokenAuth;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(base: string, auth: UserTokenAuth, options: TransportOptions = {}) {
    this.base = checkBase(base);
    this.#auth = auth;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new ConfigError("no fetch: pass options.fetch");
    this.#fetch = f;
  }

  toString(): string {
    return `Transport(${this.base})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /** The raw response bytes of one request to a full URL. */
  async send(method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Uint8Array> {
    const r = await this.#fetch(url, {
      method,
      body,
      headers: { ...headers, Authorization: "Bearer " + (await this.#auth.getToken()) },
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    // Node.js gives the 3xx itself; a browser gives an opaque redirect with status 0
    if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) {
      throw new ConvergeRPCError(r.status, "redirect refused");
    }
    const raw = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw new ConvergeRPCError(r.status, parse(raw));
    return raw;
  }

  /** JSON request to `base + path` -> the parsed answer. */
  async request(method: string, path: string, body?: unknown): Promise<any> {
    if (body === undefined) return parse(await this.send(method, this.base + path));
    return parse(await this.send(method, this.base + path, JSON.stringify(body),
      { "Content-Type": "application/json" }));
  }
}
