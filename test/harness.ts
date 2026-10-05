import { createCli, type Limits, type RunResult, type RunRequest, type Where } from "../src/cli.js";
import { createDispatch, type Answer } from "../src/dispatch.js";
import type { Method } from "../src/method.js";
import type { Held } from "../src/held.js";
import { fakeRunner } from "./fake-runner.js";

export const FAST: Limits = { processMs: 20, callMs: 60, perMachine: 16, perCall: 8 };
export const HEAD = "7ca9bc78ba047d9e7798b8d2733c254e24cfc837";
export const OLD = "43a6f2ca62274f4dd4e43146d232379058b32cd3";

type Reply = RunResult | ((request: RunRequest) => RunResult | Promise<RunResult>);

/** The server half above the Runner seam, with a fake runner, a fixed resolution and a captured log. */
export function harness(replies: Record<string, Reply> = {}, options: { table?: readonly Method[]; limits?: Limits; where?: Where | null; held?: Held } = {}) {
  // Methods that need a newer CLI ask its version first; a current one unless a test says otherwise.
  const runner = fakeRunner({ "--version": { exitCode: 0, stdout: "syns 0.3.11\n", stderr: "", timedOut: false, spawnError: null, overflowed: false }, ...replies });
  const log: string[] = [];
  const resolved: string[] = [];
  const invoke = createDispatch({
    ...(options.table ? { table: options.table } : {}),
    ...(options.held ? { held: options.held } : {}),
    cli: createCli(runner, options.limits ?? FAST),
    resolve: async (sessionId) => {
      resolved.push(sessionId);
      return options.where === undefined ? { hostId: "host_1", cwd: "/work/checkout" } : options.where;
    },
    log: { info: (line) => log.push(line), warn: (line) => log.push(line) },
  });
  const call = (method: string, params: unknown = {}, sessionId: string | null = "thr_page"): Promise<Answer> => invoke({ method, params, caller: { sessionId }, requestId: "req_1" });
  return { runner, log, resolved, call, invoke };
}

/** Parameters each registered method accepts, for the rows that say "every method". */
export const SAMPLES: Record<string, Record<string, unknown>> = {
  "syns.repo": {},
  "syns.whoami": {},
  "syns.ls": { path: "notes", recursive: true },
  "syns.readMany": { paths: ["README.md", "notes/a.md"] },
  "syns.history": { limit: 5 },
  "syns.commit": { base: HEAD, files: [{ path: "notes/a.md", text: "a" }] },
  "syns.read": { path: "notes/a.md", offset: 1, limit: 10 },
  "syns.glob": { pattern: "notes/*.md" },
  "syns.grep": { pattern: "Note", path: "notes" },
  "syns.diff": { from: OLD },
  "syns.write": { path: "notes/a.md", text: "a", base: HEAD },
  "syns.edit": { path: "notes/a.md", old: "a", new: "b", base: HEAD },
  "syns.rm": { path: "notes/a.md", base: HEAD },
  "syns.revert": { path: "notes/a.md", to: OLD },
  "syns.readBinary": { path: "images/a.png" },
  "syns.writeBinary": { path: "images/a.png", base64: "iVBORw0KGgo=", base: HEAD },
  "syns.place": { template: "acme/whiteboard-template", path: "clients/vela/q3-board" },
};

export const failureOf = (answer: Answer) => {
  if (answer.ok) throw new Error(`expected a failure, got ${JSON.stringify(answer.result).slice(0, 200)}`);
  return answer.error;
};

export const resultOf = <T = Record<string, unknown>>(answer: Answer): T => {
  if (!answer.ok) throw new Error(`expected a result, got ${JSON.stringify(answer.error)}`);
  return answer.result as T;
};
