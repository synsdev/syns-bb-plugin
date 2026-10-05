import type { Cli, Where } from "./cli.js";

/**
 * The Syns CLI's version on a machine, for methods that need a newer one
 * (D41). `syns --version` prints `syns X.Y.Z`, not JSON, so it is read here
 * and nowhere else. Held per machine for a minute: it is the machine's tool,
 * not anything about a repository (S2.3).
 */
export const VERSION_TTL_MS = 60_000;

export type Triple = [number, number, number];

export const parseTriple = (text: string): Triple | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export const atLeast = (have: Triple, need: Triple): boolean => {
  for (let i = 0; i < 3; i += 1) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
};

export interface Versions {
  /** The CLI's version on that machine, or null when it printed none. A missing CLI is the run's own spawn error. */
  of(where: Where, deadline: number): Promise<{ text: string | null; triple: Triple | null; spawnError: string | null }>;
}

export function createVersions(cli: Cli, now: () => number = Date.now): Versions {
  const held = new Map<string, { at: number; text: string | null; triple: Triple | null }>();
  return {
    async of(where, deadline) {
      const cached = held.get(where.hostId);
      if (cached && now() - cached.at < VERSION_TTL_MS) return { text: cached.text, triple: cached.triple, spawnError: null };
      const ran = await cli.run(where, ["--version"], undefined, deadline);
      if (ran.spawnError !== null) return { text: null, triple: null, spawnError: ran.spawnError };
      const triple = ran.exitCode === 0 ? parseTriple(ran.stdout) : null;
      const text = triple ? triple.join(".") : null;
      held.set(where.hostId, { at: now(), text, triple });
      return { text, triple, spawnError: null };
    },
  };
}
