import { buildArgs } from "../cli.js";
import { SynsError, fail } from "../errors.js";
import { K64, M1, base, message, object, path, provenance, version, type Context, type ProcedureMethod } from "../method.js";

interface Params {
  path: string;
  text: string;
  base: string;
  message?: string;
  create?: boolean;
}

export const write: ProcedureMethod = {
  name: "syns.write",
  description: "One file's whole text as a new version, made against base. create: true refuses with exists when the path is already there at base. Published at once, with no confirmation.",
  effect: "contributed-write",
  params: object({ path, text: { type: "string", maxLength: M1 }, base, message, create: { type: "boolean" } }, ["path", "text", "base"]),
  result: { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] },
  maxRequestBytes: M1,
  maxResponseBytes: K64,
  reasons: ["exists"],

  async procedure(params: Params, context: Context) {
    if (params.create === true) {
      // The path is read at base, and the write is then made against the same base, so nothing can slip
      // between the check and the write: a moved head refuses it as stale_head. S1.19
      let there = true;
      try {
        await context.syns(buildArgs("cat", { version: params.base }, [params.path]));
      } catch (error) {
        if (!(error instanceof SynsError && error.code === "not_found" && error.subject !== "version")) throw error;
        there = false;
      }
      if (there) throw fail("exists");
    }
    const fallback = `${params.create === true ? "Create" : "Write"} ${params.path} from a page`.slice(0, 500);
    const args = buildArgs("write", { parent: params.base, message: params.message || fallback, ...provenance(context.sessionId) }, [params.path]);
    // The text travels on standard input, whatever its size. S2.12
    const out = (await context.syns(args, params.text)) as Record<string, unknown> | null;
    return { version: out?.commitSha, number: out?.version };
  },
};
