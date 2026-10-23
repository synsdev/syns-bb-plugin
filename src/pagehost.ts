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
 *                                              with syns.* answered for that folder alone (threadPage.scope)
 *              { kind: "page", path, html? }   a document of the session's own page (html: the one this
 *                                              document is, as SynsPages.page has it; else read with pages.read)
 *     options  call(method, params)    the app's own invoke (default threadPage.invoke)
 *              sessionId               default: context.get
 *              onLink(target)          { kind: "external" | "repo" | "page", path | url, newTab }; default: external only
 *              onState(state)          { status: "loading" | "shown" | "failed", message, failures: [text] }
 *     f.reload()   f.changed(paths)   f.destroy()   f.frame (the iframe)   f.title()
 *
 *   SynsPages.page            the Thread Page this document is, taken before the app loaded (the bootstrap, at the end of this file)
 *   SynsPages.showPage(page)  a new version of SynsPages.page: the frames showing it take it (drafts and scroll kept)
 *   SynsPages.tools(paths)    the folders among the repository's paths that open as pages
 *   SynsPages.pageUrl(sessionId, path, fragment)   the host's address of a document of the page
 *   SynsPages.goTo(fromPath, path)                  this document goes to another document of the page
 *
 * In the frame: a window.threadPage of its own (invoke, watch, scope); storage.* per page; drafts and the
 * scroll position kept and restored; forms answering the session; links handed to onLink; hash-only
 * history calls as fragment navigations. Calls the frame may make: syns.*, storage.*, context, session,
 * navigation and confirmed session calls; anything else is refused.
 */
