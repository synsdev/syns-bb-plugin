import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { ENVELOPE, K64, M1, bytes, object, path, version, type SimpleMethod } from "../method.js";

/**
 * The lines of a window that fit one answer, from its first (D22). A text crosses as a JSON string, so a
 * line is measured as it is escaped. At least one line, or response_too_large.
 */
function fit(result: Record<string, unknown>, room: number): Record<string, unknown> {
  if (bytes(result) <= room) return result;
  const lines = String(result.text).split("\n");
  const fixed = bytes({ ...result, text: "" });
  let used = fixed;
  let kept = 0;
  for (const line of lines) {
    const cost = bytes(line) - 2 + (kept > 0 ? 2 : 0);
    if (used + cost > room) break;
    used += cost;
    kept += 1;
  }
  if (kept === 0) throw new SynsError("response_too_large", { log: "one line is larger than an answer" });
  return { ...result, text: lines.slice(0, kept).join("\n"), limit: kept };
}

export const read: SimpleMethod = {
  name: "syns.read",
  description: "One file, a window of lines: limit lines (default 2000) from offset (default 1), at version (default head). A window too large for one answer is cut short: limit says how many lines came. Line ends come as \\n.",
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
  shape: (out) => fit({ version: out.commitSha, number: out.version, path: out.path, text: out.content, offset: out.offset, limit: out.limit, totalLines: out.totalLines, size: out.size, blob: out.sha }, M1 - ENVELOPE),
};
