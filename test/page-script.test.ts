import { Script, createContext, runInContext } from "node:vm";
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

  it("with no workspace to read, leaves the page as written and runs its scripts once: any failure of the first read, or no .page/index.html (S2.29)", () => {
    expect(PAGEHOST).toContain("catch (e) { if (app.version) throw e; return showWritten(); }");
    expect(PAGEHOST).toContain('if (app.version) throw new Error(entry + " is no longer in the repository"); return showWritten();');
    expect(PAGEHOST).toContain("if (shown) return;");
    expect(PAGEHOST).not.toContain("so there is no app to load");
  });

  it("clears the document only once the workspace is there, so the host's restore of drafts and scroll finds the page (S2.29)", () => {
    const capture = PAGEHOST.slice(PAGEHOST.indexOf("function capture()"), PAGEHOST.indexOf("function clear()"));
    expect(capture).not.toContain("remove()" + ";\n    Array.from(document.body.attributes)");
    expect(capture).not.toContain('say("Loading…")');
    const load = PAGEHOST.slice(PAGEHOST.indexOf("async function load()"));
    expect(load.indexOf("if (!app.version) { clear(); listen(); }")).toBeGreaterThan(load.indexOf("if (!index || index.text === undefined)"));
  });

  it("once the workspace is shown, takes a saved page through threadPage.onPageUpdate where the host offers it: SynsPages.page and only its frames change, no new boot (S2.30)", () => {
    const load = PAGEHOST.slice(PAGEHOST.indexOf("async function load()"));
    expect(load).toContain("if (!app.version) { clear(); listen(); }");
    expect(load.indexOf("listen();")).toBeGreaterThan(load.indexOf("return showWritten();"));
    const listen = PAGEHOST.slice(PAGEHOST.indexOf("function listen()"), PAGEHOST.indexOf("function clear()"));
    expect(listen).toContain('if (typeof window.threadPage.onPageUpdate !== "function") return;');
    expect(listen).toContain("P.showPage(describe(doc.documentElement, u.documentPath, doc.title));");
    expect(PAGEHOST).toContain('if (f.src.kind === "page" && f.src.html !== undefined && f.src.path === page.path) { f.src.html = page.html || "<html></html>"; f.reload(); }');
    expect(PAGEHOST).toContain("live.add(this);");
    expect(PAGEHOST).toContain("live.delete(this);");
  });
});

