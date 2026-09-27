import { randomUUID } from "node:crypto";
import type { RunRequest, RunResult, Runner } from "./cli.js";
import { SLICE } from "./relay.js";

/** The host half's three methods, as the server half calls them (contract.ts). */
export type HostCall = (method: "run" | "stdinPart" | "outputPart", input: Record<string, unknown>, options: { hostId: string; timeoutMs: number }) => Promise<any>;

/** How much longer than the process a host call may take before bb gives up on it. */
export const HOST_CALL_SLACK_MS = 5_000;

const failed = (error: unknown): RunResult => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: `host call failed: ${error instanceof Error ? error.message : String(error)}`, overflowed: false });

/**
 * The Runner in bb: one CLI run is one host call, but a standard input or an
 * answer larger than one host call carries (8 MiB, HOST_FACTS §12) crosses in
 * slices through the host half's relay (D32).
 */
export function createHostRunner(call: HostCall, synsPath: () => Promise<string | undefined>): Runner {
  return {
    async run({ hostId, cwd, args, stdin, stdinBase64, timeoutMs }: RunRequest): Promise<RunResult> {
      const path = await synsPath();
      const options = { hostId, timeoutMs: timeoutMs + HOST_CALL_SLACK_MS };
      try {
        const input: Record<string, unknown> = { cwd, args, timeoutMs, ...(path ? { synsPath: path } : {}) };
        if (stdin !== undefined) input.stdin = stdin;
        if (stdinBase64 !== undefined && stdinBase64.length <= SLICE) input.stdinBase64 = stdinBase64;
        if (stdinBase64 !== undefined && stdinBase64.length > SLICE) {
          // Slices of whole base64 groups, gathered on the host before the process starts.
          const id = randomUUID();
          for (let at = 0; at < stdinBase64.length; at += SLICE) await call("stdinPart", { id, base64: stdinBase64.slice(at, at + SLICE) }, options);
          input.stdinFrom = id;
        }
        const result = (await call("run", input, options)) as RunResult & { rest?: { id: string; length: number } };
        if (!result.rest) return result;
        const parts = [result.stdout];
        let offset = result.stdout.length;
        for (;;) {
          const part = (await call("outputPart", { id: result.rest.id, offset }, options)) as { chunk: string; done: boolean; lost: boolean };
          if (part.lost) return failed("the answer's remaining slices were no longer held");
          parts.push(part.chunk);
          offset += part.chunk.length;
          if (part.done) break;
        }
        const { rest: _rest, ...whole } = result;
        return { ...whole, stdout: parts.join("") };
      } catch (error) {
        // The machine could not be reached, or the host half failed. Not the CLI's doing: handler_error, logged. S3.6
        return failed(error);
      }
    },
  };
}
