import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { ENVELOPE, K64, M1, bytes, nullable, object, path, version, type SimpleMethod } from "../method.js";

// The host refuses a result over 10,000 JSON nodes. An entry is five, so a page holds 1,500; a line is one, so a page
// of lines holds 9,000, and ends earlier at the last whole line inside the 1 MiB answer. D18, D83
const PAGE = 1500;
const LINES_PAGE = 9000;

interface Params {
  path?: string;
  recursive?: boolean;
  version?: string;
  offset?: number;
  limit?: number;
  format?: "lines";
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** One entry as one string: `path\tblob\tsize`, a folder's blob and size empty. */
const line = (entry: Record<string, unknown>): string => `${String(entry.path)}\t${entry.sha ?? ""}\t${entry.size ?? ""}`;

export const ls: SimpleMethod = {
  name: "syns.ls",
  description: "Files and folders under path (default root), one level or recursive, at version (default head). blob changes exactly when content does. Paged from offset: 1500 entries, or 9000 with format lines; nextOffset null at the end. Pass version on.",
  effect: "read",
  params: object({
    path,
    recursive: { type: "boolean" },
    version,
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: LINES_PAGE, description: "At most 1500, or 9000 with format lines." },
    format: { type: "string", enum: ["lines"], maxLength: 5, description: "lines: each entry one string path\\tblob\\tsize in lines, a folder's blob and size empty." },
  }),
  result: {
    type: "object",
    description: "entries, or with format lines, lines.",
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
      lines: { type: "array", items: { type: "string" } },
    },
    required: ["version", "number", "truncated", "total", "nextOffset"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  check(params: Params) {
    if (params.format !== "lines" && (params.limit ?? 0) > PAGE) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.ls: limit can be at most ${PAGE}, or ${LINES_PAGE} with format lines` });
  },
  command: (params: Params) => ({ args: buildArgs("ls", { recursive: params.recursive === true, version: params.version }, params.path === undefined ? [] : [params.path]) }),
  // offset, limit and format never reach the CLI: the plugin slices and shapes its listing. D18
  shape: (out, params: Params) => {
    // The schema cannot require one of entries and lines, so the hole is looked for here. S3.7
    if (!Array.isArray(out.entries)) throw new SynsError("handler_error", { log: "exit=0 the result lacks what the specification requires at $.entries" });
    const all = out.entries.map(record);
    const offset = params.offset ?? 0;
    const common = { version: out.commitSha, number: out.version, truncated: out.truncated, total: all.length };
    if (params.format !== "lines") {
      const end = offset + (params.limit ?? PAGE);
      return { ...common, nextOffset: end < all.length ? end : null, entries: all.slice(offset, end).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size ?? null, blob: entry.sha ?? null })) };
    }
    // Lines while they fit the 1 MiB answer beside the rest of the result; one at least.
    const end = Math.min(all.length, offset + (params.limit ?? LINES_PAGE));
    const room = M1 - ENVELOPE - bytes({ ...common, nextOffset: all.length, lines: [] });
    const lines: string[] = [];
    let used = 0;
    for (let at = offset; at < end; at += 1) {
      const one = line(all[at]!);
      const size = bytes(one) + 1;
      if (lines.length > 0 && used + size > room) break;
      lines.push(one);
      used += size;
    }
    const next = offset + lines.length;
    return { ...common, nextOffset: next < all.length ? next : null, lines };
  },
};
