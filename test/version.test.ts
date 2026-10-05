import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";
import { K64, object, type Method } from "../src/method.js";
import { atLeast, createVersions, parseTriple } from "../src/version.js";
import { fakeRunner, ok, spawnFailed } from "./fake-runner.js";
import { failureOf, harness, resultOf } from "./harness.js";

/** `syns --version` prints plain text (HOST_FACTS §15). */
const printed = (text: string) => ({ exitCode: 0, stdout: `${text}\n`, stderr: "", timedOut: false, spawnError: null, overflowed: false });

const needs: Method = {
  name: "syns.needsNew",
  description: "A method that exists only in this test and needs CLI 0.3.11.",
  effect: "read",
  minCli: "0.3.11",
  params: object({}),
  result: { type: "object", properties: { fine: { type: "boolean" } }, required: ["fine"] },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  command: () => ({ args: ["fine", "--json"] }),
  shape: (out) => ({ fine: out.fine }),
};

describe("versions (D41)", () => {
  it("parses syns --version and compares triples", () => {
    expect(parseTriple("syns 0.3.11")).toEqual([0, 3, 11]);
    expect(parseTriple("nothing here")).toBeNull();
    expect(atLeast([0, 3, 11], [0, 3, 11])).toBe(true);
    expect(atLeast([0, 3, 10], [0, 3, 11])).toBe(false);
    expect(atLeast([0, 4, 0], [0, 3, 11])).toBe(true);
    expect(atLeast([1, 0, 0], [0, 9, 99])).toBe(true);
  });

  it("asks a machine once a minute at most", async () => {
    const runner = fakeRunner({ "--version": printed("syns 0.3.11") });
    let clock = 0;
    const versions = createVersions(createCli(runner), () => clock);
    const where = { hostId: "h", cwd: "/w" };
    expect((await versions.of(where, Date.now() + 5000)).text).toBe("0.3.11");
    clock = 59_000;
    await versions.of(where, Date.now() + 5000);
    expect(runner.calls).toHaveLength(1);
    clock = 61_000;
    await versions.of(where, Date.now() + 5000);
    expect(runner.calls).toHaveLength(2);
  });
});

describe("a method with minCli (D41)", () => {
  it("runs when the CLI is new enough, after one --version", async () => {
    const h = harness({ "--version": printed("syns 0.3.11"), fine: ok({ fine: true }) }, { table: [needs] });
    expect(resultOf(await h.call("syns.needsNew"))).toEqual({ fine: true });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["--version"], ["fine", "--json"]]);
  });

  it("answers unavailable / cli_too_old with what it needs and has, running nothing else", async () => {
    const h = harness({ "--version": printed("syns 0.3.10") }, { table: [needs] });
    expect(failureOf(await h.call("syns.needsNew"))).toMatchObject({ code: "unavailable", reason: "cli_too_old", detail: { need: "0.3.11", have: "0.3.10" } });
    expect(h.runner.calls).toHaveLength(1);
  });

  it("treats a CLI that prints no version as too old, and a missing one as cli_missing", async () => {
    expect(failureOf(await harness({ "--version": printed("garbage") }, { table: [needs] }).call("syns.needsNew"))).toMatchObject({ reason: "cli_too_old", detail: { have: null } });
    expect(failureOf(await harness({ "--version": spawnFailed("cli_not_found") }, { table: [needs] }).call("syns.needsNew"))).toMatchObject({ reason: "cli_missing" });
  });

  it("declares cli_too_old only on methods that set minCli", async () => {
    const { reasonsOf } = await import("../src/method.js");
    expect(reasonsOf(needs)).toContain("cli_too_old");
    const { METHODS } = await import("../src/methods/index.js");
    for (const method of METHODS.filter((m) => !m.minCli)) expect(reasonsOf(method), method.name).not.toContain("cli_too_old");
  });
});
