import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "../src/cli.js";
import { createHeld } from "../src/held.js";
import { ENVELOPE, M1, bytes } from "../src/method.js";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/** 0.2.0: pictures (D23–D27, roadmap 212, D-088). */

const PIECE = 737_280;
const LIM = 25 * 1024 * 1024;
const NEW = "a".repeat(39) + "1";
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const picture = (size: number): Buffer => {
  const data = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) data[index] = (index * 7919 + (index >> 8)) & 0xff;
  return data;
};
const pathOf = (request: RunRequest): string => request.args[request.args.length - 1]!;
const versionOf = (request: RunRequest): string | undefined => request.args.find((arg) => arg.startsWith("--version="))?.split("=")[1];
const clock = () => {
  let at = 1_000_000;
  return { now: () => at, pass: (ms: number) => (at += ms) };
};
const catOf = (data: Buffer, mediaType: string | null = "image/jpeg") => (request: RunRequest) =>
  ok({ commitSha: versionOf(request) ?? HEAD, version: 6, path: pathOf(request), size: data.length, sha: "e".repeat(40), mediaType, contentBase64: data.toString("base64") });

interface Piece {
  version: string;
  number: number;
  path: string;
  size: number;
  blob: string;
  mediaType: string | null;
  sha256: string;
  offset: number;
  base64: string;
  nextOffset: number | null;
}

