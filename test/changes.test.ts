import { describe, expect, it } from "vitest";
import { ENVELOPE, M1, bytes } from "../src/method.js";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/** syns.changes (Syns B-0060, syns roadmap/224, D-254): one `syns diff --from … --provenance [--content]` run, mapped. */
const V2 = "a19555a14ba6ccb3cb5e2cd11f23ac04be062b80";
const V4 = "25ac0dbdca0dc6ec345001e858af7fc90555c4db";
const V9 = "47cd481f0ea66680f23e688c6483fa490d239ac0";
const AGENT = { author: "bartsoj", integration: "bb", run: "thr_rec_agent", trigger: "agent" };
const CLAUDE = { author: "bartsoj", integration: "claude-code", run: "a3e4b73e-30df-4290-8e36-fbdff8ee5fc0", trigger: "agent" };
const PAGE = { author: "bartsoj", integration: "syns-pages", run: "thr_rec_page", trigger: "page" };

type Entry = { path: string; status: string; oldPath?: string; blob: string | null; size?: number; text?: string | null; by: Record<string, unknown> | null };
type Changes = { from: { version: string; number: number }; to: { version: string; number: number }; entries: Entry[]; deferred: string[] };
const args = (h: ReturnType<typeof harness>) => h.runner.calls.map((call) => call.args.join(" "));

/** A CLI answer of `count` modified text files, each `size` characters of `x`. */
const many = (count: number, size: number, from = OLD, to = HEAD) => ({
  from: { commit: from, version: 4 },
  to: { commit: to, version: 6 },
  entries: Array.from({ length: count }, (_, index) => ({
    path: `f${String(index).padStart(4, "0")}.md`,
    status: "modified",
    oldSha: "1".repeat(40),
    newSha: "2".repeat(40),
    size,
    provenance: { version: 6, publisher: "bartsoj", integration: "bb", run: "thr_1", trigger: "agent", recorded: true },
    text: "x".repeat(size),
  })),
  deferred: [],
});

