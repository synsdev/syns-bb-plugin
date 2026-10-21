import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A stand-in `syns` executable for the tests that run real processes on both hosts (rows 31–34, 40): a Node script
 * that answers from a plan, the recordings included, and logs what it was given: its folder, arguments, standard
 * input and the environment a host sets. The plan is a file the test rewrites between calls.
 */
export interface Reply {
  /** The first argument, and every string here among the arguments. */
  verb: string;
  has?: string[];
  /** A recording of test/recordings, or the run's own output. */
  recording?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Answer only after this long: a run a limit stops. */
  sleepMs?: number;
}

export interface Logged {
  cwd: string;
  args: string[];
  stdin: string;
  env: Record<string, string | null>;
}

const RECORDINGS = fileURLToPath(new URL("./recordings/", import.meta.url));
const ENV_KEYS = ["SYNS_CALLER", "SYNS_INTEGRATION", "SYNS_RUN", "SYNS_TRIGGER", "NO_COLOR"];

export function fakeSyns(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "syns");
  const plan = join(dir, "plan.json");
  const log = join(dir, "runs.jsonl");
  const pids = join(dir, "pids.txt");
  writeFileSync(plan, "[]");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const env = {};
for (const key of ${JSON.stringify(ENV_KEYS)}) env[key] = process.env[key] ?? null;
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args, stdin, env }) + "\\n");
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
const reply = replies.find((r) => r.verb === args[0] && (r.has ?? []).every((one) => args.includes(one)));
if (!reply) { process.stderr.write("error: the fake syns has no reply for " + args.join(" ") + "\\n"); process.exit(2); }
let out = { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
if (reply.recording) {
  const r = JSON.parse(fs.readFileSync(${JSON.stringify(RECORDINGS)} + reply.recording + ".json", "utf8"));
  out = { exitCode: r.exitCode, stdout: r.stdout ?? JSON.stringify(r.json, null, 2), stderr: r.stderr ?? "" };
}
setTimeout(() => {
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}, reply.sleepMs ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    /** What the next runs answer. */
    answer(replies: Reply[]): void {
      writeFileSync(plan, JSON.stringify(replies));
    },
    runs(): Logged[] {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged) : [];
    },
    pids(): number[] {
      return existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
    },
    reset(): void {
      writeFileSync(log, "");
      writeFileSync(pids, "");
    },
  };
}

/** Whether a process is still there. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
