import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { CLI_NOT_FOUND, SCOPE_OUTSIDE, type RunResult } from "./cli.js";
import { hostContract } from "./contract.js";
import { SLICE, createRelay } from "./relay.js";
import { scopeFolder } from "./scope.js";
import { randomUUID } from "node:crypto";

/**
 * The host half: finds the Syns CLI on this machine and runs it with the
 * arguments it is given. It opens no repository file; its only file-system
 * access is looking for the `syns` executable. S2.6–S2.8, S2.10, S2.16
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

const relay = createRelay();


export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    run: async ({ cwd, within, args, env, stdin, stdinBase64, stdinFrom, timeoutMs, synsPath }, context) => {
      // A scoped call starts where the scope resolved, so a link swapped in afterwards cannot move it (D46).
      let folder = cwd;
      if (within !== undefined) {
        const resolved = await scopeFolder(cwd, within);
        if (resolved === null) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: SCOPE_OUTSIDE, overflowed: false };
        folder = resolved;
      }
      const bin = await findSyns(synsPath);
      if (!bin) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: CLI_NOT_FOUND, overflowed: false };
      let input: string | Buffer | undefined = stdinBase64 === undefined ? stdin : Buffer.from(stdinBase64, "base64");
      if (stdinFrom !== undefined) {
        const gathered = relay.take(stdinFrom);
        if (gathered === undefined) return { exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "the gathered standard input is no longer held", overflowed: false };
        input = Buffer.from(gathered, "base64");
      }
      const result = await runSyns(bin, args, folder, input, timeoutMs, context.signal, env);
      // An answer past one host call goes back in slices (D32).
      if (result.stdout.length <= SLICE) return result;
      const id = randomUUID();
      relay.hold(id, result.stdout);
      return { ...result, stdout: result.stdout.slice(0, SLICE), rest: { id, length: result.stdout.length } };
    },
    stdinPart: async ({ id, base64 }) => ({ received: relay.append(id, base64) }),
    outputPart: async ({ id, offset }) => {
      const slice = relay.slice(id, offset);
      return slice ? { ...slice, lost: false } : { chunk: "", done: true, lost: true };
    },
  },
});
