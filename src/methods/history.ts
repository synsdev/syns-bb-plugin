import { buildArgs } from "../cli.js";
import { BY, K64, M1, nullable, object, path, repoPath, version, type SimpleMethod } from "../method.js";

const MAX_PATHS = 200;
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const history: SimpleMethod = {
  name: "syns.history",
  description: "Newest versions first: who or what made each, and the paths it changed. A page's commit has by.integration syns-pages and by.trigger page. limit (default 20) from offset; total says how many. Next page: offset + limit.",
  effect: "read",
  params: object({
    path,
    limit: { type: "integer", minimum: 1, maximum: 100 },
    // The CLI's --offset is a u32, as grep's: a larger value is refused here, not by its parser.
    offset: { type: "integer", minimum: 0, maximum: 4294967295 },
  }),
  result: {
    type: "object",
    properties: {
      total: { type: "integer" },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            version,
            number: { type: "integer" },
            parent: { ...version, type: ["string", "null"] },
            author: nullable("string"),
            at: { type: "string" },
            message: { type: "string" },
            paths: { type: "array", items: repoPath, maxItems: MAX_PATHS },
            pathsTruncated: { type: "boolean" },
            by: {
              type: "object",
              properties: BY,
              required: ["integration", "run", "trigger"],
            },
          },
          required: ["version", "number", "parent", "author", "at", "message", "paths", "pathsTruncated", "by"],
        },
      },
    },
    required: ["total", "entries"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  command: (params) => ({ args: buildArgs("history", { file: params.path, limit: params.limit ?? 20, offset: params.offset }) }),
  shape: (out, params) => ({
    total: out.total,
    entries: Array.isArray(out.data)
      ? out.data.map(record).map((row) => {
          // With --file a row names no filesChanged: since CLI 0.3.25 it names the file's own path at that version, and
          // where a move took it from, as filesChanged would ([movedFrom, path]); before, only the path asked for (S1.7).
          const own = typeof row.path === "string" ? [...(typeof row.movedFrom === "string" ? [row.movedFrom] : []), row.path] : typeof params.path === "string" ? [params.path] : undefined;
          const paths = Array.isArray(row.filesChanged) ? (row.filesChanged as unknown[]) : own;
          const provenance = record(row.provenance);
          return {
            version: row.sha,
            number: row.version,
            parent: row.parentSha ?? null,
            author: row.author ?? null,
            at: row.createdAt,
            message: row.message,
            paths: paths?.slice(0, MAX_PATHS),
            pathsTruncated: paths ? paths.length > MAX_PATHS : undefined,
            by: { integration: provenance.integration ?? null, run: provenance.run ?? null, trigger: provenance.trigger ?? null },
          };
        })
      : undefined,
  }),
};
