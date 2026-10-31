/** Actions (single and batch) and queries, by api name. */
import { quote } from "../core/transport.js";
import type { Ontology } from "./objects.js";

export const ActionMode = { VALIDATE_ONLY: "VALIDATE_ONLY", VALIDATE_AND_EXECUTE: "VALIDATE_AND_EXECUTE" } as const;
export const ReturnEditsMode = { ALL: "ALL", NONE: "NONE" } as const;

export interface ActionOptions {
  mode?: (typeof ActionMode)[keyof typeof ActionMode];
  returnEdits?: (typeof ReturnEditsMode)[keyof typeof ReturnEditsMode];
}

export type Parameters = Record<string, unknown>;

export interface ActionResult {
  validation: unknown;
  edits: unknown;
}

/** Apply an action: `await action({ order_id: "o1" }, { mode: "VALIDATE_ONLY" })`. */
export function action(o: Ontology, apiName: string) {
  return async (parameters: Parameters, options: ActionOptions = {}): Promise<ActionResult> => {
    const body: Record<string, unknown> = { parameters: { ...parameters } };
    const opts: Record<string, string> = {};
    if (options.mode) opts.mode = options.mode;
    if (options.returnEdits) opts.returnEdits = options.returnEdits;
    if (Object.keys(opts).length) body.options = opts;
    const r = (await o.request("POST", "/actions/" + quote(apiName) + "/apply", body)) ?? {};
    return { validation: r.validation, edits: r.edits };
  };
}

/** Apply 1 to 100 requests. Atomic for plain actions; authored or approval actions run one at
 * a time and stop at the first failure. */
export function batchAction(o: Ontology, apiName: string) {
  return async (requests: Parameters[], options: Pick<ActionOptions, "returnEdits"> = {}): Promise<{ results: unknown; edits: unknown }> => {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100) {
      throw new RangeError(`${apiName}: a batch takes 1 to 100 requests`);
    }
    const body: Record<string, unknown> = { requests: requests.map((p) => ({ parameters: { ...p } })) };
    if (options.returnEdits) body.options = { returnEdits: options.returnEdits };
    const r = (await o.request("POST", "/actions/" + quote(apiName) + "/applyBatch", body)) ?? {};
    return { results: r.results, edits: r.edits };
  };
}

/** Run a query (function): it runs as the caller, read-only, and returns its value. */
export function query(o: Ontology, apiName: string) {
  return async (parameters: Parameters = {}): Promise<unknown> => {
    const r = (await o.request("POST", "/queries/" + quote(apiName) + "/execute", { parameters: { ...parameters } })) ?? {};
    return r.value;
  };
}
