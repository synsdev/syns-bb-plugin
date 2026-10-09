import synsPlugin from "../src/plugin.js";

/** As much of bb as the server half touches. */
export function fakeBb(settings: { synsPath?: string; agentInstructions?: boolean }, hostCall: (method: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>) {
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
    sdk: {
      threads: { get: async () => ({ thread: { environmentId: "env_1" } }) },
      environments: { get: async () => ({ hostId: "host_9", path: "/work/checkout" }) },
    },
  };
  synsPlugin(bb as never);
  return { handlers, described, lines };
}
