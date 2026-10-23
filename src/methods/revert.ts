import { buildArgs } from "../cli.js";
import { K64, base, message, object, path, provenance, version, type SimpleMethod } from "../method.js";

export const revert: SimpleMethod = {
  name: "syns.revert",
  description: "Put one file, text or picture, back to what it held at the earlier version to, as a new version made against base. No content is sent. Published at once, with no confirmation.",
  effect: "contributed-write",
  params: object({ path, to: version, base, message }, ["path", "to", "base"]),
  result: { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  // CLI 0.3.25's revert takes a parent and provenance like every write (D89). Its own default message names the
  // operation and the path (`Revert PATH to SHORT`), so it stands when the page gives none.
  command: (params, sessionId) => ({ args: buildArgs("revert", { to: params.to, parent: params.base, message: params.message || undefined, ...provenance(sessionId) }, [params.path]) }),
  shape: (out) => ({ version: out.commitSha, number: out.version }),
};
