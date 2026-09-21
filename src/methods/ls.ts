import { buildArgs } from "../cli.js";
import { K64, M1, nullable, object, path, version, type SimpleMethod } from "../method.js";

// The host refuses a result over 10,000 JSON nodes, and an entry is five. D18
const PAGE = 1500;

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const ls: SimpleMethod = {
  name: "syns.ls",
  description: "Files and folders under path (default root), one level or recursive, at version (default head). blob changes exactly when content does. Paged: up to 1500 entries from offset; nextOffset is null on the last page. Pass the version on.",
  effect: "read",
  params: object({ path, recursive: { type: "boolean" }, version, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: PAGE } }),
  result: {
    type: "object",
    properties: {
      version,
      number: { type: "integer" },
      truncated: { type: "boolean" },
      total: { type: "integer" },
      nextOffset: nullable("integer"),
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, type: { type: "string", enum: ["file", "dir"] }, size: nullable("integer"), blob: nullable("string") },
          required: ["path", "type", "size", "blob"],
        },
      },
    },
    required: ["version", "number", "truncated", "total", "nextOffset", "entries"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  command: (params) => ({ args: buildArgs("ls", { recursive: params.recursive === true, version: params.version }, params.path === undefined ? [] : [params.path]) }),
  // offset and limit never reach the CLI: the plugin slices its listing. D18
  shape: (out, params) => {
    const all = Array.isArray(out.entries) ? out.entries.map(record) : undefined;
    const offset: number = params.offset ?? 0;
    const end = offset + (params.limit ?? PAGE);
    return {
      version: out.commitSha,
      number: out.version,
      truncated: out.truncated,
      total: all?.length,
      nextOffset: all === undefined ? undefined : end < all.length ? end : null,
      entries: all?.slice(offset, end).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size ?? null, blob: entry.sha ?? null })),
    };
  },
};
