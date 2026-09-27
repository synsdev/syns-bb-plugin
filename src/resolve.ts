import type { Where } from "./cli.js";

/** The two bb SDK reads resolution needs. `bb.sdk` satisfies it. */
export interface SdkLike {
  threads: { get(args: { threadId: string }): Promise<unknown> };
  environments: { get(args: { environmentId: string }): Promise<unknown> };
}

export type Resolve = (sessionId: string) => Promise<Where | null>;

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * Session id → the machine and the folder the CLI runs in (S2.1). Null when the
 * session has no environment, or the environment no host or no path (S2.2).
 * Both SDK reads are accepted wrapped or bare (HOST_FACTS §1). Nothing is
 * remembered, and no identity file is looked for: the CLI is asked (S2.4).
 */
export function createResolve(sdk: SdkLike): Resolve {
  return async (sessionId) => {
    let got: Record<string, unknown>;
    try {
      got = record(await sdk.threads.get({ threadId: sessionId }));
    } catch (error) {
      // A session that no longer exists has no folder: no_repo, not handler_error (D29). Anything else still fails.
      if (/\b404\b/.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
    const environmentId = text(record(got.thread ?? got).environmentId);
    if (!environmentId) return null;
    const found = record(await sdk.environments.get({ environmentId }));
    const environment = record(found.environment ?? found);
    const hostId = text(environment.hostId);
    const cwd = text(environment.path);
    return hostId && cwd ? { hostId, cwd } : null;
  };
}
