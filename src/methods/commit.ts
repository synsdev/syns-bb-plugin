import { buildArgs } from "../cli.js";
import { fail } from "../errors.js";
import { K64, M1, base, message, object, path, provenance, version, type SimpleMethod } from "../method.js";

interface Params {
  base: string;
  message?: string;
  files?: { path: string; text: string }[];
  deletions?: string[];
}

const pathsOf = (params: Params): string[] => [...(params.files ?? []).map((file) => file.path), ...(params.deletions ?? [])];

export const commit: SimpleMethod = {
  name: "syns.commit",
  description: "Several changes as one new version, all or nothing: whole-file texts and deletions, made against base. At least one change; no path twice. Published at once, with no confirmation.",
  effect: "contributed-write",
  params: object(
    {
      base,
      message,
      files: { type: "array", maxItems: 64, items: object({ path, text: { type: "string", maxLength: M1 } }, ["path", "text"]) },
      deletions: { type: "array", maxItems: 64, items: path },
    },
    ["base"],
  ),
  result: {
    type: "object",
    properties: { version, number: { type: "integer" }, changed: { type: "integer", description: "How many paths the new version changed. 0: nothing differed, and version is the unchanged head." } },
    required: ["version", "number", "changed"],
  },
  maxRequestBytes: M1,
  maxResponseBytes: K64,
  reasons: ["invalid_change"],
  check(params: Params) {
    const paths = pathsOf(params);
    if (paths.length === 0 || new Set(paths).size !== paths.length) throw fail("invalid_change");
  },
  pathCount: (params: Params) => pathsOf(params).length,
  command(params: Params, sessionId) {
    const paths = pathsOf(params);
    const fallback = `Commit ${paths.length === 1 ? paths[0] : `${paths.length} paths`} from a page`.slice(0, 500);
    return {
      args: buildArgs("commit", { parent: params.base, message: params.message || fallback, ...provenance(sessionId) }),
      // The changeset travels on standard input, whatever its size. A deletion is an object. S2.12
      stdin: JSON.stringify({
        files: (params.files ?? []).map((file) => ({ path: file.path, content: file.text })),
        deletions: (params.deletions ?? []).map((deleted) => ({ path: deleted })),
      }),
    };
  },
  shape: (out) => ({ version: out.commitSha, number: out.version, changed: out.filesChanged }),
};
