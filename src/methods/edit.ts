import { buildArgs } from "../cli.js";
import { SynsError, fail } from "../errors.js";
import { K64, base, message, object, path, provenance, version, type Context, type ProcedureMethod } from "../method.js";

// old and new travel as process arguments, so they are bounded well under the system's argument limit,
// and hold no NUL, which no argument can carry. S2.12
const MAX_TEXT = 32_768;
const NO_NUL = "^[^\\u0000]*$";

interface Params {
  path: string;
  old: string;
  new: string;
  replaceAll?: boolean;
  base: string;
  message?: string;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const edit: ProcedureMethod = {
  name: "syns.edit",
  description: "Replace old with new in one file, as a new version made against base. old must occur exactly once unless replaceAll is true. old equal to new changes nothing: changed 0. Both at most 32,768 characters.",
  effect: "contributed-write",
  params: object(
    {
      path,
      old: { type: "string", minLength: 1, maxLength: MAX_TEXT, pattern: NO_NUL },
      new: { type: "string", maxLength: MAX_TEXT, pattern: NO_NUL },
      replaceAll: { type: "boolean" },
      base,
      message,
    },
    ["path", "old", "new", "base"],
  ),
  result: {
    type: "object",
    properties: { version, number: { type: "integer" }, changed: { type: "integer", description: "How many paths the new version changed. 0: old equals new, and version is the unchanged head." } },
    required: ["version", "number", "changed"],
  },
  maxRequestBytes: 2 * 64 * 1024,
  maxResponseBytes: K64,
  reasons: ["no_match", "many_matches"],

  async procedure(params: Params, context: Context) {
    // A replacement that changes nothing is answered as commit and rm answer one, not run: the CLI refuses it (D21).
    if (params.old === params.new) {
      const newest = record((record(await context.syns(buildArgs("history", { limit: 1 }))).data as unknown[] | undefined)?.[0]);
      if (typeof newest.sha !== "string" || typeof newest.version !== "number") throw new SynsError("handler_error", { log: "exit=0 history names no head" });
      if (newest.sha !== params.base) throw fail("stale_head", { current: newest.sha });
      return { version: newest.sha, number: newest.version, changed: 0 };
    }
    const out = record(
      await context.syns(
        buildArgs(
          "edit",
          { old: params.old, new: params.new, "replace-all": params.replaceAll === true, parent: params.base, message: params.message || `Edit ${params.path} from a page`.slice(0, 500), ...provenance(context.sessionId) },
          [params.path],
        ),
      ),
    );
    return { version: out.commitSha, number: out.version, changed: out.filesChanged };
  },
};
