// Compiled by `npm test` (tsc --strict, no emit): code written before the pending-approval branch
// existed still type-checks, and the branch narrows on status.
import { ConvergeClient, type ActionResult } from "../../dist/index.js";

declare const c: ConvergeClient;

export async function before(): Promise<unknown> {
  const r = await c.ontology("o").action("x")({});
  return [r.validation, r.edits];
}

export function narrowed(r: ActionResult): string | unknown {
  return r.status === "pending_approval" ? r.approval_id : r.edits;
}
