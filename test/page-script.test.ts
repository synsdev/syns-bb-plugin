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

  it("is the page host and its bootstrap: it leaves the kernel and every contributor's page script to run, and shows a page through the host's own frame", () => {
    expect(PAGEHOST).toContain('if (window.SynsPages && window.SynsPages.frame) return;');
    expect(PAGEHOST).toContain('s.hasAttribute("data-thread-page-kernel") || s.hasAttribute("data-thread-page-contributor")');
    expect(PAGEHOST).toContain("this.stop = window.threadPage.embed(this.frame, {");
    expect(PAGEHOST).toContain('const entry = ".page/index.html"');
    expect(PAGEHOST).not.toContain("data-app");
  });

  it("does nothing in a frame of a page: the bootstrap returns when the kernel's config says embedded (B-0103)", () => {
    const boot = PAGEHOST.slice(PAGEHOST.lastIndexOf("(function () {"));
    expect(boot.indexOf('.embedded === true) return;')).toBeGreaterThan(-1);
    expect(boot.indexOf('.embedded === true) return;')).toBeLessThan(boot.indexOf("const observer = new MutationObserver"));
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

/**
 * The page host run in a stand-in window whose host offers threadPage.embed: a frame of `src`, what it read through
 * `call`, and what it handed the host's embed. The document parser is a stand-in that keeps the text as given.
 */
const hosted = async (src: Record<string, unknown>, files: Record<string, string> = {}, embed: unknown = true) => {
  const calls: [string, Record<string, unknown>][] = [];
  const embeds: { target: unknown; options: Record<string, any>; stopped: boolean }[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const el = (tag: string) => ({ tag, style: {}, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, remove() {}, contentWindow: { tag: "frame-window" } });
  const parsed = (text: string) => {
    const head: unknown[] = [];
    return { querySelectorAll: () => [], createElement: el, head: { prepend: (n: unknown) => head.unshift(n) },
      documentElement: { get outerHTML() { return head.map((n: any) => `<meta name="${n.attrs.name}">`).join("") + text; } } };
  };
  const win: Record<string, unknown> = { setTimeout, clearTimeout, setInterval, clearInterval, console, removeEventListener() {},
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "message") listeners.push(fn); } };
  win.window = win;
  win.parent = win;
  win.document = { createElement: el, querySelector: () => null, visibilityState: "visible" };
  win.DOMParser = class { parseFromString(text: string) { return parsed(text); } };
  win.threadPage = { invoke: () => Promise.reject(new Error("not this one")), ...(typeof embed === "function" ? { embed } : embed ? { embed: (target: unknown, options: Record<string, any>) => { const one = { target, options, stopped: false }; embeds.push(one); return () => { one.stopped = true; }; } } : {}) };
  runInContext(PAGEHOST, createContext(win));
  const call = (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (method === "syns.readMany") return Promise.resolve({ version: "v1", files: (params.paths as string[]).map((path) => ({ path, text: files[path] })) });
    return Promise.resolve({});
  };
  const states: Record<string, unknown>[] = [];
  const f = (win.SynsPages as { frame: (c: unknown, s: unknown, o: unknown) => any }).frame({ appendChild() {} }, src, { call, sessionId: "thr_1", onState: (s: Record<string, unknown>) => states.push(s) });
  await new Promise((settled) => setTimeout(settled, 0));
  const fromFrame = (data: unknown) => listeners.forEach((fn) => fn({ source: f.frame.contentWindow, data }));
  return { f, calls, embeds, states, fromFrame };
};

describe("an app is a frame of the page, the host's own (B-0103, B-0102, B-0104; Unife Pages IN-0020)", () => {
  it("hands the host the app's document with its folder as scope and its name as title, reading only the document", async () => {
    const { f, calls, embeds, states } = await hosted({ kind: "repo", folder: "apps/board/" }, { "apps/board/index.html": "<p>board</p>" });
    expect(calls).toEqual([["syns.readMany", { paths: ["apps/board/index.html", "apps/board/.page/index.html"] }], ["syns.readMany", { paths: ["apps/board/index.html"] }]]);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].target).toBe(f.frame);
    expect(embeds[0].options).toMatchObject({ scope: "apps/board", title: "board" });
    expect(embeds[0].options.html).toBe('<!doctype html>\n<meta name="syns-pages-frame"><p>board</p>');
    embeds[0].options.onState({ status: "shown" });
    expect(states.at(-1)).toEqual({ status: "shown", message: "", failures: [] });
    embeds[0].options.onState({ status: "too_large" });
    expect(states.at(-1)).toMatchObject({ status: "failed", message: "apps/board/index.html: too large to show in a frame" });
  });

  it("shows the agent's own page with no scope, as the page shown as written (S2.32)", async () => {
    const { embeds } = await hosted({ kind: "page", path: "notes/plan.html", html: "<h1>Plan</h1>" });
    expect(embeds[0].options).toMatchObject({ scope: null, title: "plan" });
    expect(embeds[0].options.html).toContain("<h1>Plan</h1>");
  });

  it("relays nothing of the frame's but its links: no call, no form answer, no drafts, no storage of its own", async () => {
    const { calls, fromFrame } = await hosted({ kind: "repo", folder: "apps/board" }, { "apps/board/index.html": "<form></form>" });
    const before = calls.length;
    fromFrame({ __tool: "invoke", id: 1, method: "session.reply", params: { text: "hi" } });
    fromFrame({ __tool: "form", title: "T", answers: [{ label: "a", value: "b" }] });
    fromFrame({ __tool: "draft", values: { a: 1 } });
    await new Promise((settled) => setTimeout(settled, 0));
    expect(calls.slice(before)).toEqual([]);
    for (const gone of ["const SHIM", "formdone", "session.reply", "storage.get", "storage.set", "nsKey", "stateKey", "CACHED", "data-thread-page-kernel], script[data-thread-page-contributor], base"]) expect(PAGEHOST, gone).not.toContain(gone);
  });

  it("a reload hands the host the document again, ending the frame it showed", async () => {
    const { f, embeds } = await hosted({ kind: "repo", folder: "apps/board" }, { "apps/board/index.html": "<p>1</p>" });
    f.changed(["apps/board/style.css"]);
    await new Promise((settled) => setTimeout(settled, 0));
    expect(embeds.map((e) => e.stopped)).toEqual([true, false]);
    f.changed(["apps/other/x.css"]);
    await new Promise((settled) => setTimeout(settled, 0));
    expect(embeds).toHaveLength(2);
  });

  it("on a host without the frame call, says which it needs and shows nothing", async () => {
    const { embeds, states } = await hosted({ kind: "repo", folder: "apps/board" }, { "apps/board/index.html": "<p>1</p>" }, false);
    expect(embeds).toEqual([]);
    expect(states.at(-1)).toMatchObject({ status: "failed", message: "showing a page in a frame needs Thread Pages 1.13.0 or Unife Pages 0.5.0" });
    // Thread Pages 1.12 and Unife Pages 0.4 have the call, for another session's page alone
    const older = await hosted({ kind: "repo", folder: "apps/board" }, { "apps/board/index.html": "<p>1</p>" }, (() => { throw new TypeError("threadPage.embed needs { sessionId }"); }) as unknown);
    expect(older.states.at(-1)).toMatchObject({ status: "failed", message: "showing a page in a frame needs Thread Pages 1.13.0 or Unife Pages 0.5.0 (threadPage.embed needs { sessionId })" });
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

  it("inside a frame it made, hands a link to the page host that made it; the kernel keeps #, mailto: and download links, and any link of a frame it did not make", () => {
    const posted: unknown[] = [];
    let click: ((e: unknown) => void) | null = null;
    const marked = { value: true };
    const kernel = { getAttribute: () => JSON.stringify({ embedded: true }) };
    const win: Record<string, unknown> = { console, addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "click") click = fn; } };
    win.window = win;
    win.parent = { postMessage: (m: unknown) => posted.push(m) };
    win.document = { querySelector: (q: string) => (q.startsWith("script[data-thread-page-kernel]") ? kernel : q.includes("syns-pages-frame") && marked.value ? {} : null), readyState: "complete" };
    runInContext(PAGEHOST, createContext(win));
    const press = (href: string, more: Record<string, unknown> = {}) => {
      let prevented = false;
      const a = { getAttribute: () => href, hasAttribute: (n: string) => n === "download" && !!more.download, target: more.target ?? "" };
      click!({ target: { closest: () => a }, button: 0, defaultPrevented: false, metaKey: !!more.meta, ctrlKey: false, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    expect(press("page2.html")).toBe(true);
    expect(press("https://example.com", { meta: true })).toBe(true);
    expect(posted).toEqual([{ __tool: "link", href: "page2.html", newTab: false }, { __tool: "link", href: "https://example.com", newTab: true }]);
    for (const href of ["#top", "mailto:a@b.c", "javascript:void 0"]) expect(press(href), href).toBe(false);
    expect(press("a.pdf", { download: true })).toBe(false);
    marked.value = false;
    expect(press("page2.html")).toBe(false);
    expect(posted).toHaveLength(2);
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
