/**
 * What the server half holds between calls (D24–D27): a picture being gathered
 * piece by piece, and a picture's bytes being handed out piece by piece. Memory
 * only, never a file. Each entry is dropped a minute after it was last touched;
 * all of them together hold at most 64 MiB, the oldest dropped first to make
 * room; a session gathers at most two pictures at once.
 */

export const HELD_TOTAL = 64 * 1024 * 1024;
export const HELD_IDLE_MS = 60_000;
export const GATHERING_PER_SESSION = 2;

/** One picture being gathered for a write. */
export interface Upload {
  kind: "upload";
  session: string;
  path: string;
  base: string;
  size: number;
  sha256: string;
  chunks: Buffer[];
  received: number;
  /** Gathered whole and kept for a `syns.commit` that names it (D26). */
  complete: boolean;
}

/** One picture read whole, handed out in pieces. */
export interface Read {
  kind: "read";
  bytes: Buffer;
  version: string;
  number: unknown;
  path: string;
  blob: unknown;
  mediaType: string | null;
  sha256: string;
}

type Entry = (Upload | Read) & { touched: number; reserved: number };

export interface Held {
  get<T extends Upload | Read>(key: string): T | undefined;
  /** Holds `value`, reserving `reserved` bytes of the total for it. */
  put(key: string, value: Upload | Read, reserved: number): void;
  drop(key: string): void;
  /** Keys of the uploads a session is gathering, oldest first. */
  gathering(session: string): string[];
  /** Bytes held or reserved, for tests and the log. */
  used(): number;
}

export function createHeld(now: () => number = Date.now, total = HELD_TOTAL, idleMs = HELD_IDLE_MS): Held {
  const entries = new Map<string, Entry>();

  const sweep = (): void => {
    const cutoff = now() - idleMs;
    for (const [key, entry] of entries) if (entry.touched < cutoff) entries.delete(key);
  };
  const used = (): number => [...entries.values()].reduce((sum, entry) => sum + entry.reserved, 0);

  return {
    get<T extends Upload | Read>(key: string): T | undefined {
      sweep();
      const entry = entries.get(key);
      if (!entry) return undefined;
      entry.touched = now();
      // A Map keeps insertion order; moving a touched entry to the end keeps "oldest first" true.
      entries.delete(key);
      entries.set(key, entry);
      return entry as unknown as T;
    },
    put(key, value, reserved) {
      sweep();
      entries.delete(key);
      // Room is made by dropping the least recently touched. One entry never exceeds the total (25 MiB < 64 MiB).
      for (const [other] of entries) {
        if (used() + reserved <= total) break;
        entries.delete(other);
      }
      entries.set(key, Object.assign(value, { touched: now(), reserved }) as Entry);
    },
    drop(key) {
      entries.delete(key);
    },
    gathering(session) {
      sweep();
      return [...entries.entries()].filter(([, entry]) => entry.kind === "upload" && entry.session === session && !entry.complete).map(([key]) => key);
    },
    used,
  };
}
