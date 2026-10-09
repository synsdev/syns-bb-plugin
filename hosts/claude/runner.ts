import { CLI_NOT_FOUND, SCOPE_OUTSIDE, type RunRequest, type RunResult, type Runner } from "../../src/cli.js";
import { scopeFolder } from "../../src/scope.js";
import { findSyns, runSyns } from "../../src/syns-process.js";

const refused = (spawnError: string): RunResult => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError, overflowed: false });

/**
 * The Runner on Claude Code: the session's folder is on this machine, so the CLI runs here, in-process, with what
 * bb's host half calls on its machine (scopeFolder, findSyns, runSyns). No host call, so no 8 MiB bound and no
 * slices. `hostId` is ignored: there is one machine.
 */
export function createLocalRunner(synsPath: string | undefined): Runner {
  return {
    async run({ cwd, within, args, env, stdin, stdinBase64, timeoutMs }: RunRequest): Promise<RunResult> {
      // A scoped call starts where the scope resolved, so a link swapped in afterwards cannot move it (D46).
      let folder = cwd;
      if (within !== undefined) {
        const resolved = await scopeFolder(cwd, within);
        if (resolved === null) return refused(SCOPE_OUTSIDE);
        folder = resolved;
      }
      const bin = await findSyns(synsPath);
      if (!bin) return refused(CLI_NOT_FOUND);
      const input = stdinBase64 === undefined ? stdin : Buffer.from(stdinBase64, "base64");
      return runSyns(bin, args, folder, input, timeoutMs, new AbortController().signal, env as Record<string, string> | undefined);
    },
  };
}
