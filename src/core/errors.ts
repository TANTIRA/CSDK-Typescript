/** Errors raised by the SDK. A message never contains a token. */

/** Base class of every SDK error. */
export class ConvergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A non-2xx answer from the API (a refused redirect included): `status` and the parsed `body`. */
export class ConvergeRPCError extends ConvergeError {
  readonly status: number;
  readonly body: unknown;
  /** The API's `errorName`, when the body has one. */
  readonly errorName: string | undefined;
  readonly parameters: unknown;

  constructor(status: number, body: unknown) {
    super(`request failed with HTTP ${status}`);
    this.status = status;
    this.body = body;
    const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    this.errorName = typeof b.errorName === "string" ? b.errorName : undefined;
    this.parameters = b.parameters;
  }
}

/** No hostname or token could be found, or one of them is not usable. */
export class ConfigError extends ConvergeError {}