describe("syns.changes", () => {
  it("is one CLI run: diff --from with --provenance and --content, to the head the CLI names", async () => {
    const h = harness({ diff: rec("changes.all.0325") });
    const result = resultOf<Changes>(await h.call("syns.changes", { since: V2, content: true }));
    expect(args(h)).toEqual([`diff --from=${V2} --provenance --content --json`]);
    expect(result.from).toEqual({ version: V2, number: 2 });
    expect(result.to).toEqual({ version: V9, number: 9 });
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.md", "app/del.md", "app/in.md", "out.md", "app/r2.md", "app/x.md", "big.txt", "logo.png", "notes/q.md"]);
  });

  it("maps each entry: status, oldPath only on a rename, the new blob, size, text, and by from the newest version that changed it", async () => {
    const h = harness({ diff: rec("changes.all.0325") });
    const entries = resultOf<Changes>(await h.call("syns.changes", { since: V2, content: true })).entries;
    const at = (path: string) => entries.find((entry) => entry.path === path);
    expect(at("a.md")).toEqual({ path: "a.md", status: "modified", blob: "c074bd56ef55bc2680702e386ffca7d23ff9baa8", size: 29, text: "# A\n\nedited again by the CLI\n", by: { number: 9, ...CLAUDE } });
    expect(at("app/x.md")).toEqual({ path: "app/x.md", status: "modified", blob: "d735d349cd07d14df2401dd401efccb2818872ab", size: 3, text: "x2\n", by: { number: 3, ...PAGE } });
    expect(at("app/r2.md")).toMatchObject({ status: "renamed", oldPath: "app/r.md", size: 200, text: "rename me\n".repeat(20), by: { number: 5, ...AGENT } });
    expect(at("notes/q.md")!.text).toBe('say "hi"\n\ttab — ünïcode\n');
    // A deleted path has no blob, size or text; it still says who deleted it.
    expect(at("app/del.md")).toEqual({ path: "app/del.md", status: "deleted", blob: null, by: { number: 4, ...CLAUDE } });
    // Not text: text null, with its size and blob.
    expect(at("logo.png")).toEqual({ path: "logo.png", status: "added", blob: "2d36779307198d52711e378a1f3df81bb0d9d029", size: 268, text: null, by: { number: 4, ...CLAUDE } });
    for (const entry of entries) if (entry.status !== "renamed") expect(entry, entry.path).not.toHaveProperty("oldPath");
  });

  it("a text the CLI sets aside (past its 8 MiB) keeps its entry with no text, and is listed in deferred", async () => {
    const result = resultOf<Changes>(await harness({ diff: rec("changes.all.0325") }).call("syns.changes", { since: V2, content: true }));
    expect(result.entries.find((entry) => entry.path === "big.txt")).toEqual({ path: "big.txt", status: "added", blob: "427b0f31259474e910cc99209700131d7d5f29fd", size: 9020000, by: { number: 8, ...AGENT } });
    expect(result.deferred).toEqual(["big.txt"]);
  });

  it("without content: no --content, no text on any entry, deferred empty", async () => {
    const h = harness({ diff: rec("changes.no-content.0325") });
    const result = resultOf<Changes>(await h.call("syns.changes", { since: V2 }));
    expect(args(h)).toEqual([`diff --from=${V2} --provenance --json`]);
    expect(result.entries).toHaveLength(9);
    for (const entry of result.entries) expect(entry, entry.path).not.toHaveProperty("text");
    expect(result.deferred).toEqual([]);
    expect(result.entries.find((entry) => entry.path === "app/in.md")).toEqual({ path: "app/in.md", status: "renamed", oldPath: "in.md", blob: "699ae8830cb31b30566b576c54db915c8d02d0fb", size: 10, by: { number: 7, ...AGENT } });
  });

  it("passes to as an option, never read as a flag", async () => {
    const h = harness({ diff: rec("changes.to.0325") });
    const result = resultOf<Changes>(await h.call("syns.changes", { since: V2, to: V4, content: false }));
    expect(args(h)).toEqual([`diff --from=${V2} --to=${V4} --provenance --json`]);
    expect(result.to).toEqual({ version: V4, number: 4 });
  });

  it("passes path as --path; with no scope the paths stay the repository's", async () => {
    const h = harness({ diff: rec("changes.app.0325") });
    const result = resultOf<Changes>(await h.call("syns.changes", { since: V2, path: "app", content: true }));
    expect(args(h)).toEqual([`diff --from=${V2} --provenance --content --path=app --json`]);
    expect(result.entries.map((entry) => entry.path)).toEqual(["app/del.md", "app/in.md", "app/out.md", "app/r2.md", "app/x.md"]);
  });

  it("since the head: no entries", async () => {
    expect(resultOf<Changes>(await harness({ diff: rec("changes.same.0325") }).call("syns.changes", { since: V9, content: true }))).toEqual({ from: { version: V9, number: 9 }, to: { version: V9, number: 9 }, entries: [], deferred: [] });
  });

  it("by is null for a path none of the versions the CLI read names", async () => {
    const answer = many(1, 3);
    (answer.entries[0] as Record<string, unknown>).provenance = null;
    expect(resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD })).entries[0]!.by).toBeNull();
  });

  describe("inside the 1 MiB answer, texts counted as JSON escapes them (D83)", () => {
    const room = M1 - ENVELOPE;
    it("every entry is listed; texts fill the room whole, in the CLI's order; the rest carry none and are deferred", async () => {
      // 12 texts of 100,000 characters: about ten fit.
      const result = resultOf<Changes>(await harness({ diff: ok(many(12, 100_000)) }).call("syns.changes", { since: OLD, content: true }));
      expect(result.entries).toHaveLength(12);
      const served = result.entries.filter((entry) => typeof entry.text === "string");
      expect(served.length).toBeGreaterThan(0);
      expect(served.length).toBeLessThan(12);
      expect(result.entries.slice(0, served.length).every((entry) => typeof entry.text === "string")).toBe(true);
      for (const entry of result.entries.slice(served.length)) expect(entry, entry.path).not.toHaveProperty("text");
      expect(result.deferred).toEqual(result.entries.slice(served.length).map((entry) => entry.path));
      expect(bytes(result)).toBeLessThanOrEqual(room);
      // One more text would not have fitted.
      expect(bytes(result) + 100_000).toBeGreaterThan(room);
    });
    it("counts a text as JSON escapes it: quotes and newlines take two bytes each", async () => {
      const answer = many(3, 0);
      for (const entry of answer.entries) entry.text = '"\n'.repeat(200_000);
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true }));
      expect(result.entries.filter((entry) => typeof entry.text === "string")).toHaveLength(1);
      expect(result.deferred).toEqual(["f0001.md", "f0002.md"]);
      expect(bytes(result)).toBeLessThanOrEqual(room);
    });
    it("a first text past the room alone is deferred, and so is every text after it", async () => {
      const answer = many(2, 10);
      answer.entries[0]!.text = "x".repeat(M1);
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true }));
      expect(result.entries.map((entry) => "text" in entry)).toEqual([false, false]);
      expect(result.deferred).toEqual(["f0000.md", "f0001.md"]);
    });
    it("the room left after a text the CLI set aside still serves the texts after it", async () => {
      const answer = many(2, 10);
      (answer.entries[0] as Record<string, unknown>).text = null;
      answer.deferred = ["f0000.md"] as never;
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true }));
      expect(result.entries[1]!.text).toBe("x".repeat(10));
      expect(result.deferred).toEqual(["f0000.md"]);
    });
    it("at the boundary: a text that brings the answer to the room exactly is served; one byte more and it is deferred", async () => {
      const answer = many(1, 0);
      answer.entries[0]!.text = "x".repeat(M1);
      const bare = bytes(resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true })));
      // `,"text":"…"` is ten bytes and the text; the path leaving deferred is not counted back.
      const fits = room - bare - 10;
      answer.entries[0]!.text = "x".repeat(fits);
      const served = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true }));
      expect(served.deferred).toEqual([]);
      expect(served.entries[0]!.text).toHaveLength(fits);
      expect(bytes(served)).toBeLessThanOrEqual(room);
      answer.entries[0]!.text = "x".repeat(fits + 1);
      expect(resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true })).deferred).toEqual(["f0000.md"]);
    });
    it("at the boundary: a list of paths of exactly the room is answered; one byte more is response_too_large", async () => {
      const answer = many(700, 0);
      const short = bytes(resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD })));
      answer.entries[699]!.path = `${"p".repeat(room - short)}${answer.entries[699]!.path}`;
      const full = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD }));
      expect(bytes(full)).toBe(room);
      answer.entries[699]!.path = `p${answer.entries[699]!.path}`;
      expect(failureOf(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD })).code).toBe("response_too_large");
    });
    it("at the boundary: 9,996 nodes are answered (the host's envelope takes four of its 10,000); 9,997 are response_too_large", async () => {
      // The result's object, from, to (three each), entries and deferred: 10 nodes; an entry with by and text: 12.
      const answer = many(832, 1);
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD }));
      const nodes = (value: unknown): number => (Array.isArray(value) ? value.reduce((sum: number, one) => sum + nodes(one), 1) : typeof value === "object" && value !== null ? Object.values(value).reduce((sum: number, one) => sum + nodes(one), 1) : 1);
      const fill = 9996 - nodes(result);
      answer.entries.push(...Array.from({ length: fill }, (_, index) => ({ ...answer.entries[0]!, path: `n${index}`, status: "deleted", newSha: undefined, size: undefined, provenance: null }) as never));
      // A deleted entry with no blob's value, size or by: path, status, blob, by and its object, five nodes; a remainder pads the last.
      const padded = { ...answer, entries: answer.entries.slice(0, 832 + Math.floor(fill / 5)) };
      const exact = resultOf<Changes>(await harness({ diff: ok(padded) }).call("syns.changes", { since: OLD }));
      const short = 9996 - nodes(exact);
      expect(short).toBeGreaterThanOrEqual(0);
      expect(short).toBeLessThan(5);
      // Make up the remainder with renames (oldPath: one more node each).
      for (let index = 0; index < short; index += 1) Object.assign(padded.entries[832 + index]!, { status: "renamed", oldPath: `o${index}` });
      expect(nodes(resultOf(await harness({ diff: ok(padded) }).call("syns.changes", { since: OLD })))).toBe(9996);
      // One node more: a deletion read as a rename.
      const over = { ...padded, entries: padded.entries.map((entry, index) => (index === padded.entries.length - 1 ? { ...entry, status: "renamed", oldPath: "zz" } : entry)) };
      expect(failureOf(await harness({ diff: ok(over) }).call("syns.changes", { since: OLD })).code).toBe("response_too_large");
    });
    it("a call reaching out with ../ counts its paths as the answer names them, with ../: it stays inside the room", async () => {
      const answer = many(700, 1400);
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, path: "../../..", content: true, scope: "a/b/c" }));
      expect(result.entries[0]!.path).toBe("../../../f0000.md");
      expect(result.deferred.length).toBeGreaterThan(0);
      expect(bytes(result)).toBeLessThanOrEqual(room);
    });
    it("a reaching call's paths grow by their ../ before the room is measured: a text at the edge never passes it", async () => {
      // 700 deletions at the root and one text, from a/b/c with ../../..: each path is answered nine bytes longer.
      const answer = many(1, 0);
      answer.entries.push(...Array.from({ length: 700 }, (_, index) => ({ ...answer.entries[0]!, path: `n${index}`, status: "deleted", newSha: undefined, size: undefined, text: undefined }) as never));
      answer.entries[0]!.text = "x".repeat(M1);
      const call = async () => resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, path: "../../..", content: true, scope: "a/b/c" }));
      const bare = bytes(await call());
      // Served, the text's own path leaves deferred (some 20 bytes): past that, only the counted growth keeps it out.
      for (const k of [-2, 0, 2, 30, 100, 1000]) {
        answer.entries[0]!.text = "x".repeat(room - bare - 10 + k);
        expect(bytes(await call()), String(k)).toBeLessThanOrEqual(room);
      }
    });
    it("a list of paths that cannot fit 1 MiB, or the host's 10,000 nodes, is response_too_large", async () => {
      const long = many(1, 0);
      // 700 entries (under 10,000 nodes) whose paths alone pass 1 MiB.
      long.entries = Array.from({ length: 700 }, (_, index) => ({ ...many(1, 0).entries[0]!, path: `${"d/".repeat(800)}${index}.md` }));
      expect(failureOf(await harness({ diff: ok(long) }).call("syns.changes", { since: OLD })).code).toBe("response_too_large");
      expect(failureOf(await harness({ diff: ok(many(1000, 1)) }).call("syns.changes", { since: OLD, content: true })).code).toBe("response_too_large");
      // 700 entries are under 10,000 nodes.
      expect(resultOf<Changes>(await harness({ diff: ok(many(700, 1)) }).call("syns.changes", { since: OLD, content: true })).entries).toHaveLength(700);
    });
  });

  describe("in an app's folder (S1.25, D87)", () => {
    it("the CLI gets --path with the folder; paths count from it; a move across its edge reads as the CLI masks it", async () => {
      const h = harness({ diff: rec("changes.app.0325") });
      const result = resultOf<Changes>(await h.call("syns.changes", { since: V2, content: true, scope: "app" }));
      expect(args(h)).toEqual([`diff --from=${V2} --provenance --content --path=app --json`]);
      expect(h.runner.calls[0]).toMatchObject({ scope: "app" });
      expect(result.entries.map((entry) => [entry.path, entry.status, entry.oldPath])).toEqual([
        ["del.md", "deleted", undefined],
        ["in.md", "added", undefined],
        ["out.md", "deleted", undefined],
        ["r2.md", "renamed", "r.md"],
        ["x.md", "modified", undefined],
      ]);
      expect(result.entries.find((entry) => entry.path === "in.md")).toMatchObject({ text: "joins app\n", by: { number: 7 } });
    });
    it("a path names a file or folder inside the folder", async () => {
      const h = harness({ diff: rec("changes.same.0325") });
      await h.call("syns.changes", { since: V9, path: "notes", scope: "app" });
      expect(args(h)).toEqual([`diff --from=${V9} --provenance --path=app/notes --json`]);
    });
    it("a rename with one side outside, should the CLI give one, reads as its mask reads it; a deferred path outside goes", async () => {
      const answer = {
        from: { commit: OLD, version: 4 },
        to: { commit: HEAD, version: 6 },
        entries: [
          { path: "app/in.md", oldPath: "in.md", status: "renamed", oldSha: "1".repeat(40), newSha: "1".repeat(40), size: 3, provenance: null, text: "in\n" },
          { path: "out.md", oldPath: "app/out.md", status: "renamed", oldSha: "2".repeat(40), newSha: "2".repeat(40), size: 4, provenance: null, text: null },
        ],
        deferred: ["out.md"],
      };
      const result = resultOf<Changes>(await harness({ diff: ok(answer) }).call("syns.changes", { since: OLD, content: true, scope: "app" }));
      expect(result.entries).toEqual([
        { path: "in.md", status: "added", blob: "1".repeat(40), size: 3, text: "in\n", by: null },
        { path: "out.md", status: "deleted", blob: null, by: null },
      ]);
      expect(result.deferred).toEqual([]);
    });
    it("a path beginning with ../ reaches the rest of the session's folder, counted with ../ (B-0083)", async () => {
      const h = harness({ diff: rec("changes.all.0325") });
      const result = resultOf<Changes>(await h.call("syns.changes", { since: V2, path: "..", content: true, scope: "app" }));
      expect(args(h)).toEqual([`diff --from=${V2} --provenance --content --json`]);
      expect(result.entries.map((entry) => entry.path)).toContain("../notes/q.md");
      expect(result.deferred).toEqual(["../big.txt"]);
    });
  });

  describe("refusals", () => {
    it("bad params are invalid_params before any process", async () => {
      const h = harness();
      for (const params of [{}, { since: "4" }, { since: V2.slice(1) }, { since: V2, to: "--to=1" }, { since: V2, content: "yes" }, { since: V2, path: "" }, { since: V2, path: "/a" }, { since: V2, path: "-a" }, { since: V2, path: "a/../b" }, { since: V2, other: 1 }]) {
        expect(failureOf(await h.call("syns.changes", params)).code, JSON.stringify(params)).toBe("invalid_params");
      }
      expect(h.runner.calls).toHaveLength(0);
    });
    it("an unknown version is not_found about the version", async () => {
      expect(failureOf(await harness({ diff: rec("changes.unknown-version.0325") }).call("syns.changes", { since: "1".repeat(40) }))).toMatchObject({ code: "not_found" });
    });
    it("since newer than to comes back in the CLI's words", async () => {
      const error = failureOf(await harness({ diff: rec("changes.reverse.0325") }).call("syns.changes", { since: V9, to: V2 }));
      expect(error.code).toBe("handler_error");
      expect(error.message).toContain("is newer than --to");
    });
    it("an answer with a hole in it is handler_error", async () => {
      expect(failureOf(await harness({ diff: ok({ from: { commit: OLD, version: 4 }, entries: [] }) }).call("syns.changes", { since: OLD })).code).toBe("handler_error");
    });
  });
});
