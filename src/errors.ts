import { CLI_NOT_FOUND, type RunResult } from "./cli.js";

/**
 * Every failure a page can see (spec 03): the reasons, the sentence the plugin
 * writes for each, and the table the CLI's answers are recognised by. The
 * page-facing message is always the plugin's own sentence, never the CLI's text.
 */

export type Code = "invalid_params" | "not_found" | "conflict" | "unavailable" | "handler_error" | "unknown_method" | "response_too_large";

interface ReasonEntry {
  code: Code;
  /** What a reader may be shown. At most 300 characters. S3.1 */
  message: string;
  /** For the page's author: declared to the host and printed in the guide. */
  meaning: string;
  detail?: Record<string, unknown>;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}$", maxLength: 40 };

export const REASONS = {
  no_repo: {
    code: "unavailable",
    message: "This session's folder is not a Syns repository.",
    meaning: "The session's folder holds no Syns repository, or the caller is the home page. Say so on the page and keep the rest working.",
  },
  no_access: {
    code: "unavailable",
    message: "The Syns account on this session's machine cannot reach the repository, or is logged out.",
    meaning: "The account on that machine cannot reach the repository, or is logged out. Nothing the page can fix.",
  },
  not_logged_in: {
    code: "unavailable",
    message: "Nobody is logged in to Syns on this session's machine.",
    meaning: "No Syns login on that machine.",
  },
  cli_missing: {
    code: "unavailable",
    message: "The Syns command-line tool was not found on this session's machine.",
    meaning: "No syns executable on that machine. An operator installs it or sets the plugin's synsPath.",
  },
  timeout: {
    code: "unavailable",
    message: "Syns did not answer in time. Try again.",
    meaning: "The CLI did not answer within the plugin's limits. Safe to retry a read; after a write, re-read syns.repo first.",
  },
  stale_head: {
    code: "conflict",
    message: "The repository changed since this page last read it. Nothing was written.",
    meaning: "base is no longer the head; detail.current is the head now. Re-read, show the reader what changed, let them try again.",
    detail: { type: "object", properties: { current: SHA }, required: ["current"] },
  },
  checkout_dirty: {
    code: "conflict",
    message: "An agent is working in this session's folder and has unpublished edits. Nothing was written; try again when its turn ends.",
    meaning: "The session's folder has unpublished edits, usually an agent mid-turn. Say the agent is working; try again when syns.repo's version moves.",
  },
  exists: {
    code: "conflict",
    message: "A file is already there. Nothing was written.",
    meaning: "create was set and the path exists at base.",
  },
  no_match: {
    code: "invalid_params",
    message: "The text to replace was not found in the file. Nothing was written.",
    meaning: "old occurs nowhere in the file.",
  },
  many_matches: {
    code: "invalid_params",
    message: "The text to replace occurs more than once in the file. Nothing was written.",
    meaning: "old occurs detail.count times and replaceAll is not set.",
    detail: { type: "object", properties: { count: { type: "integer", minimum: 2 } }, required: ["count"] },
  },
  bad_pattern: {
    code: "invalid_params",
    message: "The search pattern could not be understood.",
    meaning: "The regular expression or glob does not parse.",
  },
  invalid_change: {
    code: "invalid_params",
    message: "The change names a path twice, or changes nothing. Nothing was written.",
    meaning: "A path named twice across files and deletions, or no change at all.",
  },
} as const satisfies Record<string, ReasonEntry>;

export type Reason = keyof typeof REASONS;

/** Sentences for failures that carry a code and no reason. */
const CODE_MESSAGES: Record<Code, string> = {
  invalid_params: "The page sent parameters this method does not accept.",
  not_found: "That path or version does not exist in the repository.",
  conflict: "The repository changed. Nothing was written.",
  unavailable: "Syns is not available for this session right now.",
  handler_error: "Syns could not complete this. The plugin's log has the cause.",
  unknown_method: "The Syns plugin has no such method.",
  response_too_large: "The answer is too large to return. Ask for less at a time.",
};

