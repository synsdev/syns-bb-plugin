import type { Cli, RunResult } from "./cli.js";
import { SynsError, fail, interpret, toAnswer, type FailureAnswer } from "./errors.js";
import { validate, type Context, type Method } from "./method.js";
import { METHODS } from "./methods/index.js";
import type { Resolve } from "./resolve.js";
import { createHeld, type Held } from "./held.js";

/** What Thread Pages sends to `threadPagesInvoke`. */
export interface Call {
  method: string;
  params: unknown;
  caller: { sessionId: string | null };
  requestId: string;
}

export type Answer = { ok: true; result: unknown } | FailureAnswer;

export interface Log {
  info(line: string): void;
  warn(line: string): void;
}

export interface DispatchDeps {
  table?: readonly Method[];
  cli: Cli;
  resolve: Resolve;
  log: Log;
  held?: Held;
}

/**
 * threadPagesInvoke: look the method up in the table, check its parameters,
 * resolve the session, run the CLI, map the outcome. It knows no method by name.
 * spec S2.1, S2.2, S2.14, S2.18–S2.22
 */
export function createDispatch({ table = METHODS, cli, resolve, log, held = createHeld() }: DispatchDeps): (call: Call) => Promise<Answer> {
  const byName = new Map(table.map((method) => [method.name, method]));

  async function run(method: Method, params: Record<string, unknown>, sessionId: string | null, deadline: number): Promise<unknown> {
    const problem = validate(method.params, params);
    if (problem) throw new SynsError("invalid_params", { message: `Invalid parameters for ${method.name} at ${problem}` });
    method.check?.(params);

    // The session comes from the host and from nowhere else. No session, no machine. S2.1, S2.2
    if (sessionId === null) throw fail("no_repo");
    const where = await resolve(sessionId);
    if (!where) throw fail("no_repo");

    const declared = method.reasons ?? [];
    let repoCheck: Promise<RunResult> | undefined;
    const context: Context = {
      sessionId,
      limits: cli.limits,
      held,
      async syns(args, stdin) {
        const ran = await cli.run(where, args, stdin, deadline);
        // The 404 rule's `repo` runs at most once per call. S3.5
        return interpret(ran, declared, () => (repoCheck ??= cli.run(where, ["repo", "--json"], undefined, deadline)));
      },
    };

    let result: unknown;
    if ("procedure" in method) {
      result = await method.procedure(params, context);
    } else {
      const command = method.command(params, sessionId);
      const output = await context.syns(command.args, command.stdin);
      if (typeof output !== "object" || output === null || Array.isArray(output)) throw new SynsError("handler_error", { log: "exit=0 output is not a JSON object" });
      result = method.shape(output as Record<string, unknown>, params);
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
    const params = (call.params ?? {}) as Record<string, unknown>;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail("timeout")), cli.limits.callMs);
    });
    let outcome = "ok";
    try {
      const work = run(method, params, sessionId, Date.now() + cli.limits.callMs);
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
