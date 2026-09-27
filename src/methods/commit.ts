import { buildArgs } from "../cli.js";
import { SynsError, fail } from "../errors.js";
import type { Upload } from "../held.js";
import { K64, M1, base, message, object, path, provenance, version, type Context, type ProcedureMethod } from "../method.js";
import { base64, keptKey, sha256 } from "./binary.js";

/** A file entry carries exactly one of a text, bytes, or a picture gathered by syns.writeBinary with hold (D26). */
interface FileEntry {
  path: string;
  text?: string;
  base64?: string;
  upload?: string;
}

interface Params {
  base: string;
  message?: string;
  files?: FileEntry[];
  deletions?: string[];
}

const pathsOf = (params: Params): string[] => [...(params.files ?? []).map((file) => file.path), ...(params.deletions ?? [])];
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const commit: ProcedureMethod = {
  name: "syns.commit",
  description: "Several changes as one new version against base, all or nothing: files, each with text, base64 bytes, or an upload held by syns.writeBinary, and deletions. No path twice. Published at once.",
  effect: "contributed-write",
  params: object(
    {
      base,
      message,
      files: { type: "array", maxItems: 64, items: object({ path, text: { type: "string", maxLength: M1 }, base64, upload: sha256 }, ["path"]) },
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
  reasons: ["invalid_change", "bad_offset"],
  check(params: Params) {
    for (const file of params.files ?? []) {
      const carried = [file.text, file.base64, file.upload].filter((value) => value !== undefined).length;
      if (carried !== 1) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.commit: each file carries exactly one of text, base64 and upload" });
    }
    const paths = pathsOf(params);
    if (paths.length === 0 || new Set(paths).size !== paths.length) throw fail("invalid_change");
  },
  pathCount: (params: Params) => pathsOf(params).length,

  async procedure(params: Params, context: Context) {
    const used: string[] = [];
    const files = (params.files ?? []).map((file) => {
      if (file.text !== undefined) return { path: file.path, content: file.text };
      if (file.base64 !== undefined) return { path: file.path, contentBase64: file.base64 };
      // A named upload must still be held; otherwise the page sends it again (D26).
      const key = keptKey(context.sessionId, file.upload as string);
      const kept = context.held.get<Upload>(key);
      if (!kept) throw fail("bad_offset", { expected: 0 });
      used.push(key);
      return { path: file.path, contentBase64: Buffer.concat(kept.chunks).toString("base64") };
    });
    const paths = pathsOf(params);
    const fallback = `Commit ${paths.length === 1 ? paths[0] : `${paths.length} paths`} from a page`.slice(0, 500);
    // The changeset travels on standard input, whatever its size. A deletion is an object. S2.12
    const stdin = JSON.stringify({ files, deletions: (params.deletions ?? []).map((deleted) => ({ path: deleted })) });
    const out = record(await context.syns(buildArgs("commit", { parent: params.base, message: params.message || fallback, ...provenance(context.sessionId) }), stdin));
    // Published: a held picture is let go. A refused commit keeps it, so the page can re-read and commit again.
    for (const key of used) context.held.drop(key);
    return { version: out.commitSha, number: out.version, changed: out.filesChanged };
  },
};