export class SynsError extends Error {
  readonly code: Code;
  readonly reason?: Reason;
  readonly detail?: Record<string, unknown>;
  /** For the plugin's log only (S2.18). Never sent to a page. */
  readonly log?: string;
  /** Set on a not_found that is known to be about the version rather than a path. */
  readonly subject?: "version";

  constructor(code: Code, options: { reason?: Reason; detail?: Record<string, unknown>; message?: string; log?: string; subject?: "version" } = {}) {
    super(options.message ?? (options.reason ? REASONS[options.reason].message : CODE_MESSAGES[code]));
    this.code = code;
    if (options.reason) this.reason = options.reason;
    if (options.detail) this.detail = options.detail;
    if (options.log) this.log = options.log;
    if (options.subject) this.subject = options.subject;
  }
}

export const fail = (reason: Reason, detail?: Record<string, unknown>): SynsError => new SynsError(REASONS[reason].code, { reason, ...(detail ? { detail } : {}) });

export interface FailureAnswer {
  ok: false;
  error: { code: Code; message: string; reason?: Reason; detail?: Record<string, unknown> };
}

export function toAnswer(error: SynsError): FailureAnswer {
  return { ok: false, error: { code: error.code, message: error.message.slice(0, 300), ...(error.reason ? { reason: error.reason } : {}), ...(error.detail ? { detail: error.detail } : {}) } };
}

function parse(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/**
 * One finished CLI run becomes its parsed document, or throws the failure a
 * page sees. `declared` is the reasons the calling method declares beyond the
 * common ones; `runRepo` runs `repo --json` for the 404 rule.
 * spec S2.13, S3.4–S3.7
 */
export async function interpret(run: RunResult, declared: readonly string[], runRepo: () => Promise<RunResult>): Promise<unknown> {
  if (run.spawnError !== null) {
    if (run.spawnError === CLI_NOT_FOUND) throw fail("cli_missing");
    throw new SynsError("handler_error", { log: `could not start: ${run.spawnError.slice(0, 500)}` });
  }
  if (run.timedOut) throw fail("timeout");
  if (run.overflowed) throw new SynsError("response_too_large");

  const parsed = parse(run.stdout);
  if (run.exitCode === 0) {
    // On success the output may hold a file's text or an account's details, so none of it is logged. S2.20
    if (!parsed) throw new SynsError("handler_error", { log: `exit=0 output is not JSON (${run.stdout.length} characters)` });
    return parsed.value;
  }

  const document = parsed && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
  const error = typeof document.error === "string" ? document.error : "";
  const exit = run.exitCode;

  // The recognition table, in the order S3.4 gives.
  if (exit === 7 && typeof document.currentSha === "string") throw fail("stale_head", { current: document.currentSha });
  if (exit === 2 && error.includes("cannot determine repo identity")) throw fail("no_repo");
  if (exit === 1 && error.includes("holds unpublished local changes")) throw fail("checkout_dirty");
  if (exit === 1 && error.includes("authentication required")) throw fail(declared.includes("not_logged_in") ? "not_logged_in" : "no_access");
  if (exit === 1 && error.includes("--old matched no content")) throw fail("no_match");
  const times = exit === 1 ? /--old matched (\d+) times/.exec(error) : null;
  if (times) throw fail("many_matches", { count: Number(times[1]) });
  if (exit === 1 && error.includes("(404)")) {
    // A missing path and an unreachable repository print the same line. S3.5
    const repo = await runRepo();
    if (repo.exitCode === 0 && repo.spawnError === null && !repo.timedOut) throw new SynsError("not_found");
    throw fail("no_access");
  }
  if (exit === 1 && error.includes("invalid pattern")) throw fail("bad_pattern");
  // Row 8a: with --version the CLI answers a missing path, and an unknown version, in words of its own
  // rather than with the 404.
  if (exit === 1 && error.includes("path not found at version")) throw new SynsError("not_found");
  if (exit === 1 && error.includes("version not found")) throw new SynsError("not_found", { subject: "version" });

  throw new SynsError("handler_error", { log: `exit=${exit} output=${(run.stdout + run.stderr).trim().slice(0, 500)}` });
}
