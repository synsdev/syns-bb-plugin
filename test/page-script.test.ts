import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { VERSION, buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { PAGEHOST } from "../src/pagehost.js";
import { fakeBb } from "./fake-bb.js";
import { rec } from "./fake-runner.js";

/** One page-script ask as Thread Pages sends it (unife-pages 07 R5.88). */
const ask = (have: string | null, workspace: unknown = { id: "proj_1", path: "/work/plans", machine: "host_9" }, sessionId: string | null = "thr_1") => ({ caller: { sessionId, workspace }, documentPath: "index.html", have });

describe("the page script's text (S2.28)", () => {
  it("parses as a script, and holds neither </script nor <!--, inside the host's 256 KiB (07 R5.90)", () => {
    expect(() => new Script(PAGEHOST)).not.toThrow();
    expect(PAGEHOST).not.toMatch(/<\/script|<!--/i);
    expect(Buffer.byteLength(PAGEHOST)).toBeLessThanOrEqual(256 * 1024);
  });

  it("is the page host and its bootstrap: it leaves the kernel and every contributor's page script to run, and strips them from a page it frames", () => {
    expect(PAGEHOST).toContain('if (window.SynsPages && window.SynsPages.frame) return;');
    expect(PAGEHOST).toContain('s.hasAttribute("data-thread-page-kernel") || s.hasAttribute("data-thread-page-contributor")');
    expect(PAGEHOST).toContain('doc.querySelectorAll("script[data-thread-page-kernel], script[data-thread-page-contributor], base")');
    expect(PAGEHOST).toContain('const entry = ".page/index.html"');
    expect(PAGEHOST).not.toContain("data-app");
  });

  it("with no workspace to load, puts the page back as written: on no_repo and on a missing .page/index.html (S2.29)", () => {
    expect(PAGEHOST).toContain('if (e.reason === "no_repo") return showWritten();');
    expect(PAGEHOST).toContain("if (!index || index.text === undefined) return showWritten();");
    expect(PAGEHOST).not.toContain("so there is no app to load");
  });
});

describe("the page script on bb (S2.27)", () => {
  it("is declared, whatever agentInstructions says", () => {
    for (const agentInstructions of [true, false]) expect(buildDeclaration(METHODS, { agentInstructions }).pageScript).toBe(true);
  });

  it("answers the script at the plugin's version when the session's folder is a Syns repository, checked with one syns repo --json there", async () => {
    const asked: unknown[] = [];
    const { handlers } = fakeBb({}, async (method, input, options) => (asked.push({ method, input, options }), rec("repo.ok")));
    expect(await handlers.threadPagesPageScript!(ask(null))).toEqual({ version: VERSION, script: PAGEHOST });
    expect(asked).toEqual([{ method: "run", input: { cwd: "/work/plans", args: ["repo", "--json"], timeoutMs: expect.any(Number) }, options: { hostId: "host_9", timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) } }]);
    expect((asked[0] as { input: { timeoutMs: number } }).input.timeoutMs).toBeLessThanOrEqual(2_000);
  });

  it("answers the script for a placed folder too", async () => {
    const { handlers } = fakeBb({}, async () => rec("repo.folder"));
    expect(await handlers.threadPagesPageScript!(ask(null))).toEqual({ version: VERSION, script: PAGEHOST });
  });

  it("answers only the version when the host already holds it, and the whole script for any other version", async () => {
    const { handlers } = fakeBb({}, async () => rec("repo.ok"));
    expect(await handlers.threadPagesPageScript!(ask(VERSION))).toEqual({ version: VERSION });
    expect(await handlers.threadPagesPageScript!(ask("0.0.1"))).toEqual({ version: VERSION, script: PAGEHOST });
  });

  it("answers none outside a Syns repository, signed out, or when the CLI cannot run", async () => {
    for (const reply of [rec("no-identity"), rec("signed-out.repo"), rec("not-json")]) {
      const { handlers } = fakeBb({}, async () => reply);
      expect(await handlers.threadPagesPageScript!(ask(null))).toBeNull();
    }
    const { handlers } = fakeBb({}, async () => {
      throw new Error("host host_9 is offline");
    });
    expect(await handlers.threadPagesPageScript!(ask(null))).toBeNull();
  });

  it("answers none, and runs nothing, with no session, no folder or a folder that is not an absolute path", async () => {
    const asked: unknown[] = [];
    const { handlers } = fakeBb({}, async (method) => (asked.push(method), rec("repo.ok")));
    for (const one of [ask(null, null, null), ask(null, null), ask(null, { id: "p", path: "work/plans", machine: null }), ask(null, { id: "p", machine: null }), {}, null]) {
      expect(await handlers.threadPagesPageScript!(one)).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("answers none inside the host's 2 s when the check does not finish", async () => {
    const { handlers } = fakeBb({}, () => new Promise(() => undefined));
    const started = Date.now();
    expect(await handlers.threadPagesPageScript!(ask(null))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
