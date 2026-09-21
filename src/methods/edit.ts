import { buildArgs } from "../cli.js";
import { K64, base, message, object, path, provenance, version, type SimpleMethod } from "../method.js";

// old and new travel as process arguments, so they are bounded well under the system's argument limit,
// and hold no NUL, which no argument can carry. S2.12
const MAX_TEXT = 32_768;
const NO_NUL = "^[^\\u0000]*$";

export const edit: SimpleMethod = {
  name: "syns.edit",
  description: "Replace old with new in one file, as a new version made against base. old must occur exactly once unless replaceAll is true. Both at most 32,768 characters; a larger change is a syns.write. Published at once.",
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
  result: { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] },
  maxRequestBytes: 2 * K64,
  maxResponseBytes: K64,
  reasons: ["no_match", "many_matches"],
  command: (params, sessionId) => ({
    args: buildArgs(
      "edit",
      { old: params.old, new: params.new, "replace-all": params.replaceAll === true, parent: params.base, message: params.message || `Edit ${params.path} from a page`.slice(0, 500), ...provenance(sessionId) },
      [params.path],
    ),
  }),
  shape: (out) => ({ version: out.commitSha, number: out.version }),
};
