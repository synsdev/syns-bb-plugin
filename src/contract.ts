import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The server half ↔ host half contract. Internal to the plugin; no page reaches
 * it. The host half is a general runner (D16): a folder, an argument list,
 * optional standard input and a time limit in; what the process did out.
 * Which commands exist is decided by the server half's method table alone. S2.6, S2.7
 */
export const hostContract = defineRpcContract({
  run: {
    input: z
      .object({
        cwd: z.string().min(1),
        args: z.array(z.string()).max(64),
        stdin: z.string().optional(),
        timeoutMs: z.number().int().min(1).max(60_000),
        /** The `synsPath` setting, when it is set. S2.8 */
        synsPath: z.string().optional(),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        spawnError: z.string().nullable(),
        overflowed: z.boolean(),
      })
      .strict(),
  },
});
