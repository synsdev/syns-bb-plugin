import { buildArgs } from "../cli.js";
import { K64, M1, object, path, version, type SimpleMethod } from "../method.js";

export const read: SimpleMethod = {
  name: "syns.read",
  description: "One file, a window of lines: limit lines (default 2000) from line offset (default 1, the first), at version (default head). text has no line numbers; totalLines is the whole file's. For files too large for syns.readMany.",
  effect: "read",
  params: object({ path, version, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 5000 } }, ["path"]),
  result: {
    type: "object",
    properties: {
      version,
      number: { type: "integer" },
      path: { type: "string" },
      text: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
      totalLines: { type: "integer" },
      size: { type: "integer" },
      blob: { type: "string" },
    },
    required: ["version", "number", "path", "text", "offset", "limit", "totalLines", "size", "blob"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  command: (params) => ({ args: buildArgs("read", { offset: params.offset ?? 1, limit: params.limit ?? 2000, version: params.version }, [params.path]) }),
  shape: (out) => ({ version: out.commitSha, number: out.version, path: out.path, text: out.content, offset: out.offset, limit: out.limit, totalLines: out.totalLines, size: out.size, blob: out.sha }),
};
