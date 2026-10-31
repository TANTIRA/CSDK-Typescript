/**
 * OAuth sign-in against Converge's Keycloak (realm `converge`), like `@osdk/oauth`. Both helpers
 * return a token function that `new ConvergeClient({ auth })` and `UserTokenAuth` take.
 *
 *     const auth = createConfidentialOauthClient("svc", process.env.CLIENT_SECRET!, "https://host/api");
 *     const client = new ConvergeClient({ hostname: "https://host/api", auth });
 */
import { ConfigError, ConvergeRPCError } from "./errors.js";
import { checkBase, type FetchLike } from "./transport.js";

/** A token function, with the sign-in controls. */
export type OauthTokenProvider = (() => Promise<string>) & {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** A fresh access token, or undefined when there is nothing to refresh with. */
  refresh(): Promise<string | undefined>;
};

export interface OauthOptions {
  /** Default: the realm "converge" behind the Converge origin, `<origin>/kc/realms/converge`. */
  issuer?: string;
  realm?: string;
  fetch?: FetchLike;
}

interface OidcEndpoints { authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string }

/** The issuer's OpenID configuration. It must name that issuer, and every endpoint must be on the
 * issuer's origin: a configuration cannot send the code or the secret to another host. */
async function discover(baseUrl: string, o: OauthOptions): Promise<OidcEndpoints> {
  // an absolute path resolves against the origin: "https://h" and "https://h/api" both mean https://h/kc
  const issuer = checkBase(o.issuer ?? new URL(`/kc/realms/${encodeURIComponent(o.realm ?? "converge")}`,
    new URL(baseUrl, globalThis.location?.href)).href);
  const res = await (o.fetch ?? globalThis.fetch)(`${issuer}/.well-known/openid-configuration`, { redirect: "error" });
  if (!res.ok) throw new ConvergeRPCError(res.status, "OpenID configuration not found");
  const d = await res.json() as Record<string, unknown>;
  if (typeof d.issuer !== "string" || d.issuer.replace(/\/+$/, "") !== issuer) {
    throw new ConvergeRPCError(res.status, "OpenID configuration is for another issuer; pass opts.issuer");
  }
  const origin = new URL(issuer).origin;
  for (const k of ["authorization_endpoint", "token_endpoint", "end_session_endpoint"]) {
    if (d[k] === undefined && k === "end_session_endpoint") continue;
    if (typeof d[k] !== "string") throw new ConvergeRPCError(res.status, `OpenID configuration has no ${k}`);
    checkBase(d[k] as string);
    if (new URL(d[k] as string).origin !== origin) {
      throw new ConvergeRPCError(res.status, `OpenID ${k} is not on the issuer's origin`);
    }
  }
  return d as unknown as OidcEndpoints;
}

/** POST a grant to the token endpoint. An error carries only the server's error code and text,
 * never a token. */
async function grant(f: FetchLike, url: string, body: Record<string, string>, basic?: string) {
  const res = await f(url, {
    method: "POST", redirect: "error", body: new URLSearchParams(body),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(basic ? { Authorization: `Basic ${basic}` } : {}) },
  });
  const d = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || typeof d.access_token !== "string") {
    throw new ConvergeRPCError(res.status, { error: d.error, error_description: d.error_description });
  }
  const life = Number.isFinite(Number(d.expires_in)) && Number(d.expires_in) > 0 ? Number(d.expires_in) : 0;
  return { access: d.access_token, refresh: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
           // renewed 30 s early (a short-lived token at half its life), so it never expires in flight
           until: Date.now() + (life > 60 ? life - 30 : life / 2) * 1000 };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** One token request at a time. */
function provider(get: () => Promise<string>,
                  controls: Pick<OauthTokenProvider, "signIn" | "signOut" | "refresh">): OauthTokenProvider {
  let inflight: Promise<string> | undefined;
  const fn = () => (inflight ??= get().finally(() => { inflight = undefined; }));
  return Object.assign(fn, controls);
}

/**
 * Browser sign-in: authorization code with PKCE (S256). The first call with no token sends the page
 * to the sign-in page; back on redirectUrl, the next call exchanges the code. Tokens live in memory;
 * with storage: "sessionStorage" the refresh token survives a reload of the tab. The client id must
 * be a public client of the realm that the API accepts (OIDC_ALLOWED_CLIENTS).
 */
