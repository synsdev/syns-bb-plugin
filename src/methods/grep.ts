import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { K64, M1, nullable, object, path, version, type SimpleMethod } from "../method.js";

interface Params {
  pattern: string;
  path?: string;
  glob?: string[];
  ignoreCase?: boolean;
  context?: number;
  output?: "content" | "files" | "count";
  headLimit?: number;
  offset?: number;
  version?: string;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const rows = (value: unknown): Record<string, unknown>[] | undefined => (Array.isArray(value) ? value.map(record) : undefined);
const lineAndText = { type: "object", properties: { line: { type: "integer" }, text: { type: "string" } }, required: ["line", "text"] };

// The host refuses a result over 10,000 JSON nodes. A content row is five nodes and each context
// line three more, up to 2 × context of them; the most rows that always fit 9,000. D19
const mostRows = (params: Params): number => ((params.output ?? "content") === "content" ? Math.min(1000, Math.floor(9000 / (5 + 6 * (params.context ?? 0)))) : 1000);

export const grep: SimpleMethod = {
  name: "syns.grep",
  description: "Regex search under path, in files matching glob, at version (default head). output: content (default), files or count. headLimit caps rows (default 200). At most 400 files a call: pass nextOffset as offset and the first page's version",
  effect: "read",
  params: object(
    {
      pattern: { type: "string", minLength: 1, maxLength: 512 },
      path,
      glob: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 512 } },
      ignoreCase: { type: "boolean" },
      context: { type: "integer", minimum: 0, maximum: 10, description: "Lines either side of each match. Only with output content." },
      output: { type: "string", enum: ["content", "files", "count"], maxLength: 7 },
      headLimit: { type: "integer", minimum: 1, maximum: 1000, description: "Rows at most: default 200, fewer with context." },
      // The CLI's --offset is a u32: a larger value is refused here, not by its parser.
      offset: { type: "integer", minimum: 0, maximum: 4294967295, description: "Files to skip, in path order: the last call's nextOffset." },
      version,
    },
    ["pattern"],
  ),
  result: {
    type: "object",
    description: "Beside the common keys, exactly one of matches, files and counts: the one output names.",
    properties: {
      version,
      number: { type: "integer" },
      output: { type: "string", enum: ["content", "files", "count"] },
      truncated: { type: "boolean" },
      nextOffset: nullable("integer"),
      skipped: { type: "array", items: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } }, required: ["path", "reason"] } },
      matches: {
        type: "array",
        items: { type: "object", properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" }, context: { type: "array", items: lineAndText } }, required: ["path", "line", "text", "context"] },
      },
      files: { type: "array", items: { type: "string" } },
      counts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, count: { type: "integer" } }, required: ["path", "count"] } },
    },
    required: ["version", "number", "output", "truncated", "nextOffset", "skipped"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  reasons: ["bad_pattern"],
  check(params: Params) {
    // A later page is only the same file list at the version the first was read at: a commit between pages would shift it. D-156
    if ((params.offset ?? 0) > 0 && params.version === undefined) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.grep: a later page needs the version of the first" });
    if ((params.headLimit ?? 0) > mostRows(params)) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.grep: with this output and context, headLimit can be at most ${mostRows(params)}` });
    // The CLI refuses --context under any output but content; refused here, before a process runs.
    if ((params.context ?? 0) > 0 && (params.output ?? "content") !== "content") throw new SynsError("invalid_params", { message: "Invalid parameters for syns.grep: context applies only with output content" });
  },
  command(params: Params) {
    // Line numbers always, where the CLI has them: it refuses --line-number under any output but content.
    const content = (params.output ?? "content") === "content";
    return {
      args: buildArgs(
        "grep",
        {
          path: params.path,
          glob: params.glob,
          "ignore-case": params.ignoreCase === true,
          "line-number": content,
          context: content && params.context ? params.context : undefined,
          output: params.output ?? "content",
          "head-limit": params.headLimit ?? Math.min(200, mostRows(params)),
          offset: params.offset ? params.offset : undefined,
          version: params.version,
        },
        [params.pattern],
      ),
    };
  },
  shape(out) {
    // Where the CLI names no next window there is none: null (S3.7 holds the key present).
    const nextOffset = typeof out.nextOffset === "number" ? out.nextOffset : null;
    const common = { version: out.commitSha, number: out.version, output: out.output, truncated: out.truncated, nextOffset, skipped: rows(out.skipped)?.map((skip) => ({ path: skip.path, reason: skip.reason })) };
    const found =
      out.output === "files"
        ? { files: Array.isArray(out.files) ? out.files : undefined }
        : out.output === "count"
          ? { counts: rows(out.counts)?.map((count) => ({ path: count.path, count: count.count })) }
          : { matches: rows(out.matches)?.map((match) => ({ path: match.path, line: match.line, text: match.text, context: rows(match.context)?.map((line) => ({ line: line.line, text: line.text })) })) };
    // The schema cannot say "one of", so the hole is looked for here. S3.7
    if (Object.values(found)[0] === undefined) throw new SynsError("handler_error", { log: `exit=0 the result lacks the rows of output ${String(out.output)}` });
    return { ...common, ...found };
  },
};
