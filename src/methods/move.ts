import { buildArgs } from "../cli.js";
import { K64, base, message, object, path, provenance, repoPath, version, type SimpleMethod } from "../method.js";

interface Params {
  from: string;
  to: string;
  base: string;
  message?: string;
}

/**
 * `syns mv` and `syns cp` (Syns roadmap/228, CLI 0.3.25), as they are (D-244 §2): one run, paths only on the wire,
 * one version. The answer is the CLI's own member, `from` and `to` as it resolved them.
 */
function pathWrite(verb: "mv" | "cp", name: "syns.move" | "syns.copy", word: "Move" | "Copy", member: "moves" | "copies", description: string): SimpleMethod {
  return {
    name,
    description,
    effect: "contributed-write",
    params: object({ from: path, to: path, base, message }, ["from", "to", "base"]),
    result: {
      type: "object",
      properties: { version, number: { type: "integer" }, from: repoPath, to: repoPath, files: { type: "integer", description: "How many files it moved or copied." } },
      required: ["version", "number", "from", "to", "files"],
    },
    maxRequestBytes: K64,
    maxResponseBytes: K64,
    reasons: ["exists"],
    pathCount: () => 2,
    command: (params: Params, sessionId) => ({ args: buildArgs(verb, { parent: params.base, message: params.message || `${word} ${params.from} to ${params.to} from a page`.slice(0, 500), ...provenance(sessionId) }, [params.from, params.to]) }),
    shape: (out) => {
      const one = Array.isArray(out[member]) ? ((out[member] as unknown[])[0] as Record<string, unknown> | undefined) : undefined;
      return { version: out.commitSha, number: out.version, from: one?.from, to: one?.to, files: one?.files };
    },
  };
}

export const move = pathWrite("mv", "syns.move", "Move", "moves", "Move a file or folder from to to as one new version against base, keeping its history. to must not exist at base (exists). Published at once, with no confirmation.");
export const copy = pathWrite("cp", "syns.copy", "Copy", "copies", "Copy a file or folder from to to as one new version against base; from stays. to must not exist at base (exists). Published at once, with no confirmation.");
