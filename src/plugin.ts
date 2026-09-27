import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCli } from "./cli.js";
import { createHostRunner } from "./host-runner.js";
import { hostContract } from "./contract.js";
import { buildDeclaration } from "./declaration.js";
import { createDispatch, type Call } from "./dispatch.js";
import { METHODS } from "./methods/index.js";
import { createResolve } from "./resolve.js";

/** Thread Pages has validated a call before it arrives; the dispatch checks it again against the table. */
const anything = { "~standard": { version: 1 as const, vendor: "syns", validate: (value: unknown) => ({ value }) } };

/**
 * The server half (S2.5): answers the host's two RPC methods. It runs no
 * process and opens no file; the Runner it hands the rest is the call to the
 * host half on the session's machine.
 */
export default function synsPlugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    synsPath: { type: "string", label: "Syns executable", description: "Absolute path of the syns executable, when it is not on PATH or in ~/.cargo/bin, ~/.local/bin, /usr/local/bin or /opt/homebrew/bin." },
    agentInstructions: { type: "boolean", label: "Tell agents about syns.*", description: "Whether the plugin declares its instruction fragment to Thread Pages. The methods and the guide stay either way.", default: true },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  const runner = createHostRunner(
    (method, input, options) => host.call(method, input as never, options),
    async () => (await settings.get()).synsPath?.trim() || undefined,
  );

  const invoke = createDispatch({ cli: createCli(runner), resolve: createResolve(bb.sdk), log: bb.log });

  bb.rpc.register(
    { threadPagesContributions: { input: anything, output: anything }, threadPagesInvoke: { input: anything, output: anything } },
    {
      threadPagesContributions: async () => buildDeclaration(METHODS, { agentInstructions: (await settings.get()).agentInstructions !== false }),
      threadPagesInvoke: (input: unknown) => invoke(input as Call),
    },
  );
}
