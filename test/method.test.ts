import { describe, expect, it } from "vitest";
import { base, message, object, path, pick, validate, version } from "../src/method.js";

describe("path (S2.9, A31)", () => {
  const schema = object({ path }, ["path"]);
  const refused = ["", "-rf", "--version=1", "/etc/passwd", "a/../b", "..", "../a", "a/..", ".", "./a", "a/./b", "a\\b", "a\u0000b", "a\nb", "a\u007fb", "x".repeat(1025)];
  for (const bad of refused) {
    it(`refuses ${JSON.stringify(bad.slice(0, 20))}`, () => expect(validate(schema, { path: bad })).not.toBeNull());
  }
  const accepted = ["README.md", "notes/a.md", "notes/.hidden", "a..b/c", "a/b-c/-d.md", "żółć/ü.md", "x".repeat(1024), "with space.md", "...", "a/..."];
  for (const good of accepted) {
    it(`accepts ${JSON.stringify(good.slice(0, 20))}`, () => expect(validate(schema, { path: good })).toBeNull());
  }
});

describe("version and base (spec conventions, D12)", () => {
  it("is forty lowercase hexadecimal characters", () => {
    expect(validate(version, "7ca9bc78ba047d9e7798b8d2733c254e24cfc837")).toBeNull();
    for (const bad of ["6", "7CA9BC78BA047D9E7798B8D2733C254E24CFC837", "7ca9bc78", "--parent=1", 6, null]) expect(validate(version, bad)).not.toBeNull();
    expect(validate(base, "--repo=someone/else")).not.toBeNull();
  });
});

describe("message (S1.6)", () => {
  it("is at most 500 characters", () => {
    expect(validate(message, "x".repeat(500))).toBeNull();
    expect(validate(message, "x".repeat(501))).not.toBeNull();
  });
});

describe("validate, the subset the host also checks", () => {
  const schema = object({ n: { type: "integer", minimum: 1, maximum: 3 }, list: { type: "array", items: { type: "string", maxLength: 2 }, minItems: 1, maxItems: 2 }, kind: { type: "string", enum: ["a", "b"], maxLength: 1 }, maybe: { type: ["string", "null"], maxLength: 4 } }, ["n"]);
  it("accepts what fits", () => expect(validate(schema, { n: 2, list: ["ab"], kind: "a", maybe: null })).toBeNull());
  it("refuses an unknown key on a closed object (A34)", () => expect(validate(schema, { n: 1, sessionId: "thr_x" })).toContain("sessionId"));
  it("refuses a missing required key", () => expect(validate(schema, {})).toContain("n"));
  it("refuses wrong types, ranges, lengths and counts", () => {
    for (const bad of [{ n: "1" }, { n: 1.5 }, { n: 0 }, { n: 4 }, { n: 1, list: [] }, { n: 1, list: ["a", "b", "c"] }, { n: 1, list: ["abc"] }, { n: 1, kind: "c" }, { n: 1, maybe: 3 }, [], null, "x"]) {
      expect(validate(schema, bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
  it("lets an open object carry keys it does not declare", () => {
    expect(validate({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { a: "x", b: 1 })).toBeNull();
  });
});

describe("pick: the CLI's JSON, kept to what the result schema names (D59, S1.7)", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, n: { type: "integer" }, maybe: { type: ["string", "null"] }, list: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } };
  it("keeps named keys of an allowed type, nested too, and drops every other key", () => {
    expect(pick(schema, { a: "x", n: 3, maybe: null, list: [{ id: "u", secret: 1 }], token: "t" })).toEqual({ a: "x", n: 3, maybe: null, list: [{ id: "u" }] });
  });
  it("drops a value of the wrong type rather than passing it, and makes nothing up", () => {
    expect(pick(schema, { a: 1, n: 1.5, maybe: 2 })).toEqual({});
    expect(pick(schema, {})).toEqual({});
  });
});
