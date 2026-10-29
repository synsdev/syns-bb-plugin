import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { K64, M1, object, repoPath, version, type Context, type ProcedureMethod } from "../method.js";
import { scopePatch } from "../scoped.js";

interface Params {
  from: string;
  to?: string;
  patch?: boolean;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const end = { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] };

export const diff: ProcedureMethod = {
  name: "syns.diff",
  description: "The net change between two versions: each changed path with its status (added, modified, deleted, renamed with oldPath). to defaults to the head. patch: true adds each file's patch. After the head moves, diff { from } says what to re-read.",
  effect: "read",
  params: object({ from: version, to: version, patch: { type: "boolean" } }, ["from"]),
  result: {
    type: "object",
    properties: {
      from: end,
      to: end,
      files: { type: "array", items: { type: "object", properties: { path: repoPath, status: { type: "string" }, oldPath: repoPath, patch: { type: "string" } }, required: ["path", "status"] } },
    },
    required: ["from", "to", "files"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,

  async procedure(params: Params, context: Context) {
    // The CLI wants both versions or neither, and the result must state what it compared against. S1.18
    let to = params.to;
    if (to === undefined) {
      const head = (await context.syns(buildArgs("repo")) as Record<string, unknown> | null)?.commitSha;
      if (typeof head !== "string") throw new SynsError("not_found");
      to = head;
    }
    const out = record(await context.syns(buildArgs("diff", { from: params.from, to })));
    const ends = [record(out.from), record(out.to)].map((one) => ({ version: one.sha, number: one.version }));
    return {
      from: ends[0],
      to: ends[1],
      files: Array.isArray(out.files)
        ? out.files.map(record).map((file) => ({
            path: file.path,
            status: file.status,
            ...(file.status === "renamed" && typeof file.oldPath === "string" ? { oldPath: file.oldPath } : {}),
            ...(params.patch === true && typeof file.diff === "string" ? { patch: file.diff } : {}),
          }))
        : undefined,
    };
  },

  // A move across the scope's edge reads as the CLI's mask reads it (roadmap/228): the old side outside, an addition;
  // the new side outside, a deletion at the old path. Its patch names the outside path, so it goes. S1.26, D87
  // A patch kept names its paths as its entry does, counted from the folder (S1.25, B-0080).
  scoped(result: { files?: Record<string, unknown>[] }, inside: (path: unknown) => boolean, scope: string) {
    if (!Array.isArray(result.files)) return result;
    const files = result.files.map((file) => {
      if (typeof file.oldPath !== "string" || inside(file.path) === inside(file.oldPath)) return typeof file.patch === "string" ? { ...file, patch: scopePatch(file.patch, scope) } : file;
      return inside(file.path) ? { path: file.path, status: "added" } : { path: file.oldPath, status: "deleted" };
    });
    return { ...result, files };
  },
};
