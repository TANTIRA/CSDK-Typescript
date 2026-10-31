import { ConfigError } from "./errors.js";

/** A bearer token, or a function that returns one (or a promise of one) per request. */
export type TokenProvider = string | (() => string | Promise<string>);

// a header value: a token with a space or line break (a trailing newline from a file, say)
// is refused here, without echoing it, instead of failing inside fetch with the value in the message
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** Bearer-token authentication. The token is never part of `toString()`, `JSON.stringify`,
 * `util.inspect` or an error message. */
export class UserTokenAuth {
  readonly #token: TokenProvider;

  constructor(token: TokenProvider) {
    if (typeof token !== "function" && !(typeof token === "string" && token)) {
      throw new ConfigError("UserTokenAuth needs a non-empty token or a function");
    }
    this.#token = token;
  }

  /** The token for one request. */
  async getToken(): Promise<string> {
    const t = typeof this.#token === "function" ? await this.#token() : this.#token;
    if (typeof t !== "string" || !HEADER_SAFE.test(t)) {
      throw new ConfigError("the token must be printable ASCII without spaces or line breaks");
    }
    return t;
  }

  toString(): string {
    return "UserTokenAuth(<redacted>)";
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
