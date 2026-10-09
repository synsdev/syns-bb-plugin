import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { RunResult } from "./cli.js";

/**
 * Finding the Syns CLI on a machine and running it with the arguments it is
 * given: what bb's host half (host-entry.ts) and any other host's runner call
 * on the machine where the session's folder is. It opens no repository file;
 * its only file-system access is looking for the `syns` executable.
 * S2.6–S2.8, S2.10, S2.16
 */

/** What is collected of a process's standard output before it is stopped: a 25 MiB picture as base64 in JSON fits (S2.16, D27). */
export const MAX_OUTPUT = 40 * 1024 * 1024;

const executable = async (file: string): Promise<boolean> =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );

/** The named executable if a setting names one; else PATH, then the usual folders under home. S2.8 */
export async function findSyns(synsPath: string | undefined, env: { PATH?: string | undefined } = process.env, home: string = homedir()): Promise<string | null> {
  if (synsPath) return (await executable(synsPath)) ? synsPath : null;
  const folders = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".cargo", "bin"), join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  for (const folder of folders) {
    const candidate = join(folder, process.platform === "win32" ? "syns.exe" : "syns");
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** One process, started directly with an argument array, never through a shell. S2.10 */
export function runSyns(bin: string, args: string[], cwd: string, stdin: string | Buffer | undefined, timeoutMs: number, signal: AbortSignal, provenance?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, spawnError, overflowed });
    };
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", ...(provenance ?? {}) }, signal });
    // Stopping answers at once: a process of its own that still holds the pipes must not hold the call.
    const stop = (): void => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null, null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      if (outBytes + chunk.length > MAX_OUTPUT) {
        overflowed = true;
        stop();
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes + chunk.length > MAX_OUTPUT) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code) => finish(code, null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });
}
