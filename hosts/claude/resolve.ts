import type { Resolve } from "../../src/resolve.js";

/** One request on the daemon's control socket. */
export type Control = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

/** How long a session's folder is held: a session does not change folders, and every call needs it (S2.3). */
export const RESOLVE_TTL_MS = 10_000;

/**
 * Session id → its folder, asked of the Unife Pages daemon (`GET /v1/sessions/{id}/workspace`). The call carries
 * the session id alone (07 R5.49); the daemon knows each session's folder. A session it does not know is null, so
 * no_repo (D29); any other failure throws, so handler_error, logged.
 */
export function createDaemonResolve(control: Control, now: () => number = Date.now): Resolve {
  const held = new Map<string, { cwd: string; at: number }>();
  return async (sessionId) => {
    const hit = held.get(sessionId);
    if (hit && now() - hit.at < RESOLVE_TTL_MS) return { hostId: "local", cwd: hit.cwd };
    const answer = await control("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`);
    if (answer.status === 404) return null;
    if (answer.status !== 200) throw new Error(`the daemon answered ${answer.status} for a session's folder`);
    const cwd = (JSON.parse(answer.text) as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || cwd === "") return null;
    held.set(sessionId, { cwd, at: now() });
    return { hostId: "local", cwd };
  };
}