export function createPublicOauthClient(clientId: string, baseUrl: string, redirectUrl: string,
    opts: OauthOptions & { scopes?: string[]; storage?: "memory" | "sessionStorage" } = {}): OauthTokenProvider {
  const f = opts.fetch ?? globalThis.fetch;
  let ends: Promise<OidcEndpoints> | undefined;
  const endpoints = () => (ends ??= discover(baseUrl, opts).catch((e) => { ends = undefined; throw e; }));
  const key = `osdk-oauth:${clientId}`;
  const keep = opts.storage === "sessionStorage" ? sessionStorage : undefined;
  let token: { access: string; until: number } | undefined;
  let refreshToken = keep?.getItem(`${key}:refresh`) ?? undefined;
  // back from the sign-in page: take the single-use code out of the address bar and history at once
  let landing: { code: string | null; state: string | null; error: string | null; pkce: string } | undefined;
  {
    const here = new URL(location.href), back = new URL(redirectUrl, location.href);
    const pkce = sessionStorage.getItem(`${key}:pkce`);
    if (pkce && here.origin + here.pathname === back.origin + back.pathname
        && (here.searchParams.has("code") || here.searchParams.has("error"))) {
      sessionStorage.removeItem(`${key}:pkce`);
      landing = { code: here.searchParams.get("code"), state: here.searchParams.get("state"),
                  error: here.searchParams.get("error"), pkce };
      for (const p of ["code", "state", "session_state", "iss", "error", "error_description"]) here.searchParams.delete(p);
      history.replaceState(history.state, "", here.href);
    }
  }
  const take = (g: Awaited<ReturnType<typeof grant>>) => {
    token = g;
    if (g.refresh) {
      refreshToken = g.refresh;
      keep?.setItem(`${key}:refresh`, g.refresh);
    }
    return g.access;
  };
  const signIn = async () => {
    const verifier = random(), state = random();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    // the verifier must outlive the redirect, so it always goes to sessionStorage
    sessionStorage.setItem(`${key}:pkce`, JSON.stringify({ verifier, state }));
    const u = new URL((await endpoints()).authorization_endpoint);
    for (const [k, v] of Object.entries({ client_id: clientId, response_type: "code", redirect_uri: redirectUrl,
        scope: (opts.scopes ?? ["openid"]).join(" "), code_challenge: challenge, code_challenge_method: "S256", state })) {
      u.searchParams.set(k, v);
    }
    location.assign(u.href);
  };
  let refreshing: Promise<string | undefined> | undefined;
  // one refresh at a time: Keycloak rotates refresh tokens, so a second use of the same one fails
  const refresh = () => (refreshing ??= (async () => {
    const sent = refreshToken;
    if (!sent) return undefined;
    try {
      return take(await grant(f, (await endpoints()).token_endpoint,
                              { grant_type: "refresh_token", client_id: clientId, refresh_token: sent }));
    } catch (e) {
      // expired or revoked; a 5xx or a network error keeps the session for the next try
      if (!(e instanceof ConvergeRPCError && e.status >= 400 && e.status < 500)) throw e;
      if (refreshToken === sent) {
        refreshToken = undefined;
        keep?.removeItem(`${key}:refresh`);
      }
      return undefined;
    }
  })().finally(() => { refreshing = undefined; }));
  const get = async (): Promise<string> => {
    if (token && token.until > Date.now()) return token.access;
    if (landing) {
      const { code, state: got, error, pkce } = landing;
      landing = undefined;
      const { verifier, state } = JSON.parse(pkce) as { verifier: string; state: string };
      if (got !== state) throw new ConfigError("OAuth state does not match this sign-in");
      if (error || !code) throw new ConvergeRPCError(400, { error });
      return take(await grant(f, (await endpoints()).token_endpoint, {
        grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUrl, code_verifier: verifier }));
    }
    const fresh = await refresh();
    if (fresh) return fresh;
    await signIn();
    return new Promise<string>(() => {});  // the page is leaving for the sign-in page
  };
  return provider(get, {
    signIn, refresh,
    async signOut() {
      token = refreshToken = undefined;
      keep?.removeItem(`${key}:refresh`);
      const end = (await endpoints()).end_session_endpoint;
      if (end) {
        const u = new URL(end);
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("post_logout_redirect_uri", redirectUrl);
        location.assign(u.href);
      }
    },
  });
}

/**
 * Server-side only: the client-credentials grant of a confidential client of the realm. Throws in a
 * browser (where `document` exists), because the secret would ship to everyone who loads the page.
 */
export function createConfidentialOauthClient(clientId: string, clientSecret: string, baseUrl: string,
    scopes?: string[], fetchFn?: FetchLike, opts: OauthOptions = {}): OauthTokenProvider {
  const g = globalThis as { document?: unknown; importScripts?: unknown; navigator?: { userAgent?: string } };
  // a page or a web worker; jsdom (a Node test environment) defines document too
  if (("document" in g || typeof g.importScripts === "function") && !g.navigator?.userAgent?.includes("jsdom")) {
    throw new ConfigError("createConfidentialOauthClient is server-side only: never put a client secret in a browser bundle");
  }
  const o = { ...opts, fetch: fetchFn ?? opts.fetch };
  let ends: Promise<OidcEndpoints> | undefined;
  let token: { access: string; until: number } | undefined;
  // RFC 6749 2.3.1: id and secret form-encoded, then HTTP Basic
  const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
  const refresh = async () => {
    const url = (await (ends ??= discover(baseUrl, o).catch((e) => { ends = undefined; throw e; }))).token_endpoint;
    token = await grant(o.fetch ?? globalThis.fetch, url, { grant_type: "client_credentials",
                                                            ...(scopes?.length ? { scope: scopes.join(" ") } : {}) }, basic);
    return token.access;
  };
  return provider(async () => (token && token.until > Date.now() ? token.access : await refresh()), {
    refresh,
    async signIn() { await refresh(); },
    async signOut() { token = undefined; },
  });
}
