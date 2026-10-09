import type { Cli, RunResult } from "./cli.js";
import { SynsError, fail, interpret, toAnswer, type FailureAnswer } from "./errors.js";
import { path as pathSchema, pick, provenance, validate, type Context, type Method } from "./method.js";
import { METHODS } from "./methods/index.js";
import { createHeld, type Held } from "./held.js";
import { CLI_NOT_FOUND, type Where } from "./cli.js";
import { atLeast, createVersions, parseTriple, type Versions } from "./version.js";

/** The session's folder as the host passes it (unife-pages 07 R5.84b, U44): an absolute path on `machine`, null where the host has one. */
export interface Workspace {
  id: string;
  path: string;
  machine: string | null;
}

/** One contributed call, as every host sends it (07 §The call). */
export interface Call {
  method: string;
  params: unknown;
  /** `scope`: a placed folder inside the session's folder that the calling document set (D43); null for the folder itself. */
  caller: { sessionId: string | null; scope: string | null; workspace: Workspace | null };
  requestId: string;
}

/** The machine name for a host with one machine. */
export const LOCAL = "local";

/** Where the CLI runs for the session: the folder the host passed, on its machine. Null when there is none; a malformed one throws. */
function sessionWhere(workspace: unknown): Where | null {
  if (workspace === null || workspace === undefined) return null;
  const w = workspace as Partial<Workspace>;
  if (typeof w.path !== "string" || !w.path.startsWith("/") || (w.machine !== null && typeof w.machine !== "string")) {
    throw new SynsError("handler_error", { log: "the host passed a workspace without an absolute path" });
  }
  return { hostId: w.machine ?? LOCAL, cwd: w.path };
}

export type Answer = { ok: true; result: unknown } | FailureAnswer;

export interface Log {
  info(line: string): void;
  warn(line: string): void;
}

export interface DispatchDeps {
  table?: readonly Method[];
  cli: Cli;
  log: Log;
  held?: Held;
  versions?: Versions;
  now?: () => number;
}

/** How long a scope found to belong to its session's repository is held (D46). */
export const SCOPE_TTL_MS = 60_000;

/**
 * threadPagesInvoke: look the method up in the table, check its parameters,
 * take the session's folder from the host, run the CLI, map the outcome. It knows no method by name.
 * spec S2.1, S2.2, S2.14, S2.18–S2.22
 */