describe("the page host's app calls (S1.25, D85)", () => {
  it("passes an app's folder as scope with every syns.* call, and rewrites no path in the call or the answer", () => {
    const call = PAGEHOST.slice(PAGEHOST.indexOf("async call(method, params)"), PAGEHOST.indexOf("// Where a link goes"));
    expect(call).toContain("const p = Object.assign({}, params, { scope: this.folder });");
    expect(call).toContain("try { return await this.invoke(method, p); }");
    for (const gone of ["inF", "strip", "F + \"/\"", "p.paths", "p.pattern", "p.glob", "p.deletions"]) expect(call, gone).not.toContain(gone);
    expect(PAGEHOST).not.toContain("strip(v)");
  });

  /** The page host run in a stand-in window: a frame of `src`, whose calls reach `invoke`, and `ask` as the frame asks. */
  const framed = async (src: Record<string, unknown>) => {
    const calls: [string, Record<string, unknown>][] = [];
    const el = () => ({ style: {}, setAttribute() {}, remove() {}, contentWindow: { postMessage() {} } as { postMessage: (m: unknown) => void } });
    const win: Record<string, unknown> = { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval, console };
    win.window = win;
    win.document = { createElement: el };
    const ctx = createContext(win);
    runInContext(PAGEHOST, ctx);
    const invoke = (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return Promise.resolve({ method }); };
    const f = (win.SynsPages as { frame: (c: unknown, s: unknown, o: unknown) => any }).frame({ appendChild() {} }, src, { call: invoke, sessionId: "thr_1" });
    await new Promise((settled) => setTimeout(settled, 0)); // its own first reads (state, the app's index.html) are not the app's calls
    calls.length = 0;
    const ask = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((done) => {
      f.frame.contentWindow.postMessage = done;
      f.answer({ source: f.frame.contentWindow, data: { __tool: "invoke", id: 1, method, params } });
    });
    return { ask, calls: () => calls };
  };
  // Every built-in Thread Page method but storage.* (the host's confirmations and grants stay its own), and one another plugin added.
  const THREAD_PAGE = ["context.get", "session.reply", "session.messages", "session.activity", "session.usage", "session.respond",
    "sessions.snapshot", "sessions.messages", "sessions.markRead", "sessions.start", "sessions.send", "sessions.stop", "sessions.archive",
    "sessions.respond", "sessions.openHost", "pages.open", "pages.read", "pages.answer", "providers.list", "workspaces.list",
    "workspaces.create", "workspaces.browse", "navigation.openExternal", "voice.captureAndTranscribe", "other.plugin.method"];

  it("passes an app's every Thread Page call to the app's invoke as given, so the host confirms or grants it as on a Thread Page (D91)", async () => {
    for (const method of THREAD_PAGE) {
      const { ask, calls } = await framed({ kind: "repo", folder: "apps/board" });
      const params = { sessionId: "thr_2", text: "hi", files: [{ name: "a.png" }] };
      const answer = await ask(method, params);
      expect(answer, method).toMatchObject({ ok: true });
      expect(calls(), method).toEqual([[method, params]]);
    }
  });

  it("gives an app's every syns.* call its folder as scope, keeping no list of methods; storage.* stays its own (D85, D92, D93)", async () => {
    const { ask, calls } = await framed({ kind: "repo", folder: "apps/board/" });
    for (const method of ["syns.read", "syns.write", "syns.place", "syns.share", "syns.collaborators", "syns.enableChecks"]) await ask(method, { path: "a.md" });
    for (const method of ["syns.explore", "syns.users"]) await ask(method, { query: "x" });
    await ask("storage.set", { key: "k", value: 1 });
    expect(calls()).toEqual([
      ...["syns.read", "syns.write", "syns.place", "syns.share", "syns.collaborators", "syns.enableChecks"].map((m) => [m, { path: "a.md", scope: "apps/board" }]),
      ["syns.explore", { query: "x", scope: "apps/board" }], ["syns.users", { query: "x", scope: "apps/board" }],
      ["storage.set", { key: expect.stringMatching(/^f\.[a-z0-9]+:k$/), value: 1 }],
    ]);
    for (const gone of ["isn't available here", "const SYNS", "const PASS", "const OPEN"]) expect(PAGEHOST, gone).not.toContain(gone);
  });

  it("follows an app's ../ links as far as the session's folder; one climbing above it loads nothing (S1.25, Q-0025, B-0083)", () => {
    const helper = /const join = function \(dir, ref\) \{[\s\S]*?\n  \};/.exec(PAGEHOST)![0];
    const join = new Function(helper + " return join;")() as (dir: string, ref: string) => string;
    expect(join("tools/app", "style.css")).toBe("tools/app/style.css");
    expect(join("tools/app", "../shared/theme.css")).toBe("tools/shared/theme.css");
    expect(join("tools/app", "../../notes/plan.css?v=2")).toBe("notes/plan.css");
    expect(join("tools/app", "../../../x.css")).toBe("");
    expect(join("tools/app", "../../../../private/secret.txt")).toBe("");
    expect(PAGEHOST).toContain("await this.readAll(want.filter(Boolean), version)");
  });

  it("keeps the frame's drafts and scroll under a key no app's storage.set can name, \"state\" included", () => {
    const keys = PAGEHOST.slice(PAGEHOST.indexOf("const hash = function"), PAGEHOST.indexOf("// ---"));
    const stateKey = /this\.stateKey = ([^;]+);/.exec(PAGEHOST)![1];
    const host = new Function(keys + "return { nsKey, stateKey: function () { return " + stateKey + "; } };")();
    for (const id of ["repo:board", "page:index.html"]) {
      const own = host.stateKey.call({ id });
      for (const key of ["state", ".state", "_state", ""]) expect(own).not.toBe(host.nsKey(id, key));
      expect(own).not.toContain(":");
      expect(host.nsKey(id, "state")).toContain(":");
    }
  });
});

