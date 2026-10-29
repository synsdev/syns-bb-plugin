/**
 * The page script (spec 02 §The page script, S2.27–S2.30): the Syns page host and its bootstrap, which Thread Pages puts first in
 * every page of a session whose folder is a Syns repository. Kept as text, since it runs in the reader's browser and
 * not here; its tests check it parses and holds nothing the host refuses (unife-pages 07 R5.90).
 */
export const PAGEHOST = String.raw`/*
 * The Syns page host: pages in frames, for any app on a Thread Page of a Syns repository. Nothing in it is one
 * app's: an app (the workspace, a template's, anyone's) gives it a container and gets a page running in it.
 * The Syns plugin's page script: Thread Pages puts it first in every page of a session whose folder is a Syns
 * repository, right after its kernel. It holds neither a closing script tag nor a comment opener, which would end
 * the inline script it is carried in (unife-pages 07 R5.90).
 *
 *   const f = SynsPages.frame(container, src, options)
 *     src      { kind: "repo", folder, doc? }   a folder's index.html, else a placed template's .page/index.html,
 *                                              its folder the frame's scope (syns.* and storage.* count from it)
 *              { kind: "page", path, html? }   a document of the session's own page (html: the one this
 *                                              document is, as SynsPages.page has it; else read with pages.read)
 *     options  call(method, params)    the app's own invoke, for what the host reads (default threadPage.invoke)
 *              sessionId               default: context.get
 *              onLink(target)          { kind: "external" | "repo" | "page", path | url, newTab }; default: external only
 *                                      (a page address …/page?session= goes to navigation.openExternal itself, and reaches onLink as "page" only when the host refuses it as its own)
 *              onState(state)          { status: "loading" | "shown" | "failed", message, failures: [] }
 *     f.reload()   the app started again, in a fresh frame
 *     f.changed(paths)   a new version where a path is in its folder, in the same frame: drafts and scroll kept, and
 *                        nothing loaded when its text is unchanged (Unife Pages 0.5.3)
 *     f.destroy()   f.frame (the iframe)   f.title()
 *
 *   SynsPages.page            the Thread Page this document is, taken before the app loaded (the bootstrap, at the end of this file)
 *   SynsPages.showPage(page)  a new version of SynsPages.page: the frames showing it take it
 *   SynsPages.tools(paths)    the folders among the repository's paths that open as pages
 *   SynsPages.pageUrl(sessionId, path, fragment)   the host's address of a document of the page
 *   SynsPages.goTo(fromPath, path)                  this document goes to another document of the page
 *
 * A frame is the host's own (threadPage.embed { html, scope, title }: Thread Pages 1.13.4, Unife Pages 0.5.4), a frame
 * of the page with its kernel and its plugins' page scripts: its calls, forms, text areas, file inputs, drafts and
 * scroll are a Thread Page's (Unife Pages IN-0020, B-0102, B-0103, B-0104). The page host reads the document, carries
 * its relative CSS and JS inside it (bb serves a page's files inside the page, not by URL), and hands its links to
 * onLink; this script, run again inside the frame, does the last.
 */
(function () {
  "use strict";
  if (window.SynsPages && window.SynsPages.frame) return;
  const P = (window.SynsPages = window.SynsPages || {});
  const dirOf = function (p) { const i = String(p).lastIndexOf("/"); return i < 0 ? "" : String(p).slice(0, i + 1); };
  const baseOf = function (p) { return String(p).replace(/\/+$/, "").replace(/^.*\//, ""); };
  const MARK = "syns-pages-frame"; // a <meta name> in every document the page host frames

  // ------------------------------------------------------------------ inside a frame the page host made
  // Its links go to the page host that made it, which opens them (onLink); the kernel takes every other link.
  const kernelConfig = function () { try { return JSON.parse(document.querySelector("script[data-thread-page-kernel]").getAttribute("data-config")) || {}; } catch (e) { return {}; } };
  if (kernelConfig().embedded === true && window.parent !== window) {
    window.addEventListener("click", function (e) {
      const a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a || e.defaultPrevented || e.button !== 0 || a.hasAttribute("download") || !document.querySelector('meta[name="' + MARK + '"]')) return;
      const href = a.getAttribute("href");
      if (/^\s*(#|blob:|data:|javascript:|mailto:|tel:|sms:)/i.test(href)) return;
      e.preventDefault();
      window.parent.postMessage({ __tool: "link", href: href, newTab: e.metaKey || e.ctrlKey || a.target === "_blank" }, "*");
    }, true);
  }

  const safeScript = function (t) { return String(t).replace(/<\/(script)/gi, "<\\/$1").replace(/<!(?=--)/g, "<\\!"); };
  const local = function (ref) { return !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref); };
  const join = function (dir, ref) {
    const out = [];
    let above = false; // a ../ past the session's folder names nothing (Q-0025)
    (dir + "/" + ref.split(/[?#]/)[0]).split("/").forEach(function (s) { if (s === "..") above = above || !out.pop(); else if (s && s !== ".") out.push(s); });
    return above ? "" : out.join("/");
  };
  const NEEDS = "showing a page in a frame needs Thread Pages 1.13.4 or Unife Pages 0.5.4";
  // Whether this host holds an app's frame in the folder it is given (Unife Pages 0.5.4: its setScope then refuses a
  // wider one). The API names no version, so a hidden frame asks once; on an older host an app could widen its own scope
  // to the whole session, so none is shown (B-0103, review F1). True or false, kept for the page's life; null when no
  // answer came, or { error } when the host refused the check's frame itself (that folder, or an older embed): neither
  // is kept, so the next app asks again.
  const PROBE = "<!doctype html><script>var b;try{threadPage.setScope(null);b=false}catch(e){b=e instanceof TypeError}parent.postMessage({__tool:\"bound\",bound:b},\"*\")<" + "/script>";
  let bound = null;
  const holdsFrames = function (container, folder) {
    if (bound) return bound;
    const asked = bound = new Promise(function (ok) {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.style.display = "none";
      container.appendChild(f);
      let stop = null, timer = null;
      const on = function (e) { if (e.source === f.contentWindow && e.data && e.data.__tool === "bound") done(e.data.bound === true); };
      const done = function (v) {
        window.removeEventListener("message", on); clearTimeout(timer);
        try { if (stop) stop(); } catch (x) { /* gone already */ }
        f.remove();
        ok(v);
      };
      window.addEventListener("message", on);
      timer = setTimeout(function () { done(null); }, 10000);
      try { stop = window.threadPage.embed(f, { html: PROBE, scope: folder, title: "Syns check" }); } catch (x) { done({ error: x }); }
    });
    asked.then(function (v) { if (v !== true && v !== false && bound === asked) bound = null; });
    return asked;
  };
  const STATES = { too_large: "too large to show in a frame", unavailable: "not shown", not_found: "not found", no_page: "not written yet" };

  // The host's refusal of an embed: an older one takes { sessionId } alone (a TypeError).
  const refused = function (x) { return new Error(x && x.name === "TypeError" ? NEEDS + " (" + x.message + ")" : String(x && x.message || x)); };

  const live = new Set();
  class PageFrame {
    constructor(container, src, options) {
      this.src = Object.assign({}, src);
      this.opts = options || {};
      this.invoke = this.opts.call || function (m, p) { return window.threadPage.invoke(m, p); };
      this.folder = src.kind === "repo" ? String(src.folder).replace(/\/+$/, "") : "";
      this.container = container;
      this.frame = document.createElement("iframe");
      this.frame.title = this.title();
      this.frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads allow-popups");
      this.frame.setAttribute("allow", "fullscreen *; clipboard-write *");
      Object.assign(this.frame.style, { flex: "1", width: "100%", height: "100%", border: "0", display: "none", background: "transparent" });
      container.appendChild(this.frame);
      live.add(this);
      this.onMessage = (e) => this.answer(e);
      window.addEventListener("message", this.onMessage);
      if (src.kind === "page" && !src.html) this.poll = setInterval(() => this.checkPage(), 4000);
      this.load();
    }
    title() { return this.src.title || (this.src.kind === "repo" ? baseOf(this.folder) : baseOf(this.src.path).replace(/\.html?$/i, "")); }
    entry() { return this.src.kind === "repo" ? this.folder + "/" + (this.src.doc || "index.html") : this.src.path; }
    destroy() { this.dead = true; live.delete(this); clearInterval(this.poll); window.removeEventListener("message", this.onMessage); if (this.stop) this.stop(); this.frame.remove(); }
    /** The app started again, in a fresh frame; a new version of its document (changed, showPage) keeps the reader's work. */
    reload() { this.fresh = true; return this.load(); }
    /** Repository paths that changed: a tool reloads when one is in its folder. */
    changed(paths) { if (this.src.kind === "repo" && !this.dead && (paths || []).some((p) => String(p).startsWith(this.folder + "/"))) this.load(); }
    report(status, message) { if (this.opts.onState) this.opts.onState({ status: status, message: message || "", failures: [] }); }
    async session() { if (!this.sessionId) this.sessionId = this.opts.sessionId || ((await this.invoke("context.get", {})).session || {}).id; return this.sessionId; }

    async readAll(paths, version) {
      const got = {};
      for (let i = 0; i < paths.length; i += 64) {
        const r = await this.invoke("syns.readMany", { paths: paths.slice(i, i + 64), version: version });
        r.files.forEach((x) => { got[x.path] = x.text; });
      }
      return got;
    }
    async load() {
      this.report("loading");
      const at = this.entry(), dir = dirOf(at).replace(/\/$/, "");
      try {
        let text, version;
        if (this.src.kind === "repo") {
          const tries = this.src.doc ? [at] : [this.folder + "/index.html", this.folder + "/.page/index.html"];
          const first = await this.invoke("syns.readMany", { paths: tries });
          const f = first.files.find((x) => x.text !== undefined);
          if (!f) throw new Error(tries.join(" or ") + ": not found");
          if (!this.src.doc) { this.src.doc = f.path.slice(this.folder.length + 1); return this.load(); }
          text = f.text; version = first.version;
        } else if (this.src.html) { text = this.src.html; this.revision = "inline"; // the page this document is: the host refreshes it
        } else {
          const r = await this.invoke("pages.read", { pages: [{ sessionId: await this.session(), path: at }] });
          const e = r.pages[0] || {};
          if (e.error || e.html === undefined) throw new Error(at + ": " + ((e.error && (e.error.reason || e.error.message)) || "not served"));
          text = e.html; this.revision = e.revision;
        }
        if (typeof (window.threadPage && window.threadPage.embed) !== "function") throw new Error(NEEDS);
        if (this.src.kind === "repo") {
          const holds = await holdsFrames(this.container, this.folder);
          if (holds === null) throw new Error("the host did not say whether it holds an app in its folder; reload to try again");
          if (holds && holds.error) throw refused(holds.error);
          if (!holds) throw new Error(NEEDS);
        }
        const doc = new DOMParser().parseFromString(text, "text/html");
        const refs = this.src.kind === "page" ? [] : Array.from(doc.querySelectorAll('link[rel="stylesheet"][href], script[src]'))
          .filter((el) => local(el.getAttribute("href") || el.getAttribute("src")));
        const want = refs.map((el) => join(dir, el.getAttribute("href") || el.getAttribute("src")));
        const got = await this.readAll(want.filter(Boolean), version);
        refs.forEach((el, i) => {
          const t = got[want[i]] || "";
          if (el.tagName === "LINK") { const s = doc.createElement("style"); s.textContent = t; el.replaceWith(s); }
          else { el.removeAttribute("src"); el.textContent = safeScript(t) + "\n//# sourceURL=" + want[i]; }
        });
        doc.querySelectorAll("script:not([src])").forEach((s) => { s.textContent = safeScript(s.textContent); });
        const mark = doc.createElement("meta");
        mark.setAttribute("name", MARK);
        doc.head.prepend(mark);
        if (this.dead) return;
        // A new version of the document it shows is the same frame's (Unife Pages 0.5.3): the reader's drafts and scroll
        // stay, and the earlier call's stop would end it. Another document is a fresh frame.
        if (this.stop && (this.shown !== at || this.fresh)) { this.stop(); this.stop = null; }
        this.fresh = false;
        this.shown = at;
        this.frame.style.display = "";
        try {
          this.stop = window.threadPage.embed(this.frame, {
            html: "<!doctype html>\n" + doc.documentElement.outerHTML,
            scope: this.src.kind === "repo" ? this.folder || null : null,
            title: this.title(),
            onState: (s) => { if (s.status === "shown" || s.status === "loading") this.report(s.status); else this.report("failed", at + ": " + (STATES[s.status] || s.status)); },
          });
        } catch (x) { this.stop = null; this.shown = null; throw refused(x); }
      } catch (e) {
        this.frame.style.display = "none";
        this.report("failed", String(e && e.message || e));
      }
    }
    // A page read with pages.read reloads when the agent saves it.
    async checkPage() {
      if (this.dead || !this.frame.isConnected || this.frame.offsetParent === null || document.visibilityState !== "visible" || !this.revision) return;
      try {
        const r = await this.invoke("pages.read", { pages: [{ sessionId: await this.session(), path: this.src.path, ifNoneMatch: this.revision }] });
        const e = r.pages[0] || {};
        if (!e.unchanged && e.revision && e.revision !== this.revision) this.load();
      } catch (e) { /* gone or busy: keep what is shown */ }
    }

    // ---- what the frame asks: only where a link goes
    answer(e) {
      if (e.source !== this.frame.contentWindow || !e.data || e.data.__tool !== "link") return;
      this.link(String(e.data.href || ""), !!e.data.newTab);
    }
    // Where a link goes, for the app to open: a page on this host, another site, a repository file, a document of the page.
    link(href, newTab) {
      const go = this.opts.onLink || ((t) => { if (t.kind === "external") this.invoke("navigation.openExternal", { url: t.url }).catch(() => {}); });
      if (/^https?:/i.test(href)) {
        let u = null; try { u = new URL(href); } catch (e) { /* no address: external, as written */ }
        // A page address (bb's and Unife Pages' routes both end in /page): the host says whether it is its own, by refusing it (R5.32a, before any confirmation);
        // then this session's documents open in place, another session's page by pages.open (which takes no path). Until the kernel routes such links (unife-pages IN-0019).
        const id = u && /\/page$/.test(u.pathname) && u.searchParams.get("session");
        if (id) return this.invoke("navigation.openExternal", { url: href }).catch((x) => { if (x && x.code === "invalid_params") return this.session().then((own) => id === own ? go({ kind: "page", path: (u.searchParams.get("path") || "index.html") + u.hash, newTab: newTab }) : this.invoke("pages.open", { sessionId: id })); }).catch(() => {});
        return go({ kind: "external", url: href, newTab: true });
      }
      if (!local(href)) return;
      const to = join(dirOf(this.entry()).replace(/\/$/, ""), href);
      if (this.src.kind === "page") return go({ kind: "page", path: to, newTab: newTab });
      if (to.startsWith(this.folder + "/") && /\.html?$/i.test(to)) { this.src.doc = to.slice(this.folder.length + 1); this.load(); return; }
      go({ kind: "repo", path: to, newTab: newTab });
    }
  }

  P.frame = function (container, src, options) { return new PageFrame(container, src, options); };
  /** A new version of the page this document is: SynsPages.page becomes it, and only the frames showing it reload. */
  P.showPage = function (page) {
    P.page = page;
    live.forEach(function (f) { if (f.src.kind === "page" && f.src.html !== undefined && f.src.path === page.path) { f.src.html = page.html || "<html></html>"; f.load(); } });
  };
  /** The folders that open as pages: one holding an index.html (not under a dot folder, not inside another), or a placed template (.syns.yaml, its app in .page/). */
  P.tools = function (paths) {
    const placed = paths.filter((p) => /(^|\/)\.syns\.yaml$/.test(p) && p !== ".syns.yaml").map((p) => p.slice(0, -".syns.yaml".length));
    const inPlaced = (p) => placed.some((t) => p.startsWith(t));
    const html = paths.filter((p) => /\/index\.html$/.test(p) && !/(^|\/)\./.test(p) && !inPlaced(p)).map((p) => p.slice(0, -"index.html".length));
    return { placed: placed, html: html, all: placed.concat(html) };
  };
  P.pageUrl = function (sessionId, path, fragment) {
    let origin = "";
    try { origin = new URL(location.href).origin; } catch (e) { /* stays relative */ }
    return origin + "/api/v1/plugins/thread-pages/http/page?session=" + encodeURIComponent(sessionId) + (path ? "&path=" + encodeURIComponent(path) : "") + (fragment || "");
  };
  P.goTo = function (fromPath, path) {
    const here = String(fromPath || "index.html").split("/").slice(0, -1);
    const q = String(path).indexOf("?"), file = q < 0 ? String(path) : String(path).slice(0, q), query = q < 0 ? "" : String(path).slice(q);
    const to = file.split("/");
    let i = 0; while (i < here.length && i < to.length - 1 && here[i] === to[i]) i++;
    const a = document.createElement("a");
    a.href = here.slice(i).map(function () { return ".."; }).concat(to.slice(i)).join("/") + query;
    document.body.appendChild(a); a.click(); a.remove();
  };
})();

/*
 * The bootstrap. It keeps the page as the host served it (window.SynsPages.page), holds back the page's own scripts
 * (they run in the workspace's frame instead) and reads the repository's workspace (.page/index.html); only once it
 * is there does it clear the document and load the workspace into it. With no workspace to read (no such file, no
 * repository yet, or no syns.* here) the page stays as written and its scripts run; in a frame of a page (the kernel's
 * config says embedded) it does nothing, so a framed document runs as written. Once the workspace
 * is shown, a saved page is taken through threadPage.onPageUpdate where the host offers it: only the agent's page
 * (SynsPages.page and its frame) changes, with no new boot; without it the host loads the saved page as before.
 *   SynsPages.app   { version, reload(), onStop(fn) }   an in-page reload: stop the app, read it again, start it.
 */
(function () {
  "use strict";
  const P = window.SynsPages;
  if (P.page || !document.currentScript || document.readyState !== "loading") return;
  // In a frame of a page (an app, the agent's page, another session's) the document is the frame's own, as written.
  try { if (JSON.parse(document.querySelector("script[data-thread-page-kernel]").getAttribute("data-config")).embedded === true) return; } catch (e) { /* no kernel config: a page */ }
  const me = document.currentScript;
  // The host's kernel and every contributor's page script run as served; only the page's own scripts are held.
  const served = function (s) { return s === me || s.hasAttribute("data-thread-page-kernel") || s.hasAttribute("data-thread-page-contributor"); };
  const held = new Map();
  const observer = new MutationObserver(function (records) {
    records.forEach(function (r) { r.addedNodes.forEach(function (n) {
      if (n.tagName === "SCRIPT" && !served(n) && !held.has(n)) { held.set(n, n.getAttribute("type")); n.type = "text/x-held"; }
    }); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ---- the page this script is in
  function capture() {
    const kernel = document.querySelector("script[data-thread-page-kernel]");
    let docPath = "index.html";
    try { docPath = JSON.parse(kernel.getAttribute("data-config")).documentPath || docPath; } catch (e) { /* the entry document */ }
    observer.disconnect();
    const scripts = Array.from(document.scripts), clone = document.documentElement.cloneNode(true), cs = Array.from(clone.querySelectorAll("script"));
    scripts.forEach(function (s, i) {
      if (served(s)) cs[i].remove();
      else if (held.has(s)) { if (held.get(s) === null) cs[i].removeAttribute("type"); else cs[i].setAttribute("type", held.get(s)); }
    });
    P.page = describe(clone, docPath, document.title);
  }
  // The page as SynsPages.page has it: from its <html> element, with no <base>.
  function describe(root, path, title) {
    root.querySelectorAll("base").forEach(function (el) { el.remove(); });
    const body = root.querySelector("body");
    const hasPage = !!body && (Array.from(body.children).some(function (el) { return el.tagName !== "SCRIPT"; }) || body.textContent.trim() !== "");
    return Object.freeze({
      path: path, hasPage: hasPage,
      title: title || path.replace(/^.*\//, "").replace(/\.html?$/i, ""),
      html: hasPage ? "<!doctype html>\n" + root.outerHTML : null,
    });
  }
  // A saved page, handed over by the host (without its kernel, page scripts and base) instead of a new boot.
  function listen() {
    if (typeof window.threadPage.onPageUpdate !== "function") return;
    window.threadPage.onPageUpdate(function (u) {
      const doc = new DOMParser().parseFromString(u.html, "text/html");
      P.showPage(describe(doc.documentElement, u.documentPath, doc.title));
    });
  }
  // The workspace is there: the document is cleared for it.
  // The kernel and every plugin's page script stay: the host carries those it finds here into each frame it shows, and
  // this one, run again there, opens the frame's links (B-0105).
  function clear() {
    Array.from(document.head.children).forEach(function (el) { if (!(el.tagName === "SCRIPT" && served(el)) && el.tagName !== "META") el.remove(); });
    Array.from(document.body.attributes).forEach(function (a) { document.body.removeAttribute(a.name); });
    const style = document.createElement("style");
    style.textContent = ":root{color-scheme:light dark}#boot-msg{font:15px/22px system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 24px}";
    document.head.appendChild(style);
    say("Loading…");
  }
  function say(text, retry) {
    const m = document.createElement("div"); m.id = "boot-msg"; m.textContent = text;
    if (retry) { const b = document.createElement("button"); b.type = "button"; b.textContent = "Try again"; b.onclick = retry; m.append(" ", b); }
    document.body.replaceChildren(m);
  }
  // No workspace: the page stays as written; its held scripts run once, in order, then the load events they missed.
  let shown = false;
  async function showWritten() {
    if (shown) return;
    shown = true;
    for (const [s, type] of held) {
      if (!s.isConnected) continue;
      const node = document.createElement("script");
      Array.from(s.attributes).forEach(function (a) { node.setAttribute(a.name, a.value); });
      if (type === null) node.removeAttribute("type"); else node.setAttribute("type", type);
      node.textContent = s.textContent;
      const runs = type === null || /^\s*(|module|text\/javascript|application\/javascript)\s*$/i.test(type);
      if (runs && node.hasAttribute("src")) await new Promise(function (done) { node.onload = node.onerror = done; s.replaceWith(node); });
      else s.replaceWith(node);
    }
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    if (document.readyState === "complete") window.dispatchEvent(new Event("load"));
  }

  // ---- the workspace, read in one call
  const entry = ".page/index.html", dir = ".page/";
  const local = function (ref) { return !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref); };
  const resolve = function (ref) { const out = []; (dir + ref.split(/[?#]/)[0]).split("/").forEach(function (s) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }); return out.join("/"); };
  const stops = [];
  let added = [];
  const app = P.app = { version: null, onStop: function (fn) { stops.push(fn); }, reload: function () { if (shown) return Promise.resolve(); stop(); say("Loading…"); return load().catch(fail); } };
  function stop() { stops.splice(0).forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); added.forEach(function (n) { n.remove(); }); added = []; }
  async function read(paths, version) {
    const out = {};
    for (let ask = paths; ask.length;) {
      let r;
      for (let n = 0; ; n++) {
        try { r = await window.threadPage.invoke("syns.readMany", { paths: ask.slice(0, 64), version: version || undefined }); break; }
        catch (e) { if (n >= 3 || !/^(timeout|rate_limited|handler_error)$/.test(e.code || "")) throw e; await new Promise(function (ok) { setTimeout(ok, 1200 * (n + 1)); }); }
      }
      version = version || r.version;
      r.files.forEach(function (f) { out[f.path] = f; });
      ask = (r.deferred || []).concat(ask.slice(64));
    }
    return { files: out, version: version };
  }
  async function load() {
    if (!window.threadPage) return showWritten();
    let first;
    // Once the workspace has been shown, a reload that cannot read it is a failure, with Try again.
    try { first = await read([entry]); }
    catch (e) { if (app.version) throw e; return showWritten(); }
    const index = first.files[entry];
    if (!index || index.text === undefined) { if (app.version) throw new Error(entry + " is no longer in the repository"); return showWritten(); }
    if (!app.version) { clear(); listen(); }
    app.version = first.version;
    const doc = new DOMParser().parseFromString(index.text, "text/html");
    const styles = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"][href], style'));
    const scripts = Array.from(doc.querySelectorAll("script"));
    const wanted = styles.map(function (el) { return el.getAttribute("href"); }).concat(scripts.map(function (el) { return el.getAttribute("src"); })).filter(local).map(resolve);
    const files = wanted.length ? (await read(wanted, first.version)).files : {};
    const missing = wanted.filter(function (p) { return !files[p] || files[p].text === undefined; });
    if (missing.length) return say("The workspace names files that aren't in the repository: " + missing.join(", "));
    document.title = doc.title || document.title;
    styles.forEach(function (el) {
      const href = el.getAttribute("href"), node = document.createElement(el.tagName === "LINK" && !local(href) ? "link" : "style");
      if (node.tagName === "LINK") { node.rel = "stylesheet"; node.href = href; } else node.textContent = el.tagName === "STYLE" ? el.textContent : files[resolve(href)].text;
      document.head.appendChild(node); added.push(node);
    });
    Array.from(doc.body.attributes).forEach(function (a) { document.body.setAttribute(a.name, a.value); });
    scripts.forEach(function (s) { s.remove(); });
    document.body.replaceChildren.apply(document.body, Array.from(doc.body.childNodes).map(function (n) { return document.importNode(n, true); }));
    for (const s of scripts) {
      const node = document.createElement("script");
      Array.from(s.attributes).forEach(function (a) { if (a.name !== "src") node.setAttribute(a.name, a.value); });
      const src = s.getAttribute("src");
      if (src && !local(src)) { node.src = src; await new Promise(function (done) { node.onload = node.onerror = done; document.body.appendChild(node); }); }
      else { node.textContent = src ? files[resolve(src)].text + "\n//# sourceURL=" + resolve(src) : s.textContent; document.body.appendChild(node); }
    }
  }
  function fail(e) { console.error(e); say("The workspace didn't load: " + ((e && e.message) || e), function () { say("Loading…"); load().catch(fail); }); }
  document.addEventListener("DOMContentLoaded", function () { capture(); load().catch(fail); }, { once: true });
})();
`;
