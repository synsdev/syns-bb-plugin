import { CLI_NOT_FOUND, SCOPE_OUTSIDE, type RunRequest, type RunResult, type Runner } from "../../src/cli.js";
import { scopeFolder, scopeInside } from "../../src/scope.js";
import { findSyns, runSyns } from "../../src/syns-process.js";

/** The name every request of the CLI's carries in its User-Agent on Claude Code (S2.24, D83; bartsoj/syns D-238). */
export const CALLER = "claude-pages";

const refused = (spawnError: string): RunResult => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError, overflowed: false });

/**
 * The Runner on Claude Code: the session's folder is on this machine, so the CLI runs here, in-process, with what
 * bb's host half calls on its machine (scopeFolder, scopeInside, findSyns, runSyns). No host call, so no 8 MiB bound and no
 * slices. `hostId` is ignored: there is one machine.
 */
export function createLocalRunner(synsPath: string | undefined): Runner {
  return {
    async run({ cwd, within, scope, args, env, stdin, stdinBase64, timeoutMs, signal }: RunRequest): Promise<RunResult> {
      // A scoped call starts where the scope resolved, so a link swapped in afterwards cannot move it (D46).
      let folder = cwd;
      if (within !== undefined) {
        const resolved = await scopeFolder(cwd, within);
        if (resolved === null) return refused(SCOPE_OUTSIDE);
        folder = resolved;
      }
      // A call's scope parameter: its paths count from that folder, which must be inside this one (S2.31, D85).
      if (scope !== undefined && !(await scopeInside(folder, scope))) return refused(SCOPE_OUTSIDE);
      const bin = await findSyns(synsPath);
      if (!bin) return refused(CLI_NOT_FOUND);
      const input = stdinBase64 === undefined ? stdin : Buffer.from(stdinBase64, "base64");
      // The call's signal: the 25 s limit, or the call's end, stops the process (S2.14). No lease: this process lives on.
      return runSyns(bin, args, folder, input, timeoutMs, signal ?? new AbortController().signal, CALLER, env as Record<string, string> | undefined);
    },
  };
}
