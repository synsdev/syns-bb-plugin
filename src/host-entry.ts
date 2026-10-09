import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { CLI_NOT_FOUND, SCOPE_OUTSIDE } from "./cli.js";
import { hostContract } from "./contract.js";
import { SLICE, createRelay } from "./relay.js";
import { scopeFolder } from "./scope.js";
import { findSyns, runSyns } from "./syns-process.js";

/**
 * bb's host half: runs on the session's machine, checks a scope there, and
 * starts the CLI through syns-process.ts. Answers past one host call go back
 * in slices (D32). S2.6–S2.8
 */
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
