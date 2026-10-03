import { CLI_NOT_FOUND, SCOPE_OUTSIDE, type RunResult } from "./cli.js";

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

/** `LIM-file-size`: the most one file in Syns may hold (D-088, HOST_FACTS §12). */
export const FILE_MAX = 25 * 1024 * 1024;

export const REASONS = {
  no_repo: {
    code: "unavailable",
    message: "This session's folder is not a Syns repository.",
    meaning: "The session's folder holds no Syns repository, or the caller is the home page.",
  },
  no_access: {
    code: "unavailable",
    message: "The Syns account on this session's machine cannot reach the repository, or is logged out.",
    meaning: "The machine's account cannot reach the repository, or is logged out.",
  },
  not_logged_in: {
    code: "unavailable",
    message: "Nobody is logged in to Syns on this session's machine.",
    meaning: "No Syns login on that machine.",
  },
  cli_missing: {
    code: "unavailable",
    message: "The Syns command-line tool was not found on this session's machine.",
    meaning: "No syns on that machine; an operator installs it or sets synsPath.",
  },
  timeout: {
    code: "unavailable",
    message: "Syns did not answer in time. Try again.",
    meaning: "The CLI did not answer in time. Retry a read; after a write, re-read syns.repo first.",
  },
  cli_too_old: {
    code: "unavailable",
    message: "The Syns command-line tool on this session's machine is too old for this. Run syns upgrade there.",
    meaning: "The machine's syns is older than detail.need (detail.have): syns upgrade there.",
    detail: { type: "object", properties: { need: { type: "string" }, have: { type: ["string", "null"] } }, required: ["need", "have"] },
  },
  folder_out_of_place: {
    code: "unavailable",
    message: "This session's folder is not where its repository records it, so Syns will not use it.",
    meaning: "A placed folder stands away from the path its identity file records; an operator moves it back.",
  },
  folder_write_unsupported: {
    code: "unavailable",
    message: "The Syns server cannot take writes from inside a placed folder yet. Nothing was written.",
    meaning: "The server is too old for writes in a placed folder. Nothing written; reads work.",
  },
  occupied: {
    code: "conflict",
    message: "That folder already holds files. Nothing was placed.",
    meaning: "path already holds a file at the head or on disk; choose another.",
  },
  no_such_template: {
    code: "not_found",
    message: "That template does not exist, or this account cannot read it.",
    meaning: "template is no repository the reader can read.",
  },
  bad_scope: {
    code: "invalid_params",
    message: "This page asked for something its folder cannot do here: it is not a placed folder of its session's repository, or this action needs another kind of folder.",
    meaning: "The scope is not a placed folder of the session's own repository, or the CLI does not act there: a folder action at a root, a repository action in a placed folder.",
  },
  stale_head: {
    code: "conflict",
    message: "The repository changed since this page last read it. Nothing was written.",
    meaning: "The repository, or placed folder, changed after base; nothing written; detail.current is the head. Re-read, show what changed, never retry blindly.",
    detail: { type: "object", properties: { current: SHA }, required: ["current"] },
  },
  checkout_dirty: {
    code: "conflict",
    message: "An agent is working in this session's folder and has unpublished edits. Nothing was written; try again when its turn ends.",
    meaning: "The session's folder has unpublished edits, usually its agent mid-turn. Nothing written; retry when syns.repo's version moves.",
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
  bad_offset: {
    code: "conflict",
    message: "The picture's pieces did not arrive in order, or were dropped. Send it again from the offset expected.",
    meaning: "Send the piece at detail.expected; 0 means start again (pieces or an upload are dropped after a minute).",
    detail: { type: "object", properties: { expected: { type: "integer", minimum: 0 } }, required: ["expected"] },
  },
  bad_hash: {
    code: "invalid_params",
    message: "The picture that arrived is not the one described. Nothing was written.",
    meaning: "The gathered bytes do not match sha256; nothing published.",
  },
  too_large: {
    code: "invalid_params",
    message: "The file is larger than one file in Syns may be. Nothing was written.",
    meaning: "Past detail.max bytes, the most one file may hold (25 MiB).",
    detail: { type: "object", properties: { max: { type: "integer" } }, required: ["max"] },
  },
  bad_name: {
    code: "invalid_params",
    message: "That name cannot be used. Use lower-case letters, digits, dots, dashes and underscores.",
    meaning: "name breaks the repository-name rule.",
  },
  name_taken: {
    code: "conflict",
    message: "That name is already taken. Nothing was shared.",
    meaning: "Another repository holds name; offer the reader another.",
  },
  not_permitted: {
    code: "unavailable",
    message: "Only an owner or admin of the repository can change who it is shared with.",
    meaning: "The reader is below admin on the holding repository.",
  },
  no_such_user: {
    code: "not_found",
    message: "There is no Syns user by that name or e-mail.",
    meaning: "user names nobody on Syns.",
  },
  already_collaborator: {
    code: "conflict",
    message: "That person already has access to this folder.",
    meaning: "user already holds a grant here; nothing changed.",
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
    // A scope that resolves outside the session's folder, or to no folder, symlinks followed (D43).
    if (run.spawnError === SCOPE_OUTSIDE) throw fail("bad_scope");
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
  // A placed folder moved away from its recorded path, and a server without folder writes (HOST_FACTS §14, D38).
  if (exit === 2 && error.startsWith("folder out of place")) throw fail("folder_out_of_place");
  if (exit === 1 && error.startsWith("folder_write_unsupported")) throw fail("folder_write_unsupported");
  if (exit === 1 && error.includes("holds unpublished local changes")) throw fail("checkout_dirty");
  if (exit === 1 && error.includes("authentication required")) throw fail(declared.includes("not_logged_in") ? "not_logged_in" : "no_access");
  if (exit === 1 && error.includes("--old matched no content")) throw fail("no_match");
  // syns place (D43, HOST_FACTS §14).
  if (exit === 1 && error.startsWith("configuration error") && error.includes(" already holds ")) throw fail("occupied");
  if (exit === 1 && error.startsWith("not_found:") && error.includes("is no repository you can read")) throw fail("no_such_template");
  // Sharing (D41, HOST_FACTS §15). The 409s carry no currentSha, so the method's declared reasons tell them apart.
  // Where the CLI does not act in this scope (D59, HOST_FACTS §17): a folder's command at a root, a holder's in a placed folder.
  if (exit === 1 && error.includes("the folder path must name a folder")) throw fail("bad_scope");
  if (exit === 1 && error.includes("holds no folder placed from a template")) throw fail("bad_scope");
  if (exit === 2 && error.startsWith("holder root required")) throw fail("bad_scope");
  if (exit === 1 && error.includes("configuration error: a name holds")) throw fail("bad_name");
  if (exit === 1 && error.includes("(403)")) throw fail(declared.includes("not_permitted") ? "not_permitted" : "no_access");
  if (exit === 1 && error.includes("no user '")) throw fail("no_such_user");
  if (exit === 1 && error.includes("(409)") && declared.includes("name_taken")) throw fail("name_taken");
  if (exit === 1 && error.includes("(409)") && declared.includes("already_collaborator")) throw fail("already_collaborator");
  const times = exit === 1 ? /--old matched (\d+) times/.exec(error) : null;
  if (times) throw fail("many_matches", { count: Number(times[1]) });
  if (exit === 1 && error.includes("(404)")) {
    // A missing path and an unreachable repository print the same line. S3.5
    const repo = await runRepo();
    if (repo.exitCode === 0 && repo.spawnError === null && !repo.timedOut) throw new SynsError("not_found");
    throw fail("no_access");
  }
  if (exit === 1 && error.includes("invalid pattern")) throw fail("bad_pattern");
  // Row 8b: a file past the one-file limit, refused by the CLI before anything is sent (HOST_FACTS §12).
  if (exit === 1 && error.startsWith("payload_too_large")) throw fail("too_large", { max: FILE_MAX });
  // Row 8a: with --version the CLI answers a missing path, and an unknown version, in words of its own
  // rather than with the 404.
  if (exit === 1 && error.includes("path not found at version")) throw new SynsError("not_found");
  if (exit === 1 && error.includes("version not found")) throw new SynsError("not_found", { subject: "version" });

  // Any other refusal comes back in the CLI's own words (D59); the plugin's sentence only when it gave none.
  const words = error.trim();
  throw new SynsError("handler_error", { ...(words ? { message: words.slice(0, 300) } : {}), log: `exit=${exit} output=${(run.stdout + run.stderr).trim().slice(0, 500)}` });
}
