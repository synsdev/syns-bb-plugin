import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDeclaration } from "../src/declaration.js";
import { REASONS } from "../src/errors.js";
import { METHODS } from "../src/methods/index.js";
import { reasonsOf } from "../src/method.js";
import { ok, rec } from "./fake-runner.js";
import { SAMPLES, harness } from "./harness.js";

/** 0.9 (roadmap 280, D-244 §3): the latest CLI only. No version gate is left (rows 37–39a). */

/** A reply for every verb a sample runs: what each answers does not matter here, only what runs. */
const ANY = Object.fromEntries(
  ["repo", "whoami", "ls", "cat", "history", "commit", "read", "glob", "grep", "diff", "write", "edit", "rm", "revert", "place", "status", "share", "unshare", "collaborators", "enable-checks", "explore", "users"].map((verb) => [verb, verb === "status" ? rec("status.clean") : ok({})]),
);

describe("latest CLI only (rows 37–39a)", () => {
  it("src/version.ts is gone (row 37)", () => {
    expect(existsSync(new URL("../src/version.ts", import.meta.url))).toBe(false);
  });

  it("no method carries minCli or minCliFor, and grep no OFFSET_CLI (row 37)", async () => {
    for (const method of METHODS) {
      expect(method, method.name).not.toHaveProperty("minCli");
      expect(method, method.name).not.toHaveProperty("minCliFor");
    }
    expect(await import("../src/methods/grep.js")).not.toHaveProperty("OFFSET_CLI");
  });

  it("cli_too_old is no reason; cli_missing stays (rows 37, 39)", () => {
    expect(REASONS).not.toHaveProperty("cli_too_old");
    expect(REASONS).toHaveProperty("cli_missing");
    for (const method of METHODS) {
      expect(reasonsOf(method), method.name).not.toContain("cli_too_old");
      expect(reasonsOf(method), method.name).toContain("cli_missing");
    }
    const declaration = buildDeclaration(METHODS, { agentInstructions: true });
    expect(JSON.stringify(declaration)).not.toContain("cli_too_old");
  });

  it("no method runs syns --version: over every method's sample call, no run has --version first (row 38)", async () => {
    for (const method of METHODS) {
      const h = harness(ANY);
      await h.call(method.name, SAMPLES[method.name]);
      expect(h.runner.calls.length, method.name).toBeGreaterThan(0);
      for (const call of h.runner.calls) expect(call.args[0], method.name).not.toBe("--version");
    }
  });

  it("syns.place is status, then place: 2 runs (row 38)", async () => {
    const h = harness({ status: rec("status.clean"), place: rec("place.ok") });
    await h.call("syns.place", SAMPLES["syns.place"]);
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["status", "place"]);
  });

  it("the declaration holds no older-CLI text: no 'CLI 0.', no 'older CLIs' (row 39a, D-244 §3)", () => {
    const text = JSON.stringify(buildDeclaration(METHODS, { agentInstructions: true }));
    expect(text).not.toMatch(/CLI 0\./);
    expect(text).not.toMatch(/older CLIs?/);
    const repo = METHODS.find((method) => method.name === "syns.repo")!;
    expect(((repo.result.properties as Record<string, { description?: string }>).number!).description).toBe("The head as a number, for display.");
  });

  it("the source keeps no per-version gate", () => {
    for (const name of ["dispatch.ts", "method.ts", "errors.ts", "methods/grep.ts", "methods/share.ts", "methods/explore.ts", "methods/enableChecks.ts", "methods/place.ts"]) {
      const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(text, name).not.toMatch(/minCli|cli_too_old|OFFSET_CLI|parseTriple|createVersions/);
    }
  });
});