describe("syns.readBinary (D23, D24)", () => {
  it("answers a small picture whole in one piece, with its size, hash, version and media type", async () => {
    const data = picture(3000);
    const h = harness({ cat: catOf(data, "image/png") });
    const piece = resultOf<Piece>(await h.call("syns.readBinary", { path: "images/a.png" }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([["cat", "--json", "--", "images/a.png"]]);
    expect(piece).toEqual({ version: HEAD, number: 6, path: "images/a.png", size: 3000, blob: "e".repeat(40), mediaType: "image/png", sha256: sha256(data), offset: 0, base64: data.toString("base64"), nextOffset: null });
  });

  it("hands a large picture out in pieces pinned to one version, from one CLI read", async () => {
    const data = picture(2_000_000);
    const h = harness({ cat: catOf(data) });
    const first = resultOf<Piece>(await h.call("syns.readBinary", { path: "photo.jpg" }));
    expect(first).toMatchObject({ offset: 0, nextOffset: PIECE, size: 2_000_000, version: HEAD, sha256: sha256(data) });
    const parts = [Buffer.from(first.base64, "base64")];
    let next = first.nextOffset;
    while (next !== null) {
      const piece = resultOf<Piece>(await h.call("syns.readBinary", { path: "photo.jpg", version: first.version, offset: next }));
      expect(piece.version).toBe(HEAD);
      parts.push(Buffer.from(piece.base64, "base64"));
      next = piece.nextOffset;
    }
    expect(Buffer.concat(parts).equals(data)).toBe(true);
    expect(h.runner.calls).toHaveLength(1);
  });

  it("every piece fits one answer", async () => {
    const data = picture(3 * PIECE);
    const h = harness({ cat: catOf(data) });
    const piece = resultOf<Piece>(await h.call("syns.readBinary", { path: "photo.jpg", version: OLD }));
    expect(bytes(piece)).toBeLessThanOrEqual(M1 - ENVELOPE);
  });

  it("reads again at the pinned version when the held bytes were dropped", async () => {
    const data = picture(1_000_000);
    const time = clock();
    const h = harness({ cat: catOf(data) }, { held: createHeld(time.now) });
    const first = resultOf<Piece>(await h.call("syns.readBinary", { path: "photo.jpg" }));
    time.pass(61_000);
    const second = resultOf<Piece>(await h.call("syns.readBinary", { path: "photo.jpg", version: first.version, offset: first.nextOffset }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([
      ["cat", "--json", "--", "photo.jpg"],
      ["cat", `--version=${HEAD}`, "--json", "--", "photo.jpg"],
    ]);
    expect(Buffer.concat([Buffer.from(first.base64, "base64"), Buffer.from(second.base64, "base64")]).equals(data)).toBe(true);
  });

  it("a text file is its bytes, with no media type", async () => {
    const h = harness({ cat: (request) => ok({ commitSha: HEAD, version: 6, path: pathOf(request), content: "é\n", size: 3, sha: "f".repeat(40), mediaType: null }) });
    const piece = resultOf<Piece>(await h.call("syns.readBinary", { path: "a.svg" }));
    expect(Buffer.from(piece.base64, "base64").toString("utf8")).toBe("é\n");
    expect(piece).toMatchObject({ size: 3, mediaType: null, nextOffset: null });
  });

  it("refuses an offset without the version of the first piece, and an offset past the end", async () => {
    const h = harness({ cat: catOf(picture(10)) });
    expect(failureOf(await h.call("syns.readBinary", { path: "p.jpg", offset: 5 })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
    expect(failureOf(await h.call("syns.readBinary", { path: "p.jpg", version: HEAD, offset: 11 })).code).toBe("invalid_params");
  });

  it("a missing path is not_found", async () => {
    const h = harness({ cat: rec("path-not-found-at-version") });
    expect(failureOf(await h.call("syns.readBinary", { path: "nope.jpg", version: HEAD })).code).toBe("not_found");
  });
});

describe("syns.writeBinary (D23, D25)", () => {
  const writeOk = ok({ commitSha: NEW, created: true, filesChanged: 1, version: 7 });

  it("stores a small picture in one call: write --bytes against base, with the provenance, the bytes on standard input", async () => {
    const data = picture(5000);
    const h = harness({ write: writeOk });
    const result = resultOf(await h.call("syns.writeBinary", { path: "images/a.png", base64: data.toString("base64"), base: HEAD }, "thr_abc"));
    expect(result).toEqual({ complete: true, received: 5000, version: NEW, number: 7, changed: 1 });
    const call = h.runner.calls[0]!;
    expect(call.args).toEqual(["write", "--bytes", `--parent=${HEAD}`, "--message=Write images/a.png from a page", "--integration=syns-bb-plugin", "--trigger=thread-page", "--run=thr_abc", "--json", "--", "images/a.png"]);
    expect(call.stdinBase64).toBe(data.toString("base64"));
    expect(call.stdin).toBeUndefined();
  });

  it("gathers a large picture across calls and publishes it whole, once, after the last piece", async () => {
    const data = picture(2_000_000);
    const h = harness({ write: writeOk });
    const common = { path: "photo.jpg", base: HEAD, size: data.length, sha256: sha256(data) };
    const answers = [];
    for (let offset = 0; offset < data.length; offset += PIECE) {
      answers.push(resultOf(await h.call("syns.writeBinary", { ...common, offset, base64: data.subarray(offset, offset + PIECE).toString("base64") })));
    }
    expect(answers.slice(0, -1)).toEqual([
      { complete: false, received: PIECE },
      { complete: false, received: 2 * PIECE },
    ]);
    expect(answers.at(-1)).toEqual({ complete: true, received: 2_000_000, version: NEW, number: 7, changed: 1 });
    expect(h.runner.calls).toHaveLength(1);
    expect(Buffer.from(h.runner.calls[0]!.stdinBase64!, "base64").equals(data)).toBe(true);
  });

  it("a piece at the wrong offset is conflict / bad_offset with the offset expected; nothing is written", async () => {
    const data = picture(1_000_000);
    const h = harness({ write: writeOk });
    const common = { path: "photo.jpg", base: HEAD, size: data.length, sha256: sha256(data) };
    await h.call("syns.writeBinary", { ...common, offset: 0, base64: data.subarray(0, PIECE).toString("base64") });
    const error = failureOf(await h.call("syns.writeBinary", { ...common, offset: 5, base64: "AAAA" }));
    expect(error).toMatchObject({ code: "conflict", reason: "bad_offset", detail: { expected: PIECE } });
    expect(h.runner.calls).toHaveLength(0);
  });

  it("after the pieces were dropped, bad_offset expects 0", async () => {
    const data = picture(1_000_000);
    const time = clock();
    const h = harness({ write: writeOk }, { held: createHeld(time.now) });
    const common = { path: "photo.jpg", base: HEAD, size: data.length, sha256: sha256(data) };
    await h.call("syns.writeBinary", { ...common, offset: 0, base64: data.subarray(0, PIECE).toString("base64") });
    time.pass(61_000);
    const error = failureOf(await h.call("syns.writeBinary", { ...common, offset: PIECE, base64: data.subarray(PIECE).toString("base64") }));
    expect(error).toMatchObject({ reason: "bad_offset", detail: { expected: 0 } });
  });

  it("a hash that does not match is invalid_params / bad_hash, and nothing is written or kept", async () => {
    const data = picture(1000);
    const h = harness({ write: writeOk });
    const error = failureOf(await h.call("syns.writeBinary", { path: "a.png", base: HEAD, size: 1000, sha256: "0".repeat(64), offset: 0, base64: data.toString("base64") }));
    expect(error).toMatchObject({ code: "invalid_params", reason: "bad_hash" });
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a picture declared past 25 MiB is invalid_params / too_large before anything is held", async () => {
    const h = harness({});
    const error = failureOf(await h.call("syns.writeBinary", { path: "huge.tif", base: HEAD, size: LIM + 1, sha256: "0".repeat(64), offset: 0, base64: "AAAA" }));
    expect(error).toMatchObject({ code: "invalid_params", reason: "too_large", detail: { max: LIM } });
  });

  it("the CLI's own payload_too_large is too_large too", async () => {
    const h = harness({ write: { exitCode: 1, stdout: JSON.stringify({ error: "payload_too_large: a.bin holds 26214401 bytes, past the 25 MiB one file may hold; nothing was sent" }), stderr: "", timedOut: false, spawnError: null, overflowed: false } });
    expect(failureOf(await h.call("syns.writeBinary", { path: "a.bin", base: HEAD, base64: "AAAA" }))).toMatchObject({ code: "invalid_params", reason: "too_large" });
  });

  it("refuses a piece with only some of offset, size and sha256, and a piece past size", async () => {
    const h = harness({});
    expect(failureOf(await h.call("syns.writeBinary", { path: "a.png", base: HEAD, base64: "AAAA", offset: 0 })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.writeBinary", { path: "a.png", base: HEAD, base64: "AAAAAAAA", offset: 0, size: 3, sha256: "0".repeat(64) })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a moved base refuses the whole picture as stale_head, and the pieces are dropped", async () => {
    const data = picture(1000);
    const h = harness({ write: rec("stale-parent") });
    const common = { path: "a.png", base: OLD, size: 1000, sha256: sha256(data) };
    expect(failureOf(await h.call("syns.writeBinary", { ...common, offset: 0, base64: data.toString("base64") })).reason).toBe("stale_head");
    expect(failureOf(await h.call("syns.writeBinary", { ...common, offset: 1000, base64: "" })).detail).toEqual({ expected: 0 });
  });

  it("a session gathers at most two pictures: a third drops the oldest", async () => {
    const h = harness({});
    const start = (name: string) => h.call("syns.writeBinary", { path: name, base: HEAD, size: 2 * PIECE, sha256: "0".repeat(64), offset: 0, base64: picture(PIECE).toString("base64") });
    await start("a.jpg");
    await start("b.jpg");
    await start("c.jpg");
    const again = failureOf(await h.call("syns.writeBinary", { path: "a.jpg", base: HEAD, size: 2 * PIECE, sha256: "0".repeat(64), offset: PIECE, base64: "AAAA" }));
    expect(again.detail).toEqual({ expected: 0 });
    expect(resultOf(await h.call("syns.writeBinary", { path: "c.jpg", base: HEAD, size: 2 * PIECE, sha256: "0".repeat(64), offset: PIECE, base64: "AAAA" }))).toEqual({ complete: false, received: PIECE + 3 });
  });

  it("logs the method, the session and one path, never the bytes (S2.19, S2.20)", async () => {
    const h = harness({ write: writeOk });
    const data = picture(300);
    await h.call("syns.writeBinary", { path: "a.png", base64: data.toString("base64"), base: HEAD });
    expect(h.log).toEqual(["syns.writeBinary session=thr_page paths=1 outcome=ok"]);
  });
});

describe("pictures in syns.commit (D26)", () => {
  const commitOk = ok({ commitSha: NEW, created: false, filesChanged: 2, version: 7 });

  it("a file entry may carry base64 in place of text: contentBase64 in the changeset", async () => {
    const data = picture(900);
    const h = harness({ commit: commitOk });
    resultOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "a.md", text: "see ![](a.png)\n" }, { path: "a.png", base64: data.toString("base64") }] }));
    expect(JSON.parse(h.runner.calls[0]!.stdin!)).toEqual({ files: [{ path: "a.md", content: "see ![](a.png)\n" }, { path: "a.png", contentBase64: data.toString("base64") }], deletions: [] });
  });

  it("names a picture gathered with hold: true by its sha256, and publishes it inside the changeset", async () => {
    const data = picture(1_000_000);
    const h = harness({ commit: commitOk });
    const common = { path: "photo.jpg", base: HEAD, size: data.length, sha256: sha256(data), hold: true };
    resultOf(await h.call("syns.writeBinary", { ...common, offset: 0, base64: data.subarray(0, PIECE).toString("base64") }));
    const held = resultOf(await h.call("syns.writeBinary", { ...common, offset: PIECE, base64: data.subarray(PIECE).toString("base64") }));
    expect(held).toEqual({ complete: true, received: 1_000_000, upload: sha256(data) });
    expect(h.runner.calls).toHaveLength(0);
    resultOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "notes/trip.md", text: "![](photo.jpg)\n" }, { path: "photo.jpg", upload: sha256(data) }] }));
    const changeset = JSON.parse(h.runner.calls[0]!.stdin!) as { files: { path: string; contentBase64?: string }[] };
    expect(Buffer.from(changeset.files[1]!.contentBase64!, "base64").equals(data)).toBe(true);
    // Published once: the held picture is gone.
    expect(failureOf(await h.call("syns.commit", { base: NEW, files: [{ path: "photo.jpg", upload: sha256(data) }] })).detail).toEqual({ expected: 0 });
  });

  it("an upload the plugin does not hold is conflict / bad_offset expecting 0, and nothing runs", async () => {
    const h = harness({});
    const error = failureOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "p.jpg", upload: "1".repeat(64) }] }));
    expect(error).toMatchObject({ code: "conflict", reason: "bad_offset", detail: { expected: 0 } });
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a file entry carrying more or fewer than one of text, base64 and upload is invalid_params", async () => {
    const h = harness({});
    expect(failureOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "a", text: "x", base64: "AAAA" }] })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "a" }] })).code).toBe("invalid_params");
  });
});
