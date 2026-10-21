import { describe, expect, it } from "vitest";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/** 0.9 (roadmap 280, D18 as amended by D83): syns.ls format "lines", one string `path\tblob\tsize` per entry. */

const M1 = 1024 * 1024;
const listing = (n: number, pathOf: (i: number) => string = (i) => `notes/n${String(i).padStart(5, "0")}.md`) =>
  ok({ commitSha: HEAD, version: 6, truncated: false, entries: Array.from({ length: n }, (_, i) => ({ name: pathOf(i).split("/").pop(), path: pathOf(i), type: "file", size: i, sha: "c".repeat(40) })) });

interface Lines {
  version: string;
  number: number;
  truncated: boolean;
  total: number;
  nextOffset: number | null;
  lines?: string[];
  entries?: unknown[];
}

describe("syns.ls format lines (rows 20–26)", () => {
  it("one string per entry, path\\tblob\\tsize, a folder path\\t\\t, in the CLI's order, from the same one run (row 20)", async () => {
    const h = harness({ ls: rec("ls.ok") });
    const result = resultOf<Lines>(await h.call("syns.ls", { format: "lines" }));
    expect(result.lines).toEqual(["README.md\t7846c4f86a6274cdbd004ebed3985e953621223e\t94", "notes\t\t"]);
    expect(h.runner.calls.map((call) => call.args)).toEqual([["ls", "--json"]]);
  });

  it("format, offset and limit never reach the CLI (row 20)", async () => {
    const h = harness({ ls: listing(10) });
    await h.call("syns.ls", { path: "notes", recursive: true, version: OLD, format: "lines", offset: 3, limit: 4 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["ls", "--recursive", `--version=${OLD}`, "--json", "--", "notes"]]);
  });

  it("the result is { version, number, truncated, total, nextOffset, lines } with no entries; the default has entries and no lines (row 21)", async () => {
    const h = harness({ ls: rec("ls.ok") });
    const lines = resultOf<Lines>(await h.call("syns.ls", { format: "lines" }));
    expect(Object.keys(lines).sort()).toEqual(["lines", "nextOffset", "number", "total", "truncated", "version"]);
    const entries = resultOf<Lines>(await h.call("syns.ls", {}));
    expect(Object.keys(entries).sort()).toEqual(["entries", "nextOffset", "number", "total", "truncated", "version"]);
  });

  it("the default format answers as 0.8.7 did, byte for byte (row 21)", async () => {
    const h = harness({ ls: rec("ls.ok") });
    expect(JSON.stringify(resultOf(await h.call("syns.ls", {})))).toBe(
      JSON.stringify({ version: HEAD, number: 6, truncated: false, total: 2, nextOffset: null, entries: [{ path: "README.md", type: "file", size: 94, blob: "7846c4f86a6274cdbd004ebed3985e953621223e" }, { path: "notes", type: "dir", size: null, blob: null }] }),
    );
  });

  it("limit defaults to 9,000 under lines: 10,000 entries page as 9,000 then 1,000; total is the whole listing (row 22)", async () => {
    const h = harness({ ls: listing(10_000) });
    const first = resultOf<Lines>(await h.call("syns.ls", { recursive: true, format: "lines" }));
    expect(first.lines).toHaveLength(9000);
    expect(first).toMatchObject({ total: 10_000, nextOffset: 9000 });
    const second = resultOf<Lines>(await h.call("syns.ls", { recursive: true, format: "lines", offset: 9000 }));
    expect(second.lines).toHaveLength(1000);
    expect(second).toMatchObject({ total: 10_000, nextOffset: null });
    expect(second.lines![0]).toBe(`notes/n09000.md\t${"c".repeat(40)}\t9000`);
  });

  it("limit is at most 9,000 under lines (row 22)", async () => {
    const h = harness({ ls: listing(3) });
    expect(failureOf(await h.call("syns.ls", { format: "lines", limit: 9001 })).code).toBe("invalid_params");
    expect((await h.call("syns.ls", { format: "lines", limit: 9000 })).ok).toBe(true);
  });

  it("paths of 1,000 characters end the page early at the 1 MiB bound; nextOffset is offset + the lines returned (row 23)", async () => {
    const long = (i: number) => `${"p".repeat(990)}/${String(i).padStart(8, "0")}`;
    const h = harness({ ls: listing(3000, long) });
    const first = resultOf<Lines>(await h.call("syns.ls", { recursive: true, format: "lines" }));
    const n = first.lines!.length;
    expect(n).toBeGreaterThan(900);
    expect(n).toBeLessThan(1100);
    expect(first.nextOffset).toBe(n);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(M1 - 1024);
    const next = resultOf<Lines>(await h.call("syns.ls", { recursive: true, format: "lines", offset: 5 }));
    expect(next.nextOffset).toBe(5 + next.lines!.length);
  });

  it("at least one line is always returned, whatever its size (row 23)", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: "x".repeat(1024), type: "file", size: 1, sha: "c".repeat(40) }] }) });
    expect(resultOf<Lines>(await h.call("syns.ls", { format: "lines" })).lines).toHaveLength(1);
  });

  it("without lines the default stays bounded: limit above 1,500 is invalid_params before any run; format entries or any other value is refused (row 24)", async () => {
    const h = harness({ ls: listing(3) });
    expect(failureOf(await h.call("syns.ls", { limit: 1501 })).code).toBe("invalid_params");
    for (const format of ["entries", "LINES", 1, null]) expect(failureOf(await h.call("syns.ls", { format })).code, String(format)).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
    expect((await h.call("syns.ls", { limit: 1500 })).ok).toBe(true);
  });

  it("an answer without entries is handler_error under either format (row 25, S3.7)", async () => {
    for (const format of [undefined, "lines"]) {
      const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false }) });
      expect(failureOf(await h.call("syns.ls", format ? { format } : {})).code, String(format)).toBe("handler_error");
    }
  });

  it("a listing of thousands of files answers in one call and one run under lines, where the default needs ⌈n / 1,500⌉ calls (row 26)", async () => {
    const n = 4559;
    const lines = harness({ ls: listing(n) });
    const one = resultOf<Lines>(await lines.call("syns.ls", { recursive: true, format: "lines" }));
    expect(one).toMatchObject({ total: n, nextOffset: null });
    expect(one.lines).toHaveLength(n);
    expect(lines.runner.calls).toHaveLength(1);
    const entries = harness({ ls: listing(n) });
    let calls = 0;
    for (let offset: number | null = 0; offset !== null; calls += 1) offset = resultOf<Lines>(await entries.call("syns.ls", { recursive: true, offset })).nextOffset;
    expect(calls).toBe(Math.ceil(n / 1500));
  });
});
