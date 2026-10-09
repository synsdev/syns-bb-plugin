import { buildArgs } from "../cli.js";
import { K64, M1, nullable, object, path, version, type SimpleMethod } from "../method.js";

const MAX_PATHS = 200;
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const history: SimpleMethod = {
  name: "syns.history",
  description: "Newest versions first: who or what made each, and the paths it changed. A page's commit has by.integration syns-pages and by.trigger page. No paging past limit (default 20); total says how many.",
  effect: "read",
  params: object({ path, limit: { type: "integer", minimum: 1, maximum: 100 } }),
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
            paths: { type: "array", items: { type: "string" }, maxItems: MAX_PATHS },
            pathsTruncated: { type: "boolean" },
            by: {
              type: "object",
              properties: { integration: nullable("string"), run: nullable("string"), trigger: nullable("string") },
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
  command: (params) => ({ args: buildArgs("history", { file: params.path, limit: params.limit ?? 20 }) }),
  shape: (out, params) => ({
    total: out.total,
    entries: Array.isArray(out.data)
      ? out.data.map(record).map((row) => {
          // With --file the CLI's rows name no paths (and no parent): every row changed that file.
          const paths = Array.isArray(row.filesChanged) ? (row.filesChanged as unknown[]) : typeof params.path === "string" ? [params.path] : undefined;
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
