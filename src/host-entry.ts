import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { CLI_NOT_FOUND, SCOPE_OUTSIDE } from "./cli.js";
import { hostContract } from "./contract.js";
import { SLICE, createRelay } from "./relay.js";
import { scopeFolder, scopeInside } from "./scope.js";
import { findSyns, runSyns } from "./syns-process.js";

/**
 * bb's host half: runs on the session's machine, checks a scope there, and
 * starts the CLI through syns-process.ts. Answers past one host call go back
 * in slices (D32). S2.6–S2.8
 */
const relay = createRelay();

/** The name every request of the CLI's carries in its User-Agent on bb (S2.24, D83; bartsoj/syns D-238). */
export const CALLER = "bb-plugin";

/** How long the worker is held after the last run, so the next page call finds it warm (S2.25, D83). */
export const HOLD_MS = 15 * 60_000;

interface Lease {
  dispose(): Promise<void>;
}
interface LeaseContext {
  readonly lifecycle?: { readonly signal: AbortSignal };
  experimental_retainWorker?(): Lease;
}

/**
 * The worker lease (S2.25): any run that starts clears the timer, and takes a lease if none is held; when the last
 * active run ends the timer is set, and its expiry gives the lease back. A host without the lease, or one that
 * refuses it, still runs the CLI: no lease is no failure.
 */
let active = 0;
let lease: Lease | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let watched: AbortSignal | null = null;
const clearHold = (): void => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
};
const begin = (context: LeaseContext): void => {
  active += 1;
  clearHold();
  // The worker's own end clears the timer: nothing is left to hold.
  const lifecycle = context.lifecycle?.signal;
  if (lifecycle && lifecycle !== watched) {
    watched = lifecycle;
    lifecycle.addEventListener("abort", clearHold, { once: true });
  }
  if (lease !== null) return;
  try {
    lease = context.experimental_retainWorker?.() ?? null;
  } catch {
    lease = null;
  }
};
const end = (): void => {
  active -= 1;
  if (active > 0) return;
  clearHold();
  timer = setTimeout(() => {
    timer = null;
    const held = lease;
    lease = null;
    void held?.dispose().catch(() => undefined);
  }, HOLD_MS);
  (timer as { unref?: () => void }).unref?.();
};


export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    run: async (input, context) => {
      begin(context);
      try {
        return await run(input, context.signal);
      } finally {
        end();
      }
    },
    stdinPart: async ({ id, base64 }) => ({ received: relay.append(id, base64) }),
    outputPart: async ({ id, offset }) => {
      const slice = relay.slice(id, offset);
      return slice ? { ...slice, lost: false } : { chunk: "", done: true, lost: true };
    },
  },
});

type RunInput = { cwd: string; within?: string | undefined; scope?: string | undefined; args: string[]; env?: Record<string, string> | undefined; stdin?: string | undefined; stdinBase64?: string | undefined; stdinFrom?: string | undefined; timeoutMs: number; synsPath?: string | undefined };

/** One CLI run on this machine: the scope checked, the executable found, the process started. S2.6–S2.8 */
async function run({ cwd, within, scope, args, env, stdin, stdinBase64, stdinFrom, timeoutMs, synsPath }: RunInput, signal: AbortSignal) {
  // A scoped call starts where the scope resolved, so a link swapped in afterwards cannot move it (D46).
  let folder = cwd;
  if (within !== undefined) {
    const resolved = await scopeFolder(cwd, within);
    if (resolved === null) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: SCOPE_OUTSIDE, overflowed: false };
    folder = resolved;
  }
  // A call's scope parameter: its paths count from that folder, which must be inside this one (S2.31, D85).
  if (scope !== undefined && !(await scopeInside(folder, scope))) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: SCOPE_OUTSIDE, overflowed: false };
  const bin = await findSyns(synsPath);
  if (!bin) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: CLI_NOT_FOUND, overflowed: false };
  let input: string | Buffer | undefined = stdinBase64 === undefined ? stdin : Buffer.from(stdinBase64, "base64");
  if (stdinFrom !== undefined) {
    const gathered = relay.take(stdinFrom);
    if (gathered === undefined) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "the gathered standard input is no longer held", overflowed: false };
    input = Buffer.from(gathered, "base64");
  }
  // The host context's signal: bb aborts it when the server half gives the call up (S2.14).
  const result = await runSyns(bin, args, folder, input, timeoutMs, signal, CALLER, env);
  // An answer past one host call goes back in slices (D32).
  if (result.stdout.length <= SLICE) return result;
  const id = randomUUID();
  relay.hold(id, result.stdout);
  return { ...result, stdout: result.stdout.slice(0, SLICE), rest: { id, length: result.stdout.length } };
}
