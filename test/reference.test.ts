import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { fakeBb } from "./fake-bb.js";
import { rec } from "./fake-runner.js";

/**
 * The declaration as a host takes it, through the protocol's own code rather than this plugin's idea of it:
 * `parseContributor` (07 §The declaration grammar) from `pages-core`, and bb-pages' discovery and invoke
 * (`createBbContributors`, 07 §Discovery per host) over this plugin's RPCs. Neither package is published, so they
 * are read from a checkout of the Unife monorepo: `UNIFE_MONO`, else the folder beside this repository's parent.
 * Without one the suite is skipped and says why.
 */
const MONO = process.env.UNIFE_MONO ?? fileURLToPath(new URL("../../../unife-mono", import.meta.url));
const VALIDATOR = join(MONO, "packages/pages-core/src/domain/capabilities/contributed.ts");
const DISCOVERY = join(MONO, "packages/bb-pages/src/provider/contributors.ts");
const present = existsSync(VALIDATOR) && existsSync(DISCOVERY);

/** The declaration frozen at this version: a text or schema edit is a deliberate change to this file (D.6). */
const FIXTURE = new URL("./fixtures/declaration-0.8.0.json", import.meta.url);

describe("the frozen declaration", () => {
  it("is what the table builds, but for the version, which declaration.test.ts holds to package.json", () => {
    const frozen = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    const built = buildDeclaration(METHODS, { agentInstructions: true });
    expect(JSON.stringify({ ...built, version: frozen.version })).toBe(JSON.stringify(frozen));
  });
});

describe.skipIf(!present)(`the reference host code (${present ? MONO : `no Unife monorepo at ${MONO}; set UNIFE_MONO`})`, () => {
  it("parseContributor accepts the whole declaration, with and without the fragment: 29 methods, no problem", async () => {
    const { parseContributor } = await import(/* @vite-ignore */ VALIDATOR);
    for (const agentInstructions of [true, false]) {
      const declaration = buildDeclaration(METHODS, { agentInstructions });
      const parsed = parseContributor("syns", JSON.parse(JSON.stringify(declaration)));
      expect(parsed.problems).toEqual([]);
      expect(parsed.contributor.methods.map((m: { method: string }) => m.method)).toEqual(METHODS.map((m) => m.name));
      expect(parsed.contributor.instruction).toBe(agentInstructions ? declaration.instruction : null);
      expect(parsed.contributor.guide).toBe(declaration.guide);
    }
  });

  /** bb-pages' adapter over a bb whose plugin RPCs are this plugin's own handlers. */
  async function discovery(hostCall: Parameters<typeof fakeBb>[1]) {
    const { createBbContributors } = await import(/* @vite-ignore */ DISCOVERY);
    const { handlers } = fakeBb({}, hostCall);
    const bb = {
      pluginId: "bb-pages",
      sdk: {
        plugins: {
          list: async () => ({ plugins: [{ id: "bb-pages", enabled: true, status: "running" }, { id: "syns", enabled: true, status: "running" }] }),
          callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input?: unknown }) => {
            if (pluginId !== "syns" || !handlers[method]) throw Object.assign(new Error("http 404"), { status: 404 });
            return handlers[method]!(input);
          },
        },
      },
    };
    return createBbContributors(bb as never, { log: { warn: () => undefined } });
  }

  it("bb-pages lists the plugin with the declaration the table builds", async () => {
    const contributors = await discovery(async () => rec("repo.ok"));
    expect(await contributors.list()).toEqual([{ id: "syns", declaration: buildDeclaration(METHODS, { agentInstructions: true }) }]);
  });

  it("bb-pages' invoke reaches the session's folder without a scope, and the placed folder with one", async () => {
    const runs: Record<string, unknown>[] = [];
    const contributors = await discovery(async (_method, input) => (runs.push(input), rec("repo.ok")));
    expect(await contributors.invoke("syns", { method: "syns.repo", params: {}, caller: { sessionId: "thr_1", scope: null, workspace: { id: "proj_1", path: "/work/checkout", machine: "host_9" } }, requestId: "r1" })).toMatchObject({ ok: true });
    expect(runs).toEqual([expect.objectContaining({ cwd: "/work/checkout", args: ["repo", "--json"] })]);
    expect(runs[0]).not.toHaveProperty("within");
    runs.length = 0;
    expect(await contributors.invoke("syns", { method: "syns.repo", params: {}, caller: { sessionId: "thr_1", scope: "clients/vela/crm", workspace: { id: "proj_1", path: "/work/checkout", machine: "host_9" } }, requestId: "r2" })).toMatchObject({ ok: true });
    expect(runs.at(-1)).toMatchObject({ cwd: "/work/checkout/clients/vela/crm", within: "/work/checkout", args: ["repo", "--json"] });
  });
});
