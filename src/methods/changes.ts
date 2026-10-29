import { buildArgs } from "../cli.js";
import { SynsError } from "../errors.js";
import { BY, ENVELOPE, K64, M1, bytes, nullable, object, path, repoPath, version, type Context, type ProcedureMethod } from "../method.js";

interface Params {
  since: string;
  to?: string;
  path?: string;
  content?: boolean;
}

type Entry = { path: unknown; status: unknown; oldPath?: unknown; blob: unknown; size?: unknown; text?: string | null; by: unknown };

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const end = { type: "object", properties: { version, number: { type: "integer" } }, required: ["version", "number"] };

/** The host refuses a result over 10,000 JSON nodes, every value one, its envelope `{ v, id, ok, result }` four of them (D19). */
const NODES = 10_000 - 4;
const nodes = (value: unknown): number => (Array.isArray(value) ? value.reduce((sum: number, one) => sum + nodes(one), 1) : typeof value === "object" && value !== null ? Object.values(value).reduce((sum: number, one) => sum + (one === undefined ? 0 : nodes(one)), 1) : 1);

export const changes: ProcedureMethod = {
  name: "syns.changes",
  description: "What changed since a version, up to to (default the head): each path's status, who made its newest change (by), and with content: true its text (null if not text). deferred: texts that did not fit; read them at to.version.",
  effect: "read",
  params: object({ since: version, to: version, path, content: { type: "boolean" } }, ["since"]),
  result: {
    type: "object",
    properties: {
      from: end,
      to: end,
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: repoPath,
            status: { type: "string" },
            oldPath: repoPath,
            blob: nullable("string"),
            size: { type: "integer" },
            text: nullable("string"),
            by: {
              type: ["object", "null"],
              properties: { number: { type: "integer" }, author: nullable("string"), ...BY },
              required: ["number", "author", "integration", "run", "trigger"],
            },
          },
          required: ["path", "status", "blob", "by"],
        },
      },
      deferred: { type: "array", items: repoPath },
    },
    required: ["from", "to", "entries", "deferred"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  rootPath: true,

  async procedure(params: Params, context: Context) {
    // One run: the CLI compares with the head itself when there is no `to`, and names both ends (syns roadmap/224, D-254).
    const out = record(await context.syns(buildArgs("diff", { from: params.since, to: params.to, provenance: true, content: params.content === true, path: params.path })));
    const [from, to] = [record(out.from), record(out.to)].map((one) => ({ version: one.commit, number: one.version }));
    const setAside = new Set(Array.isArray(out.deferred) ? out.deferred : []);

    // Each entry as the method names it; a text kept apart until the room is known.
    const texts = new Map<Entry, string>();
    const withheld = new Set<Entry>();
    const entries: Entry[] | undefined = Array.isArray(out.entries)
      ? out.entries.map(record).map((one) => {
          const provenance = one.provenance === null ? null : record(one.provenance);
          const entry: Entry = {
            path: one.path,
            status: one.status,
            ...(one.status === "renamed" && typeof one.oldPath === "string" ? { oldPath: one.oldPath } : {}),
            blob: typeof one.newSha === "string" ? one.newSha : null,
            ...(typeof one.size === "number" ? { size: one.size } : {}),
            by: provenance && { number: provenance.version, author: provenance.publisher ?? null, integration: provenance.integration ?? null, run: provenance.run ?? null, trigger: provenance.trigger ?? null },
          };
          // A deleted path has no text; one the CLI set aside (past its 8 MiB) has none here; a file that is not text is null.
          if (params.content !== true || one.status === "deleted") return entry;
          if (setAside.has(one.path)) withheld.add(entry);
          else if (typeof one.text === "string") texts.set(entry, one.text);
          else entry.text = null;
          return entry;
        })
      : undefined;
    if (!entries) return { from, to, entries, deferred: [] };

    // Every path is listed. Texts fill the room left, whole, in the CLI's order; from the first that does not fit, none
    // is served, and each is deferred, as syns.readMany defers (S1.15, D83). Counted as JSON escapes a text.
    const room = changes.maxResponseBytes - ENVELOPE;
    const listed = (served: number) => {
      const kept = [...texts.keys()];
      for (const [index, entry] of kept.entries()) if (index < served) entry.text = texts.get(entry)!;
      const late = new Set(kept.slice(served));
      return { from, to, entries, deferred: entries.filter((entry) => withheld.has(entry) || late.has(entry)).map((entry) => entry.path) };
    };
    // Every path as the answer will name it: a reaching call's paths may grow by their `../` (S1.25).
    const bare = listed(0);
    const paths = entries.length + entries.filter((entry) => entry.oldPath !== undefined).length + bare.deferred.length;
    let used = bytes(bare) + paths * (context.pathGrowth ?? 0);
    if (used > room || nodes(bare) > NODES) throw new SynsError("response_too_large");
    let served = 0;
    for (const text of texts.values()) {
      // In: `,"text":` and the text as JSON escapes it. The path leaving deferred is not counted back: an upper bound.
      const cost = bytes({ text }) - 1;
      if (used + cost > room) break;
      used += cost;
      served += 1;
    }
    return listed(served);
  },

  // A move across the scope's edge reads as the CLI's mask reads it (roadmap/228): the old side outside, an addition;
  // the new side outside, a deletion at the old path, with no blob, size or text. S1.26, D87
  scoped(result: { entries?: Entry[] }, inside: (path: unknown) => boolean) {
    if (!Array.isArray(result.entries)) return result;
    const entries = result.entries.map((entry) => {
      if (typeof entry.oldPath !== "string" || inside(entry.path) === inside(entry.oldPath)) return entry;
      const { oldPath, ...rest } = entry;
      return inside(entry.path) ? { ...rest, status: "added" } : { path: oldPath, status: "deleted", blob: null, by: entry.by };
    });
    return { ...result, entries };
  },
};
