import { readFileSync } from "node:fs";
import type { RunRequest, RunResult, Runner } from "../src/cli.js";

/** One recorded CLI run: `json` is standard output as a document, `stdout` as raw text. */
interface Recording {
  exitCode: number | null;
  json?: unknown;
  stdout?: string;
  stderr?: string;
}

const done = (exitCode: number | null, stdout: string, stderr = ""): RunResult => ({ exitCode, stdout, stderr, timedOut: false, spawnError: null, overflowed: false });

/** A recording from test/recordings, as the host half would return it. */
export function rec(name: string): RunResult {
  const recording = JSON.parse(readFileSync(new URL(`./recordings/${name}.json`, import.meta.url), "utf8")) as Recording;
  return done(recording.exitCode, recording.stdout ?? JSON.stringify(recording.json, null, 2), recording.stderr);
}

/** A successful run printing `json`; for variations on a recorded shape. */
export const ok = (json: unknown): RunResult => done(0, JSON.stringify(json));

export const timedOut = (): RunResult => ({ ...done(null, ""), timedOut: true });
export const spawnFailed = (spawnError: string): RunResult => ({ ...done(null, ""), spawnError });

type Reply = RunResult | ((request: RunRequest) => RunResult | Promise<RunResult>);

/**
 * A Runner that replays recordings and records what it was asked. `replies` is
 * keyed by the CLI verb (the first argument); a verb with no reply fails the test.
 */
export function fakeRunner(replies: Record<string, Reply> = {}): Runner & { calls: RunRequest[] } {
  const calls: RunRequest[] = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      const reply = replies[request.args[0] ?? ""];
      if (reply === undefined) throw new Error(`fake runner: no reply for ${request.args.join(" ")}`);
      return typeof reply === "function" ? reply(request) : reply;
    },
  };
}