export function createDispatch({ table = METHODS, cli, log, held = createHeld(), versions = createVersions(cli), now = Date.now }: DispatchDeps): (call: Call) => Promise<Answer> {
  const byName = new Map(table.map((method) => [method.name, method]));

  /** Scopes found to belong to their session's repository, each held a minute (D46): the answer is about the folder, not its contents. */
  const confirmed = new Map<string, number>();

  /** The repository a folder's `syns repo --json` names: a placed folder's holder, else its own OWNER/NAME. */
  const repositoryOf = (out: unknown): string | null => {
    const doc = (typeof out === "object" && out !== null ? out : {}) as Record<string, unknown>;
    if (typeof doc.holder === "string") return doc.holder.toLowerCase();
    return typeof doc.owner === "string" && typeof doc.name === "string" ? `${doc.owner}/${doc.name}`.toLowerCase() : null;
  };

  async function sameRepository(session: Where, scoped: Where, scope: string, deadline: number): Promise<void> {
    const key = `${session.hostId}\u0000${session.cwd}\u0000${scope}`;
    const at = confirmed.get(key);
    if (at !== undefined && now() - at < SCOPE_TTL_MS) return;
    const never = async () => { throw fail("bad_scope"); };
    let own: string | null;
    try {
      own = repositoryOf(await interpret(await cli.run(session, ["repo", "--json"], undefined, deadline), [], never, { folder: session.cwd }));
    } catch (error) {
      // A session whose folder is no Syns repository has no folder of a repository to scope to.
      if (error instanceof SynsError && (error.reason === "no_repo" || error.reason === "no_access")) throw fail("bad_scope");
      throw error;
    }
    const theirs = repositoryOf(await interpret(await cli.run(scoped, ["repo", "--json"], undefined, deadline), [], never, { folder: session.cwd }));
    if (own === null || theirs !== own) throw fail("bad_scope");
    confirmed.set(key, now());
  }

  async function run(method: Method, params: Record<string, unknown>, sessionId: string | null, scope: string | null, workspace: unknown, deadline: number): Promise<unknown> {
    const problem = validate(method.params, params);
    if (problem) throw new SynsError("invalid_params", { message: `Invalid parameters for ${method.name} at ${problem}` });
    method.check?.(params);

    // The session and its folder come from the host and from nowhere else. No session, no folder. S2.1, S2.2; U44
    if (sessionId === null) throw fail("no_repo");
    const session = sessionWhere(workspace);
    if (!session) throw fail("no_repo");
    // A document's scope narrows the folder the CLI runs in to <session folder>/<scope> (D43). The host
    // refuses a scope that leaves the session's folder; it is checked again here, as a path is. A method
    // that acts on the session's repository as a whole (syns.place) runs at the session's folder.
    const where = scope === null || method.atRoot ? session : { hostId: session.hostId, cwd: `${session.cwd.replace(/\/+$/, "")}/${scope}`, within: session.cwd };

    // A scope must be a folder of the session's own repository: the placed folder's holder, or the session's own identity (D46).
    if (where !== session) await sameRepository(session, where, scope!, deadline);

    // A method that needs a newer CLI asks the machine's version first, once a minute at most.
    if (method.minCli) {
      const need = parseTriple(method.minCli)!;
      const found = await versions.of(where, deadline);
      if (found.spawnError === CLI_NOT_FOUND) throw fail("cli_missing");
      if (!found.triple || !atLeast(found.triple, need)) throw fail("cli_too_old", { need: method.minCli, have: found.text });
    }

    const declared = method.reasons ?? [];
    let repoCheck: Promise<RunResult> | undefined;
    const context: Context = {
      sessionId,
      limits: cli.limits,
      held,
      async syns(args, stdin, options) {
        const mark = provenance(sessionId);
        const env = options?.provenanceEnv ? { SYNS_INTEGRATION: mark.integration!, SYNS_RUN: mark.run!, SYNS_TRIGGER: mark.trigger! } : undefined;
        const ran = await cli.run(where, args, stdin, deadline, env);
        // The 404 rule's `repo` runs at most once per call. S3.5
        return interpret(ran, declared, () => (repoCheck ??= cli.run(where, ["repo", "--json"], undefined, deadline)), { folder: session.cwd, ...(method.notFound ? { notFound: method.notFound } : {}) });
      },
    };

    let result: unknown;
    if ("procedure" in method) {
      result = await method.procedure(params, context);
    } else {
      const command = method.command(params, sessionId);
      const output = await context.syns(command.args, command.stdin, command.provenanceEnv ? { provenanceEnv: true } : undefined);
      if (typeof output !== "object" || output === null || Array.isArray(output)) throw new SynsError("handler_error", { log: "exit=0 output is not a JSON object" });
      if (method.shape) result = method.shape(output as Record<string, unknown>, params);
      else {
        // The CLI's JSON passed on (D59). A named key the CLI gave in another type is dropped; say which, never the value (S2.20).
        const dropped: string[] = [];
        result = pick(method.result, output, "$", dropped);
        if (dropped.length > 0) log.warn(`${method.name} session=${sessionId} dropped from the CLI's output: ${dropped.join(", ").slice(0, 500)}`);
      }
    }
    // Never a result with a hole in it. S3.7
    const hole = validate(method.result, result);
    if (hole) throw new SynsError("handler_error", { log: `exit=0 the result lacks what the specification requires at ${hole}` });
    return result;
  }

  return async (call) => {
    const method = byName.get(call.method);
    if (!method) return toAnswer(new SynsError("unknown_method"));
    const sessionId = call.caller?.sessionId ?? null;
    const rawScope = call.caller?.scope;
    // Absent, null or empty: the session's folder. Anything else must be a relative folder inside it.
    // Anything but absent, null or a string fails closed: a host that changed the field's shape must not widen a document to the whole repository (D46).
    if (rawScope !== undefined && rawScope !== null && typeof rawScope !== "string") return toAnswer(fail("bad_scope"));
    const scope = typeof rawScope === "string" && rawScope !== "" ? (rawScope.startsWith("/") ? rawScope : rawScope.replace(/\/+$/, "")) : null;
    if (scope !== null && validate(pathSchema, scope)) return toAnswer(fail("bad_scope"));
    const params = (call.params ?? {}) as Record<string, unknown>;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail("timeout")), cli.limits.callMs);
    });
    let outcome = "ok";
    try {
      const work = run(method, params, sessionId, scope, call.caller?.workspace, Date.now() + cli.limits.callMs);
      work.catch(() => undefined); // it may lose the race; its failure is then nobody's
      return { ok: true, result: await Promise.race([work, limit]) };
    } catch (caught) {
      const error = caught instanceof SynsError ? caught : new SynsError("handler_error", { log: `threw ${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 500) });
      outcome = error.reason ?? error.code;
      if (error.code === "handler_error") log.warn(`${method.name} session=${sessionId ?? "none"} handler_error ${error.log ?? ""}`.trim());
      return toAnswer(error);
    } finally {
      clearTimeout(timer);
      // The plugin's own record of a write: never the text, never the message. S2.19, S2.20
      if (method.effect === "contributed-write") {
        log.info(`${method.name} session=${sessionId ?? "none"} paths=${pathCount(method, params)} outcome=${outcome}`);
      }
    }
  };
}

/** Of parameters that may not have passed their schema. */
function pathCount(method: Method, params: Record<string, unknown>): number {
  try {
    return method.pathCount ? method.pathCount(params) : typeof params.path === "string" ? 1 : 0;
  } catch {
    return 0;
  }
}
