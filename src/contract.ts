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
        /** For a scoped call, the session's folder: cwd must resolve inside it (D43). */
        within: z.string().min(1).optional(),
        args: z.array(z.string()).max(64),
        stdin: z.string().optional(),
        /** Standard input as bytes, for `write --bytes` (D25). */
        stdinBase64: z.string().optional(),
        /** Standard input as bytes, gathered on the host by `stdinPart` under this id (D32). */
        stdinFrom: z.string().max(64).optional(),
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
        /** Set when stdout is only the first slice: the rest is read with `outputPart` (D32). */
        rest: z.object({ id: z.string().max(64), length: z.number().int() }).strict().optional(),
      })
      .strict(),
  },
  /** One slice of a large standard input, gathered on the host under id (D32). */
  stdinPart: {
    input: z.object({ id: z.string().min(1).max(64), base64: z.string() }).strict(),
    output: z.object({ received: z.number().int() }).strict(),
  },
  /** One slice of a large standard output, from offset; done on the last (D32). */
  outputPart: {
    input: z.object({ id: z.string().min(1).max(64), offset: z.number().int().min(0) }).strict(),
    output: z.object({ chunk: z.string(), done: z.boolean(), lost: z.boolean() }).strict(),
  },
});