(function () {
  "use strict";
  if (window.SynsPages && window.SynsPages.frame) return;
  const P = (window.SynsPages = window.SynsPages || {});
  const dirOf = function (p) { const i = String(p).lastIndexOf("/"); return i < 0 ? "" : String(p).slice(0, i + 1); };
  const baseOf = function (p) { return String(p).replace(/\/+$/, "").replace(/^.*\//, ""); };

  const SYNS = ["syns.repo", "syns.whoami", "syns.ls", "syns.glob", "syns.grep", "syns.read", "syns.readMany", "syns.readBinary",
    "syns.history", "syns.diff", "syns.write", "syns.writeBinary", "syns.edit", "syns.rm", "syns.move", "syns.commit", "syns.revert"];
  const PASS = ["context.get", "session.reply", "session.activity", "session.messages", "sessions.snapshot", "sessions.start",
    "sessions.openHost", "pages.open", "pages.read", "navigation.openExternal", "providers.list", "workspaces.list"];
  const CACHED = { "syns.repo": 4000, "syns.whoami": 60000, "context.get": 10000 };
  const cache = {};

  // Storage keys are [A-Za-z0-9._:-], 128 at most: a source is named by a short hash.
  const hash = function (s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };
  const nsKey = function (id, key) { return ("f." + hash(id) + ":" + String(key)).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128); };

  // ------------------------------------------------------------------ inside the frame
  const SHIM = function (cfg) {
    var n = 0, wait = {}, post = function (m) { parent.postMessage(m, "*"); };
    addEventListener("message", function (e) {
      var d = e.data; if (e.source !== parent || !d) return;
      if (d.__tool === "formdone") return formDone(d);
      if (d.__tool !== "answer" || !wait[d.id]) return;
      var w = wait[d.id]; delete wait[d.id];
      if (d.ok) w[0](d.result); else { var x = new Error(d.error.message || d.error.code); x.code = d.error.code; x.reason = d.error.reason; x.detail = d.error.detail; w[1](x); }
    });
    function invoke(method, params) { return new Promise(function (ok, no) { var id = ++n; wait[id] = [ok, no]; post({ __tool: "invoke", id: id, method: method, params: params || {} }); }); }
    function watch(method, params, cb, o) {
      var ms = Math.min(300000, Math.max(2000, (o && o.intervalMs) || 8000)), live = true, t;
      (function tick() { invoke(method, params).then(function (v) { if (live) cb(v, null); }, function (e) { if (live) cb(null, e); }).then(function () { if (live) t = setTimeout(tick, ms); }); })();
      return function () { live = false; clearTimeout(t); };
    }
    // A srcdoc document can't push or replace a URL of its own: a hash-only one becomes a fragment navigation.
    ["pushState", "replaceState"].forEach(function (k) {
      var o = history[k].bind(history);
      history[k] = function (st, t, u) {
        try { return o(st, t, u); } catch (e) {
          if (typeof u === "string" && u.charAt(0) === "#") { location.hash = u; return; } // location.replace would leave about:srcdoc
          throw e;
        }
      };
    });
    window.threadPage = Object.freeze({ version: 1, scope: cfg.scope, invoke: invoke, watch: watch,
      setDirty: function (on) { post({ __tool: "dirty", on: !!on }); }, setScope: function () {}, embed: function () { return function () {}; } });
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a[href]"); if (!a || e.defaultPrevented || a.hasAttribute("download") || /^(#|blob:|data:|javascript:)/i.test(a.getAttribute("href"))) return;
      e.preventDefault(); post({ __tool: "link", href: a.getAttribute("href"), newTab: e.metaKey || e.ctrlKey || a.target === "_blank" });
    });

    // ---- drafts, as Thread Pages keeps them: fields by id, else name; never passwords, files or autocomplete="off"
    var drafted = function (el) {
      if (!el.matches || !el.matches("input, textarea, select") || el.disabled) return false;
      var t = (el.type || "").toLowerCase(), ac = (el.getAttribute("autocomplete") || "").toLowerCase(), f = el.form;
      if (/^(password|file|hidden|submit|button|reset|image)$/.test(t)) return false;
      if (/^(off|current-password|new-password|one-time-code)$/.test(ac) || (f && (f.getAttribute("autocomplete") || "") === "off")) return false;
      return !!(el.id || el.name);
    };
    var keyOf = function (el) { var t = (el.type || "").toLowerCase(); var k = el.id || el.name; return (t === "radio" || t === "checkbox") && !el.id ? k + "=" + el.value : k; };
    var collect = function () {
      var out = {};
      document.querySelectorAll("input, textarea, select").forEach(function (el) {
        if (!drafted(el)) return; var t = (el.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") { if (el.checked !== el.defaultChecked) out[keyOf(el)] = el.checked; }
        else if (el.tagName === "SELECT" && el.multiple) { out[keyOf(el)] = Array.from(el.selectedOptions).map(function (o) { return o.value; }); }
        else if (el.value !== el.defaultValue) out[keyOf(el)] = el.value;
      });
      return out;
    };
    var draftTimer = null;
    var saveDraft = function () { clearTimeout(draftTimer); draftTimer = setTimeout(function () { post({ __tool: "draft", values: collect() }); }, 400); };
    document.addEventListener("input", saveDraft, true);
    document.addEventListener("change", saveDraft, true);
    var restore = function () {
      var d = cfg.draft || {};
      document.querySelectorAll("input, textarea, select").forEach(function (el) {
        if (!drafted(el) || !(keyOf(el) in d)) return;
        var v = d[keyOf(el)], t = (el.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") { if (el.checked !== el.defaultChecked) return; el.checked = !!v; }
        else if (el.tagName === "SELECT" && el.multiple) { Array.from(el.options).forEach(function (o) { o.selected = v.indexOf(o.value) >= 0; }); }
        else { if (el.value !== el.defaultValue) return; el.value = v; } // a field the page's script already filled is kept
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (cfg.scrollY) scrollTo(0, cfg.scrollY);
    };
    addEventListener("load", function () { restore(); setTimeout(restore, 300); });
    var scrollTimer = null;
    addEventListener("scroll", function () { clearTimeout(scrollTimer); scrollTimer = setTimeout(function () { post({ __tool: "scroll", y: Math.round(scrollY) }); }, 300); }, { passive: true });

    // ---- forms: every form answers the session, as on a Thread Page, unless its own script owns it
    var labelOf = function (el) {
      var fs = el.closest("fieldset"), lg = fs && fs.querySelector("legend"), t = (el.type || "").toLowerCase();
      var wrap = el.closest("label"), forL = el.id && document.querySelector('label[for="' + el.id + '"]');
      var text = function (x) { return x ? x.textContent.replace(/\s+/g, " ").trim() : ""; };
      if (el.getAttribute("data-label")) return el.getAttribute("data-label");
      if ((t === "radio" || t === "checkbox") && lg) return text(lg);
      return text(lg) || el.getAttribute("aria-label") || text(wrap) || text(forL) || el.name || "Answer";
    };
    var sending = null;
    document.addEventListener("submit", function (e) {
      var f = e.target; if (e.defaultPrevented || f.hasAttribute("data-thread-page-manual") || f.method === "dialog") return;
      e.preventDefault(); if (sending) return;
      var groups = {}, order = [];
      Array.from(f.elements).forEach(function (el) {
        var t = (el.type || "").toLowerCase();
        if (!el.name && !el.id || /^(submit|button|reset|image|file|hidden)$/.test(t) || el.tagName === "FIELDSET" || el.tagName === "BUTTON") return;
        var k = t === "radio" || t === "checkbox" ? "g:" + el.name : "f:" + (el.id || el.name);
        if (!groups[k]) { groups[k] = { label: labelOf(el), kind: t, items: [] }; order.push(k); }
        groups[k].items.push(el);
      });
      var answers = order.map(function (k) {
        var g = groups[k], v;
        if (g.kind === "checkbox") v = g.items.length === 1 ? (g.items[0].checked ? "Yes" : "No") : g.items.filter(function (x) { return x.checked; }).map(function (x) { return x.value; }).join(", ");
        else if (g.kind === "radio") { var c = g.items.filter(function (x) { return x.checked; })[0]; v = c ? c.value : ""; }
        else if (g.items[0].tagName === "SELECT" && g.items[0].multiple) v = Array.from(g.items[0].selectedOptions).map(function (o) { return o.value; }).join(", ");
        else v = g.items[0].value;
        return { label: g.label, value: String(v).trim() ? String(v) : "(left blank)" };
      });
      sending = f; Array.from(f.elements).forEach(function (el) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; });
      post({ __tool: "form", title: f.getAttribute("aria-label") || (f.querySelector("h1,h2,legend") || {}).textContent || document.title, action: e.submitter && e.submitter.value || null, answers: answers });
    });
    function formDone(d) {
      var f = sending; sending = null; if (!f) return;
      Array.from(f.elements).forEach(function (el) { el.disabled = el.dataset.wasDisabled === "1"; });
      var line = f.querySelector(".tp-status") || f.appendChild(Object.assign(document.createElement("p"), { className: "tp-status" }));
      line.style.cssText = "font-size:13px;opacity:.75;margin:8px 0 0";
      line.textContent = d.ok ? "Sent" : "Not sent: " + (d.message || "");
      if (d.ok) post({ __tool: "draft", values: collect(), sent: true });
    }
  };

  const safeScript = function (t) { return String(t).replace(/<\/(script)/gi, "<\\/$1").replace(/<!(?=--)/g, "<\\!"); };
  const local = function (ref) { return !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref); };
  const join = function (dir, ref) {
    const out = [];
    (dir + "/" + ref.split(/[?#]/)[0]).split("/").forEach(function (s) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); });
    return out.join("/");
  };

  const live = new Set();
  class PageFrame {
    constructor(container, src, options) {
      this.src = Object.assign({}, src);
      this.opts = options || {};
      this.invoke = this.opts.call || function (m, p) { return window.threadPage.invoke(m, p); };
      this.id = src.kind === "repo" ? "repo:" + src.folder : "page:" + src.path;
      this.folder = src.kind === "repo" ? String(src.folder).replace(/\/+$/, "") : "";
      this.failures = [];
      this.state = { draft: {}, scrollY: 0 };
      this.stateKey = nsKey(this.id, "state");
      this.frame = document.createElement("iframe");
      this.frame.title = this.title();
      this.frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads allow-popups");
      Object.assign(this.frame.style, { flex: "1", width: "100%", height: "100%", border: "0", display: "none", background: "transparent" });
      container.appendChild(this.frame);
      live.add(this);
      this.onMessage = (e) => this.answer(e);
      window.addEventListener("message", this.onMessage);
      if (src.kind === "page" && !src.html) this.poll = setInterval(() => this.checkPage(), 4000);
      this.start();
    }
    title() { return this.src.title || (this.src.kind === "repo" ? baseOf(this.folder) : baseOf(this.src.path).replace(/\.html?$/i, "")); }
    entry() { return this.src.kind === "repo" ? this.folder + "/" + (this.src.doc || "index.html") : this.src.path; }
    destroy() { this.dead = true; live.delete(this); clearInterval(this.poll); window.removeEventListener("message", this.onMessage); this.frame.remove(); }
    reload() { this.dirty = false; return this.load(); }
    /** Repository paths that changed: a tool reloads when one is in its folder. */
    changed(paths) { if (this.src.kind === "repo" && !this.dead && (paths || []).some((p) => String(p).startsWith(this.folder + "/"))) this.load(); }
    report(status, message) { if (this.opts.onState) this.opts.onState({ status: status, message: message || "", failures: this.failures.slice() }); }
    async session() { if (!this.sessionId) this.sessionId = this.opts.sessionId || ((await this.invoke("context.get", {})).session || {}).id; return this.sessionId; }
    async start() {
      try { const r = await this.invoke("storage.get", { key: this.stateKey }); if (r && r.found && r.value && typeof r.value === "object") this.state = Object.assign(this.state, r.value); } catch (e) { /* none kept */ }
      this.load();
    }
    saveState() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.invoke("storage.set", { key: this.stateKey, value: this.state }).catch(() => {}), 800); }

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
        const doc = new DOMParser().parseFromString(text, "text/html");
        doc.querySelectorAll("script[data-thread-page-kernel], script[data-thread-page-contributor], base").forEach((el) => el.remove()); // the host's kernel, page scripts and base: this frame has its own
        const refs = this.src.kind === "page" ? [] : Array.from(doc.querySelectorAll('link[rel="stylesheet"][href], script[src]'))
          .filter((el) => local(el.getAttribute("href") || el.getAttribute("src")));
        const want = refs.map((el) => join(dir, el.getAttribute("href") || el.getAttribute("src")));
        const got = await this.readAll(want, version);
        refs.forEach((el, i) => {
          const t = got[want[i]] || "";
          if (el.tagName === "LINK") { const s = doc.createElement("style"); s.textContent = t; el.replaceWith(s); }
          else { el.removeAttribute("src"); el.textContent = safeScript(t) + "\n//# sourceURL=" + want[i]; }
        });
        doc.querySelectorAll("script:not([src])").forEach((s) => { s.textContent = safeScript(s.textContent); });
        const shim = doc.createElement("script");
        shim.textContent = "(" + SHIM.toString() + ")(" + JSON.stringify({ scope: this.src.kind === "repo" ? this.folder : null, draft: this.state.draft, scrollY: this.state.scrollY }).replace(/</g, "\\u003c") + ");";
        doc.head.prepend(shim);
        if (this.dead) return;
        this.frame.srcdoc = "<!doctype html>\n" + doc.documentElement.outerHTML;
        this.frame.style.display = "";
        this.report("shown");
      } catch (e) {
        this.frame.style.display = "none";
        this.report("failed", String(e && e.message || e));
      }
    }
    // A page read with pages.read reloads when the agent saves it (drafts and scroll come back with it).
    async checkPage() {
      if (this.dead || !this.frame.isConnected || this.frame.offsetParent === null || document.visibilityState !== "visible" || !this.revision) return;
      try {
        const r = await this.invoke("pages.read", { pages: [{ sessionId: await this.session(), path: this.src.path, ifNoneMatch: this.revision }] });
        const e = r.pages[0] || {};
        if (!e.unchanged && e.revision && e.revision !== this.revision) this.load();
      } catch (e) { /* gone or busy: keep what is shown */ }
    }

    // ---- what the frame asks
    answer(e) {
      if (e.source !== this.frame.contentWindow || !e.data || !e.data.__tool) return;
      const d = e.data, win = this.frame.contentWindow, reply = (msg) => win && win.postMessage(Object.assign({ __tool: "answer", id: d.id }, msg), "*");
      if (d.__tool === "invoke") {
        this.call(d.method, d.params || {}).then((result) => reply({ ok: true, result: result }), (x) => {
          this.failures.push(d.method + ": " + (x.code || "") + (x.reason ? " (" + x.reason + ")" : "") + " " + String(x.message || x).slice(0, 160));
          this.report("shown");
          reply({ ok: false, error: { code: x.code || "unavailable", reason: x.reason, detail: x.detail, message: String(x.message || x) } });
        });
      } else if (d.__tool === "link") this.link(String(d.href || ""), !!d.newTab);
      else if (d.__tool === "dirty") this.dirty = !!d.on;
      else if (d.__tool === "draft") { this.state.draft = d.sent ? {} : (d.values || {}); this.saveState(); }
      else if (d.__tool === "scroll") { this.state.scrollY = d.y || 0; this.saveState(); }
      else if (d.__tool === "form") {
        const lines = ["**" + String(d.title || this.title()).trim() + "**" + (this.src.kind === "page" ? " (page " + this.src.path + ")" : " (tool " + this.folder + ")")];
        if (d.action) lines.push("Action: " + d.action);
        (d.answers || []).forEach((a) => lines.push("- " + a.label + ": " + a.value));
        this.invoke("session.reply", { kind: "prompt", text: lines.join("\n") })
          .then(() => win && win.postMessage({ __tool: "formdone", ok: true }, "*"), (x) => win && win.postMessage({ __tool: "formdone", ok: false, message: String(x.message || x) }, "*"));
      }
    }
    async call(method, params) {
      const repo = this.src.kind === "repo";
      if (CACHED[method] && !params.version) {
        const c = cache[method];
        if (!c || Date.now() - c.at >= CACHED[method]) { const value = this.invoke(method, params); cache[method] = { at: Date.now(), value: value }; value.catch(() => { delete cache[method]; }); }
        return cache[method].value;
      }
      if (PASS.includes(method)) return this.invoke(method, params);
      if (method === "storage.get" || method === "storage.set") return this.invoke(method, Object.assign({}, params, { key: nsKey(this.id, params.key) }));
      if (method === "storage.setMany") return this.invoke(method, { entries: (params.entries || []).map((x) => Object.assign({}, x, { key: nsKey(this.id, x.key) })) });
      if (!SYNS.includes(method)) throw Object.assign(new Error(method + " isn't available here"), { code: "unavailable" });
      // A tool's calls carry its folder as scope: the plugin counts its paths from there and answers nothing outside it.
      const p = repo ? Object.assign({}, params, { scope: this.folder }) : params;
      // Reads that fail transiently (many at once, the CLI busy) are asked again, twice at most.
      const write = /^syns\.(write|writeBinary|edit|rm|move|commit|revert)$/.test(method);
      for (let n = 0; ; n++) {
        try { return await this.invoke(method, p); }
        catch (x) { if (write || n >= 2 || !/^(handler_error|timeout|rate_limited)$/.test(x.code || "")) throw x; await new Promise((ok) => setTimeout(ok, 600 * (n + 1))); }
      }
    }
    // Where a link goes, for the app to open: another site, a repository file, a document of the page.
    link(href, newTab) {
      const go = this.opts.onLink || ((t) => { if (t.kind === "external") this.invoke("navigation.openExternal", { url: t.url }).catch(() => {}); });
      if (/^https?:/i.test(href)) return go({ kind: "external", url: href, newTab: true });
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
    live.forEach(function (f) { if (f.src.kind === "page" && f.src.html !== undefined && f.src.path === page.path) { f.src.html = page.html || "<html></html>"; f.reload(); } });
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
 * repository yet, or no syns.* here, as in an embed) the page stays as written and its scripts run. Once the workspace
 * is shown, a saved page is taken through threadPage.onPageUpdate where the host offers it: only the agent's page
 * (SynsPages.page and its frame) changes, with no new boot; without it the host loads the saved page as before.
 *   SynsPages.app   { version, reload(), onStop(fn) }   an in-page reload: stop the app, read it again, start it.
 */
(function () {
  "use strict";
  const P = window.SynsPages;
  if (P.page || !document.currentScript || document.readyState !== "loading") return;
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
  function clear() {
    const kernel = document.querySelector("script[data-thread-page-kernel]");
    Array.from(document.head.children).forEach(function (el) { if (el !== kernel && el.tagName !== "META") el.remove(); });
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
