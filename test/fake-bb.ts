import type { Limits } from "../src/cli.js";
import synsPlugin from "../src/plugin.js";

/** As much of bb as the server half touches. */
export function fakeBb(settings: { synsPath?: string; agentInstructions?: boolean }, hostCall: (method: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>, limits?: Limits) {
  const handlers: Record<string, (input: unknown) => unknown> = {};
  const described: Record<string, unknown> = {};
  const lines: string[] = [];
  const bb = {
    pluginId: "syns",
    log: { debug: () => undefined, info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
    settings: {
      define(descriptors: Record<string, unknown>) {
        Object.assign(described, descriptors);
        return { get: async () => ({ agentInstructions: true, ...settings }), onChange: () => undefined, experimental_set: async () => ({}) };
      },
    },
    rpc: { register: (_contract: unknown, implementations: typeof handlers) => Object.assign(handlers, implementations) },
    hosts: { experimental_client: () => ({ call: hostCall }) },
  };
  synsPlugin(bb as never, limits);
  return { handlers, described, lines };
}
