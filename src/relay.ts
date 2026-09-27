/**
 * The relay between the two halves (D32). bb carries at most 8 MiB of JSON in
 * one host call, either way (HOST_FACTS §12), and a picture's standard input or
 * the CLI's answer about it can be larger: up to 35 MiB for a 25 MiB file. So a
 * large standard input crosses in slices, gathered on the host before the
 * process starts, and a large standard output crosses back in slices after it
 * ends. Held in the host half's memory only, never a file, each for a minute
 * after it was last touched, at most 128 MiB in all.
 */

/** One slice of text crossing a host call: under the 8 MiB bound with room for the rest of the call. */
export const SLICE = 6 * 1024 * 1024;
export const RELAY_TOTAL = 128 * 1024 * 1024;
export const RELAY_IDLE_MS = 60_000;

interface Held {
  parts: string[];
  length: number;
  touched: number;
}

export interface Relay {
  /** Appends a slice to what is gathered under `id`; returns how many characters are held. */
  append(id: string, slice: string): number;
  /** What was gathered under `id`, and lets it go. Undefined when it is not held. */
  take(id: string): string | undefined;
  /** Holds a whole text under `id`, to be read back in slices. */
  hold(id: string, text: string): void;
  /** The slice of the held text from `offset`, and whether it is the last; undefined when it is not held. */
  slice(id: string, offset: number): { chunk: string; done: boolean } | undefined;
}

export function createRelay(now: () => number = Date.now, total = RELAY_TOTAL, idleMs = RELAY_IDLE_MS): Relay {
  const held = new Map<string, Held>();
  const sweep = (): void => {
    const cutoff = now() - idleMs;
    for (const [id, entry] of held) if (entry.touched < cutoff) held.delete(id);
  };
  const used = (): number => [...held.values()].reduce((sum, entry) => sum + entry.length, 0);
  const room = (more: number): void => {
    for (const [id] of held) {
      if (used() + more <= total) return;
      held.delete(id);
    }
  };

  return {
    append(id, slice) {
      sweep();
      let entry = held.get(id);
      if (!entry) {
        room(slice.length);
        held.set(id, (entry = { parts: [], length: 0, touched: now() }));
      }
      entry.parts.push(slice);
      entry.length += slice.length;
      entry.touched = now();
      return entry.length;
    },
    take(id) {
      sweep();
      const entry = held.get(id);
      if (!entry) return undefined;
      held.delete(id);
      return entry.parts.join("");
    },
    hold(id, text) {
      sweep();
      room(text.length);
      held.set(id, { parts: [text], length: text.length, touched: now() });
    },
    slice(id, offset) {
      sweep();
      const entry = held.get(id);
      if (!entry) return undefined;
      entry.touched = now();
      const text = entry.parts.length === 1 ? entry.parts[0]! : entry.parts.join("");
      const chunk = text.slice(offset, offset + SLICE);
      const done = offset + chunk.length >= text.length;
      if (done) held.delete(id);
      return { chunk, done };
    },
  };
}
