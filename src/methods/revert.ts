import { buildArgs } from "../cli.js";
import { K64, message, object, path, version, type SimpleMethod } from "../method.js";

export const revert: SimpleMethod = {
  name: "syns.revert",
  description: "Put one file back to its text at the earlier version to, as a new version. Today the CLI checks no base, so the head is not checked, and records no provenance: syns.history shows this commit with by all null.",
  effect: "contributed-write",
  params: object({ path, to: version, message }, ["path", "to"]),
  result: { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  // The CLI's revert as it is (D13): it takes no --parent and no provenance flags, so none is passed.
  // Its own default message stands when the page gives none.
  command: (params) => ({ args: buildArgs("revert", { to: params.to, message: params.message || undefined }, [params.path]) }),
  shape: (out) => ({ version: out.commitSha, number: out.version }),
};
