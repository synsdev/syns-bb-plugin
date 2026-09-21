import { buildArgs } from "../cli.js";
import { K64, base, message, object, path, provenance, version, type SimpleMethod } from "../method.js";

export const rm: SimpleMethod = {
  name: "syns.rm",
  description: "Remove one path as a new version, made against base. A path that is not there is success with the unchanged version and changed: 0, as the CLI answers it. Published at once, with no confirmation.",
  effect: "contributed-write",
  params: object({ path, base, message }, ["path", "base"]),
  result: {
    type: "object",
    properties: { version, number: { type: "integer" }, changed: { type: "integer", description: "How many paths the new version changed. 0: the path was not there, and version is the unchanged head." } },
    required: ["version", "number", "changed"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  command: (params, sessionId) => ({ args: buildArgs("rm", { parent: params.base, message: params.message || `Remove ${params.path} from a page`.slice(0, 500), ...provenance(sessionId) }, [params.path]) }),
  // A missing path mirrors the CLI: success, no new version. D15
  shape: (out) => ({ version: out.commitSha, number: out.version, changed: out.filesChanged }),
};
