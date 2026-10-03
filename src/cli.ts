/**
 * The seam. Everything above this file talks to a `Runner`; in bb the Runner is
 * the call to the host half, in tests it is test/fake-runner.ts.
 * spec 02 §Argument safety, §Limits
 */

export interface RunRequest {
  hostId: string;
  cwd: string;
  /** For a scoped call, the session's folder: the host half refuses a cwd that resolves outside it, symlinks followed (D43). */
  within?: string;
  args: string[];
  /** Provenance for a command that takes it only from the environment (`syns place`), D44. Exactly these three keys. */
  env?: ProvenanceEnv;
  stdin?: string;
  /** Standard input as bytes, base64 across the host call, for `write --bytes` (D25). Never beside `stdin`. */
  stdinBase64?: string;
  /** The host half stops the process after this long. S2.14 */
  timeoutMs: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** CLI_NOT_FOUND when there is no executable; any other text when the process could not be started. S3.6 */
  spawnError: string | null;
  /** The process printed more than the host half collects, and was stopped. S2.16 */
  overflowed: boolean;
}

export interface Runner {
  run(request: RunRequest): Promise<RunResult>;
}

export const CLI_NOT_FOUND = "cli_not_found";

/** What the CLI reads as a version's provenance when a command has no flags for it (D44). */
export interface ProvenanceEnv {
  SYNS_INTEGRATION: string;
  SYNS_RUN: string;
  SYNS_TRIGGER: string;
}
/** The host half's answer when a scoped cwd is not a Syns folder inside the session's folder, once symlinks are followed (D43, D46). */
export const SCOPE_OUTSIDE = "scope_outside";

export interface Where {
  hostId: string;
  cwd: string;
  /** Set when cwd is a scope below the session's folder (D43). */
  within?: string;
}

export interface Limits {
  /** One CLI process. S2.14 */
  processMs: number;
  /** One call from a page, whatever it runs. S2.14 */
  callMs: number;
  /** CLI processes at once on one machine, across every page. S2.15 */
  perMachine: number;
  /** CLI processes at once for one call. S1.14 */
  perCall: number;
}

export const LIMITS: Limits = { processMs: 20_000, callMs: 25_000, perMachine: 16, perCall: 8 };

export type OptionValue = string | number | boolean | readonly string[] | undefined;

/**
 * The argument array of one CLI run: every option as `--option=value`, always
 * `--json`, every positional after `--`. A value a page supplied can therefore
 * never be read as a flag. A list repeats its option once for each value.
 * S2.11, S2.13
 */
export function buildArgs(verb: string | readonly string[], options: Record<string, OptionValue> = {}, positionals: string[] = []): string[] {
  const args = typeof verb === "string" ? [verb] : [...verb];
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "object") args.push(...value.map((one) => `--${name}=${one}`));
    else args.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  args.push("--json");
  if (positionals.length > 0) args.push("--", ...positionals);
  return args;
}

export interface Cli {
  readonly limits: Limits;
  /** One CLI process, inside the limits. `deadline` is when the page's call must have answered. */
  run(where: Where, args: string[], stdin: string | Buffer | undefined, deadline: number, env?: ProvenanceEnv): Promise<RunResult>;
}

const TIMED_OUT: RunResult = { exitCode: null, stdout: "", stderr: "", timedOut: true, spawnError: null, overflowed: false };

export function createCli(runner: Runner, limits: Limits = LIMITS): Cli {
  const machines = new Map<string, { running: number; waiting: (() => void)[] }>();

  return {
    limits,
    async run(where, args, stdin, deadline, env) {
      let machine = machines.get(where.hostId);
      if (!machine) machines.set(where.hostId, (machine = { running: 0, waiting: [] }));
      const slots = machine;
      if (slots.running >= limits.perMachine) await new Promise<void>((resolve) => slots.waiting.push(resolve));
      else slots.running += 1;
      // From here this call holds one slot; a finished call hands its slot to the next in line.
      try {
        const left = deadline - Date.now();
        if (left <= 0) return TIMED_OUT;
        const input = stdin === undefined ? {} : typeof stdin === "string" ? { stdin } : { stdinBase64: stdin.toString("base64") };
        return await runner.run({ hostId: where.hostId, cwd: where.cwd, ...(where.within ? { within: where.within } : {}), args, ...(env ? { env } : {}), ...input, timeoutMs: Math.min(limits.processMs, left) });
      } finally {
        const next = slots.waiting.shift();
        if (next) next();
        else slots.running -= 1;
      }
    },
  };
}

/** `fn` over `items`, at most `size` at once, results in the order of `items`. */
export async function pool<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}
