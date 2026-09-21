import { buildArgs } from "../cli.js";
import { K64, M1, nullable, object, path, version, type SimpleMethod } from "../method.js";

// The host refuses a result over 10,000 JSON nodes, and a match is four. D19
const PAGE = 2000;

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const glob: SimpleMethod = {
  name: "syns.glob",
  description: "The files whose whole repository-relative path matches a glob pattern such as notes/**/*.md, under path (default root), at version (default head). No match: an empty list. Paged: up to 2000 from offset; nextOffset is null on the last page.",
  effect: "read",
  params: object({ pattern: { type: "string", minLength: 1, maxLength: 512 }, path, version, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: PAGE } }, ["pattern"]),
  result: {
    type: "object",
    properties: {
      version,
      number: { type: "integer" },
      truncated: { type: "boolean" },
      total: { type: "integer" },
      nextOffset: nullable("integer"),
      matches: {
        type: "array",
        items: { type: "object", properties: { path: { type: "string" }, size: { type: "integer" }, blob: { type: "string" } }, required: ["path", "size", "blob"] },
      },
    },
    required: ["version", "number", "truncated", "total", "nextOffset", "matches"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  reasons: ["bad_pattern"],
  command: (params) => ({ args: buildArgs("glob", { path: params.path, version: params.version }, [params.pattern]) }),
  // offset and limit never reach the CLI: the plugin slices its answer. D19
  shape: (out, params) => {
    const all = Array.isArray(out.matches) ? out.matches.map(record) : undefined;
    const offset: number = params.offset ?? 0;
    const end = offset + (params.limit ?? PAGE);
    return {
      version: out.commitSha,
      number: out.version,
      truncated: out.truncated,
      total: all?.length,
      nextOffset: all === undefined ? undefined : end < all.length ? end : null,
      matches: all?.slice(offset, end).map((match) => ({ path: match.path, size: match.size, blob: match.sha })),
    };
  },
};
