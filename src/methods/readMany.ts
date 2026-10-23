import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { ENVELOPE, K64, M1, bytes, nullable, object, path, repoPath, version, type Context, type ProcedureMethod } from "../method.js";

interface Params {
  paths: string[];
  version?: string;
}

type Entry = { path: string; text: string; size: unknown; blob: unknown } | { path: string; error: "not_found" } | { path: string; error: "too_large" | "not_text"; size?: unknown; blob?: unknown };

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});


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
          description: "Either path, text, size and blob, or path and error. not_text carries size and blob; too_large does when known.",
          properties: { path: repoPath, text: { type: "string" }, size: { type: "integer" }, blob: nullable("string"), error: { type: "string", enum: ["not_found", "too_large", "not_text"] } },
          required: ["path"],
        },
      },
      deferred: { type: "array", items: repoPath },
    },
    required: ["version", "files", "deferred"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  check(params: Params) {
    if (new Set(params.paths).size !== params.paths.length) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readMany: paths must be distinct" });
  },

  async procedure(params: Params, context: Context) {
    // One run: every path at one commit, the given version or the head the CLI resolves in the same run; standard
    // input holds the paths, and --max-bytes the room left in the answer, so the CLI fetches nothing past it (S1.13,
    // S1.14, D83). The room is counted as 0.8.7 counted it, with a version of 40 characters.
    const room = readMany.maxResponseBytes - ENVELOPE - bytes({ version: "0".repeat(40), files: [], deferred: params.paths });
    const out = record(await context.syns(buildArgs("cat", { version: params.version, "paths-from": "-", "max-bytes": room }), `${params.paths.join("\n")}\n`));
    const served = new Map(Array.isArray(out.files) ? out.files.map(record).map((entry) => [entry.path, entry] as const) : []);
    const later = new Set(Array.isArray(out.deferred) ? out.deferred : []);

    // The CLI's answer, in request order. S1.16
    const entries: Entry[] = [];
    const deferredByCli: string[] = [];
    for (const filePath of params.paths) {
      const entry = served.get(filePath);
      if (entry === undefined) {
        if (!later.has(filePath)) throw new SynsError("handler_error", { log: "exit=0 the CLI's files answer leaves a path out" });
        deferredByCli.push(filePath);
        continue;
      }
      const error = record(entry.error);
      if (entry.error !== undefined) {
        if (error.code === "NOT_FOUND") {
          entries.push({ path: filePath, error: "not_found" });
          continue;
        }
        // Any other per-file error fails the call, in the CLI's words; the log names the class, never the path (Q-0155).
        const words = context.redact(String(error.message ?? "").trim());
        throw new SynsError("handler_error", { ...(words ? { message: words.slice(0, 300) } : {}), log: `readMany per-file ${String(error.code).slice(0, 64)}` });
      }
      // A file that is not text is named with its size and hash, and no bytes: syns.readBinary reads those (D-088, D29).
      if (typeof entry.content !== "string") entries.push({ path: filePath, error: "not_text", size: entry.size, blob: entry.sha ?? null });
      else entries.push({ path: filePath, text: entry.content, size: entry.size, blob: entry.sha ?? null });
    }

    // A first path the CLI deferred passed the room alone: it was never read, so it carries no size or blob (D83).
    if (entries.length === 0 && deferredByCli.length > 0) return { version: out.commitSha, files: [{ path: deferredByCli[0]!, error: "too_large" }], deferred: deferredByCli.slice(1) };

    // Whole files only, in request order, inside the response bound, counted as the text escapes in JSON. S1.15
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
    return { version: out.commitSha, files, deferred: [...deferred, ...deferredByCli] };
  },
};