describe("the agent's own page in a frame (S2.32, D91 point 2)", () => {
  // The frame's call(), run against a fake host invoke: what reaches the host, per frame kind.
  const lists = PAGEHOST.slice(PAGEHOST.indexOf("const CACHED = "), PAGEHOST.indexOf("// ---"));
  const body = PAGEHOST.slice(PAGEHOST.indexOf("async call(method, params)"), PAGEHOST.indexOf("// Where a link goes"));
  const host = new Function(lists + "return { " + body + " };")() as { call(this: unknown, m: string, p: Record<string, unknown>): Promise<unknown> };
  const frame = (src: Record<string, unknown>) => {
    const seen: [string, Record<string, unknown>][] = [];
    const f = { src, id: src.kind === "repo" ? "repo:" + src.folder : "page:" + src.path, folder: src.kind === "repo" ? src.folder : "",
      invoke: async (m: string, p: Record<string, unknown>) => { seen.push([m, p]); return { ok: m }; } };
    return { seen, call: (m: string, p: Record<string, unknown>) => host.call.call(f, m, p) };
  };
  const methods = ["session.usage", "sessions.messages", "sessions.send", "sessions.markRead", "pages.answer", "syns.shareInfo", "syns.collaborators",
    "syns.place", "syns.explore", "syns.users", "syns.enableChecks", "syns.read", "context.get", "syns.repo"];

  it("passes every call of the agent's page to the host as the page shown as written makes it: no list, no scope, no cache", async () => {
    const page = frame({ kind: "page", path: "index.html" });
    for (const m of methods) {
      const params = { path: "a.md", version: undefined };
      await expect(page.call(m, params), m).resolves.toEqual({ ok: m });
      expect(page.seen.at(-1), m).toEqual([m, params]);
    }
    await page.call("syns.repo", {});
    expect(page.seen.filter(([m]) => m === "syns.repo")).toHaveLength(2);
  });

  it("keeps the agent's page's storage keys as written, so a value saved in one view is read in the other; an app's stay its own", async () => {
    const page = frame({ kind: "page", path: "index.html" });
    await page.call("storage.set", { key: "draft", value: 1 });
    await page.call("storage.get", { key: "draft" });
    await page.call("storage.setMany", { entries: [{ key: "a", value: 2 }] });
    expect(page.seen).toEqual([["storage.set", { key: "draft", value: 1 }], ["storage.get", { key: "draft" }], ["storage.setMany", { entries: [{ key: "a", value: 2 }] }]]);
    const app = frame({ kind: "repo", folder: "board" });
    await app.call("storage.get", { key: "draft" });
    expect(app.seen[0][1].key).not.toBe("draft");
  });

  it("an app's frame differs only in its syns.* scope and its storage keys (B-0084, D91 point 1)", async () => {
    const app = frame({ kind: "repo", folder: "board" });
    await expect(app.call("session.usage", {})).resolves.toEqual({ ok: "session.usage" });
    expect(app.seen.at(-1)).toEqual(["session.usage", {}]);
    await app.call("syns.read", { path: "a.md" });
    expect(app.seen.at(-1)).toEqual(["syns.read", { path: "a.md", scope: "board" }]);
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

describe("a frame gets what a Thread Page frame gets (B-0105, D91, D92)", () => {
  it("carries allow=\"fullscreen *; clipboard-write *\": the Thread Page's own fullscreen (unife-pages R3.3b, WebKit refuses a plain fullscreen) and the clipboard write it may pass on", () => {
    const ctor = PAGEHOST.slice(PAGEHOST.indexOf("class PageFrame"), PAGEHOST.indexOf("container.appendChild(this.frame)"));
    expect(ctor).toContain('this.frame.setAttribute("allow", "fullscreen *; clipboard-write *");');
  });

  /** The page host's link() run on its own, from an app (repo) or the agent's page, read at `origin`, on a host whose navigation.openExternal refuses `own` origins as R5.32a says. */
  const linkOf = (src: { kind: "repo"; folder: string } | { kind: "page"; path: string }, origin = "https://bart.getbb.app", own = [origin]) => {
    const body = PAGEHOST.slice(PAGEHOST.indexOf("    link(href, newTab) {"), PAGEHOST.indexOf("  P.frame = function"));
    const helpers = PAGEHOST.slice(PAGEHOST.indexOf("  const dirOf = function"), PAGEHOST.indexOf("  const baseOf = function")) + PAGEHOST.slice(PAGEHOST.indexOf("  const local = function"), PAGEHOST.indexOf("  const live = new Set()"));
    const Frame = new Function("location", helpers + "return class { " + body.trim().replace(/\}\s*$/, "") + " };")({ href: origin + "/x", origin });
    const went: unknown[] = [], asked: unknown[] = [];
    const f = Object.assign(new Frame(), {
      src, folder: src.kind === "repo" ? src.folder : "", opts: { onLink: (t: unknown) => went.push(t) },
      invoke: async (m: string, p: { url?: string }) => {
        asked.push([m, p]);
        if (m === "navigation.openExternal" && /declined/.test(p.url!)) throw Object.assign(new Error("The reader declined"), { code: "denied" });
        if (m === "navigation.openExternal" && /limited/.test(p.url!)) throw Object.assign(new Error("Too many calls"), { code: "rate_limited" });
        if (m === "navigation.openExternal" && own.includes(new URL(p.url!).origin)) throw Object.assign(new Error("This is the host's own address; use pages.open or sessions.openHost"), { code: "invalid_params" });
        return {};
      },
      session: async () => "thr_own", entry: () => (src.kind === "repo" ? src.folder + "/index.html" : src.path), load: () => undefined,
    });
    return { link: async (href: string, newTab = false) => { await f.link(href, newTab); return { went: went.splice(0), asked: asked.splice(0) }; } };
  };
  const refused = (url: string) => ["navigation.openExternal", { url }];

  it("opens another session's page on this host with pages.open once the host refuses it as its own, on bb's address and on Unife Pages' (Claude Code)", async () => {
    const bb = linkOf({ kind: "repo", folder: "tools/app" });
    const a = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_other&path=notes.html#top";
    expect(await bb.link(a)).toEqual({ went: [], asked: [refused(a), ["pages.open", { sessionId: "thr_other" }]] });
    const cc = linkOf({ kind: "page", path: "index.html" }, "http://127.0.0.1:4848", ["http://127.0.0.1:4848", "http://localhost:4848"]);
    for (const b of ["http://127.0.0.1:4848/page?session=thr_other", "http://localhost:4848/page?session=thr_other"]) expect(await cc.link(b), b).toEqual({ went: [], asked: [refused(b), ["pages.open", { sessionId: "thr_other" }]] });
  });

  it("opens the address an agent is given (bb Connect) while the reader is on the local origin, as the host counts both as its own (B-0105 F1)", async () => {
    const local = linkOf({ kind: "repo", folder: "tools/app" }, "http://127.0.0.1:38886", ["http://127.0.0.1:38886", "https://bart.getbb.app"]);
    const a = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_other";
    expect(await local.link(a)).toEqual({ went: [], asked: [refused(a), ["pages.open", { sessionId: "thr_other" }]] });
    const b = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_own&path=docs%2Fplan.html";
    expect(await local.link(b)).toEqual({ went: [{ kind: "page", path: "docs/plan.html", newTab: false }], asked: [refused(b)] });
  });

  it("leaves another host's page address to navigation.openExternal, which opens it", async () => {
    const one = linkOf({ kind: "repo", folder: "tools/app" });
    const a = "https://alice.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_other";
    expect(await one.link(a)).toEqual({ went: [], asked: [["navigation.openExternal", { url: a }]] });
  });

  it("opens nothing on any other refusal of a page address (declined, rate_limited)", async () => {
    const one = linkOf({ kind: "repo", folder: "tools/app" });
    for (const a of ["https://alice.getbb.app/declined/page?session=thr_other", "https://bart.getbb.app/limited/page?session=thr_other"]) expect(await one.link(a), a).toEqual({ went: [], asked: [["navigation.openExternal", { url: a }]] });
  });

  it("opens this session's own page's documents in the workspace, as a relative link does", async () => {
    const one = linkOf({ kind: "repo", folder: "tools/app" });
    const a = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_own&path=docs%2Fplan.html";
    expect(await one.link(a, true)).toEqual({ went: [{ kind: "page", path: "docs/plan.html", newTab: true }], asked: [refused(a)] });
    const b = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_own";
    expect(await one.link(b)).toEqual({ went: [{ kind: "page", path: "index.html", newTab: false }], asked: [refused(b)] });
    const c = "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page?session=thr_own&path=tool.html%3Fscope%3Da#top";
    expect(await one.link(c)).toEqual({ went: [{ kind: "page", path: "tool.html?scope=a#top", newTab: false }], asked: [refused(c)] });
  });

  it("leaves every other address to the workspace's own external handler: another path on this host, a page address with no session", async () => {
    const one = linkOf({ kind: "repo", folder: "tools/app" });
    for (const url of ["https://bart.getbb.app/threads/thr_other", "https://bart.getbb.app/api/v1/plugins/thread-pages/http/page", "https://bart.getbb.app/pages?session=thr_other", "https://"]) {
      expect(await one.link(url), url).toEqual({ went: [{ kind: "external", url, newTab: true }], asked: [] });
    }
  });
});
