import { buildArgs, pool } from "../cli.js";
import { SynsError } from "../errors.js";
import { ENVELOPE, K64, M1, bytes, nullable, object, path, version, type Context, type ProcedureMethod } from "../method.js";

interface Params {
  paths: string[];
  version?: string;
}

type Entry = { path: string; text: string; size: unknown; blob: unknown } | { path: string; error: "not_found" } | { path: string; error: "too_large" | "not_text"; size?: unknown; blob?: unknown };


export const readMany: ProcedureMethod = {
  name: "syns.readMany",
  description: "Up to 64 whole files in one call, all at one version (default the head). Each entry is a text or an error: not_found, too_large, not_text. deferred lists paths that did not fit: ask again with them and the returned version.",
  effect: "read",
  params: object({ paths: { type: "array", minItems: 1, maxItems: 64, items: path }, version }, ["paths"]),
  result: {
    type: "object",
    properties: {
      version,
      files: {
        type: "array",
        items: {
          type: "object",
          description: "Either path, text, size and blob, or path and error; too_large and not_text also carry size and blob.",
          properties: { path: { type: "string" }, text: { type: "string" }, size: { type: "integer" }, blob: nullable("string"), error: { type: "string", enum: ["not_found", "too_large", "not_text"] } },
          required: ["path"],
        },
      },
      deferred: { type: "array", items: { type: "string" } },
    },
    required: ["version", "files", "deferred"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  check(params: Params) {
    if (new Set(params.paths).size !== params.paths.length) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readMany: paths must be distinct" });
  },

  async procedure(params: Params, context: Context) {
    // One consistent snapshot: the head is resolved once, first. S1.13
    let at = params.version;
    if (at === undefined) {
      const head = (await context.syns(buildArgs("repo")) as Record<string, unknown> | null)?.commitSha;
      if (typeof head !== "string") throw new SynsError("not_found");
      at = head;
    }

    // One process per path, at most perCall at once. One path failing does not fail the call. S1.14, S1.16
    const entries = await pool(params.paths, context.limits.perCall, async (filePath): Promise<Entry> => {
      try {
        const out = (await context.syns(buildArgs("cat", { version: at }, [filePath]))) as Record<string, unknown> | null;
        // A file that is not text is named with its size and hash, and no bytes: syns.readBinary reads those (D-088, D29).
        if (typeof out?.content !== "string") return { path: filePath, error: "not_text", size: out?.size, blob: out?.sha ?? null };
        return { path: filePath, text: out.content, size: out.size, blob: out.sha ?? null };
      } catch (error) {
        if (error instanceof SynsError && error.code === "not_found" && error.subject !== "version") return { path: filePath, error: "not_found" };
        if (error instanceof SynsError && error.code === "response_too_large") return { path: filePath, error: "too_large" };
        throw error;
      }
    });

    // Whole files only, in request order, inside the response bound. S1.15
    const room = readMany.maxResponseBytes - ENVELOPE - bytes({ version: at, files: [], deferred: params.paths });
    const files: Entry[] = [];
    const deferred: string[] = [];
    let used = 0;
    for (const entry of entries) {
      // A file that alone exceeds an empty response can never be served here; the rest wait their turn.
      const kept: Entry = bytes(entry) + 1 > room && "text" in entry ? { path: entry.path, error: "too_large", size: entry.size, blob: entry.blob } : entry;
      const size = bytes(kept) + 1;
      if (deferred.length > 0 || used + size > room) {
        deferred.push(entry.path);
        continue;
      }
      files.push(kept);
      used += size;
    }
    return { version: at, files, deferred };
  },
};
