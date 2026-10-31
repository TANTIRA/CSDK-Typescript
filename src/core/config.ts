/**
 * Where the hostname and token come from. In order: the arguments, then the environment
 * (`CONVERGE_HOSTNAME`, `CONVERGE_TOKEN`, with `FOUNDRY_TOKEN` accepted as a fallback for the
 * token), then the `[default]` section of `~/.converge/config` (Node.js only):
 *
 *     [default]
 *     hostname = https://converge.example.com/api
 *     token = <your token>
 *
 * Keep that file readable by you only (`chmod 600`).
 */
import { ConfigError } from "./errors.js";

export const CONFIG_FILE = "~/.converge/config";

interface NodeLike {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => any;
}

function node(): NodeLike | undefined {
  return (globalThis as { process?: NodeLike }).process;
}

/** The `[default]` section of an INI file (`key = value` or `key: value`), or {} without one. */
export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    const kv = /^([^=:]+)[=:](.*)$/.exec(line);
    if (section === "default" && kv) out[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return out;
}

function fileValues(path: string): Record<string, string> {
  const p = node();
  const fs = p?.getBuiltinModule?.("node:fs");
  const os = p?.getBuiltinModule?.("node:os");
  if (!fs || !os) return {};  // a browser, or a runtime without node:fs
  const full = path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
  try {
    return parseConfig(fs.readFileSync(full, "utf8"));
  } catch {
    return {};
  }
}

/** -> { base, token }. Throws ConfigError naming what is missing, never a value. */
export function resolve(hostname?: string, token?: string, configFile?: string): { base: string; token: string } {
  const env = node()?.env ?? {};
  let h = hostname || env.CONVERGE_HOSTNAME;
  let t = token || env.CONVERGE_TOKEN || env.FOUNDRY_TOKEN;
  if (!h || !t) {
    const values = fileValues(configFile ?? CONFIG_FILE);
    h = h || values.hostname;
    t = t || values.token;
  }
  const missing = [["hostname", h], ["token", t]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) {
    throw new ConfigError(`no ${missing.join(" or ")}: pass it, set CONVERGE_HOSTNAME / CONVERGE_TOKEN,`
      + " or add it to ~/.converge/config");
  }
  const base = h!.includes("://") ? h! : "https://" + h;
  return { base: base.replace(/\/+$/, ""), token: t! };
}
