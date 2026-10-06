import { describe, expect, it } from "vitest";
import { buildArgs, type RunRequest } from "../src/cli.js";
import { METHODS } from "../src/methods/index.js";
import { ok, rec } from "./fake-runner.js";
import { SAMPLES, failureOf, harness, resultOf } from "./harness.js";

/**
 * 0.6.0, the page surface as a thin adapter over the CLI (spec 06, D49, D59):
 * each method is one CLI command run in the page's scope folder, its JSON
 * passed on, its refusals the CLI's.
 */

const argsOf = (h: ReturnType<typeof harness>) => h.runner.calls.filter((call) => call.args[0] !== "--version").map((call) => call.args);
const NEW = ["syns.shareInfo", "syns.share", "syns.unshare", "syns.folderVisibility", "syns.repoVisibility", "syns.collaborators", "syns.collaboratorAdd", "syns.collaboratorRole", "syns.collaboratorRemove", "syns.enableChecks", "syns.explore", "syns.users"];
/** Every reply a new method could need, by verb; collaborators told apart by subcommand. */
const ANY = {
  share: (request: RunRequest) => rec(request.args.includes("--show") ? "share.show.shared.0313" : request.args.some((arg) => arg.startsWith("--visibility")) ? "share.visibility.0313" : "share.created.0313"),
  unshare: rec("unshare.kept.0313"),
  repo: rec("repo.visibility.0313"),
  "enable-checks": rec("enable-checks.none.0313"),
  explore: rec("explore.ok"),
  users: rec("users.ok"),
  collaborators: (request: RunRequest) => rec(({ add: "collaborators.add.ok", role: "collaborators.role.ok", remove: "collaborators.remove.ok" } as Record<string, string>)[request.args[1] ?? ""] ?? "collaborators.one"),
};

describe("the page surface (S6.1–S6.3, A62, A63)", () => {
  it("runs only the verbs, collaborators subcommands and repo flags spec 06 allows; nothing marked no or later", async () => {
    const seen = new Set<string>();
    for (const method of METHODS) {
      const h = harness({ ...ANY, cat: rec("cat.ok"), ls: rec("ls.ok"), history: rec("history.ok"), commit: rec("write.ok"), read: rec("read.ok"), glob: rec("glob.ok"), grep: rec("grep.content.ok"), diff: rec("diff.ok"), write: rec("write.ok"), edit: rec("write.ok"), rm: rec("write.ok"), revert: rec("write.ok"), whoami: rec("whoami.ok"), place: rec("place.ok"), status: rec("status.clean") });
      await h.call(method.name, SAMPLES[method.name]);
      for (const call of h.runner.calls) {
        const [verb, sub] = call.args;
        seen.add(verb === "collaborators" && sub && !sub.startsWith("-") ? `${verb} ${sub}` : verb === "repo" ? `repo ${call.args.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0]).sort().join(" ")}` : verb!);
      }
    }
    const allowed = ["--version", "repo --json", "repo --json --visibility", "whoami", "ls", "cat", "read", "glob", "grep", "history", "diff", "write", "edit", "rm", "commit", "revert", "place", "status", "share", "unshare", "collaborators", "collaborators add", "collaborators role", "collaborators remove", "enable-checks", "explore", "users"];
    for (const one of seen) expect(allowed, one).toContain(one);
    for (const never of ["login", "logout", "upgrade", "delete", "push", "pull", "sync", "resolution", "fork", "repos", "teams", "links", "user", "forks"]) expect(seen.has(never), never).toBe(false);
  });

  it("each new method runs exactly one CLI command, besides the minute-held --version, in the session's folder", async () => {
    for (const name of NEW) {
      const h = harness(ANY);
      expect((await h.call(name, SAMPLES[name])).ok, name).toBe(true);
      const runs = h.runner.calls.filter((call) => call.args[0] !== "--version");
      expect(runs, name).toHaveLength(1);
      expect(runs[0]!.cwd, name).toBe("/work/checkout");
    }
  });

  it("runs in the document's scope folder when one is set (S6.3)", async () => {
    const ROOT = { owner: "acme", name: "work", commitSha: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837", version: 5, role: "owner", visibility: "private", fileCount: 40 };
    const h = harness({ share: rec("share.show.shared.0313"), repo: (request: RunRequest) => ok(request.cwd === "/work/checkout" ? ROOT : { ...ROOT, holder: "acme/work", path: "q3-plan" }) });
    const answer = await h.invoke({ method: "syns.shareInfo", params: {}, caller: { sessionId: "thr_page", scope: "q3-plan" }, requestId: "r" });
    expect(answer.ok).toBe(true);
    expect(h.runner.calls.find((call) => call.args[0] === "share")!.cwd).toBe("/work/checkout/q3-plan");
  });
});

describe("sharing a placed folder", () => {
  it("shareInfo: share --show on ., the CLI's fields passed on, holderRole and record included", async () => {
    const h = harness({ share: rec("share.show.shared.0313") });
    expect(resultOf(await h.call("syns.shareInfo"))).toEqual({
      holder: "acme/vela-workspace", path: "q3-plan", holderRole: "owner", shared: true,
      owner: "acme", name: "q3-plan", visibility: "private", role: "owner", sharedFolder: true, status: "active", description: null, heldIn: { owner: "acme", name: "vela-workspace", path: "q3-plan" },
    });
    expect(argsOf(h)).toEqual([["share", "--show", "--json", "--", "."]]);
  });
  it("shareInfo of an unshared folder: offeredName, no record", async () => {
    expect(resultOf(await harness({ share: rec("share.show.unshared") }).call("syns.shareInfo"))).toEqual({ holder: "acme/work", holderRole: "owner", path: "docs", shared: false, offeredName: "work-docs" });
  });
  it("share: the name given, and created as the CLI says it", async () => {
    const h = harness({ share: rec("share.created.0313") });
    expect(resultOf(await h.call("syns.share", { name: "q3-plan" }))).toMatchObject({ owner: "acme", name: "q3-plan", holder: "acme/vela-workspace", path: "q3-plan", created: true });
    expect(argsOf(h)).toEqual([["share", "--name=q3-plan", "--json", "--", "."]]);
  });
  it("share with no name lets the CLI offer one; a second share is created false", async () => {
    const h = harness({ share: rec("share.again") });
    expect(resultOf(await h.call("syns.share"))).toMatchObject({ created: false });
    expect(argsOf(h)).toEqual([["share", "--json", "--", "."]]);
  });
  it("leaves the name to the CLI's rule: bad_name and name_taken are its answers (A65, A66)", async () => {
    expect(failureOf(await harness({ share: rec("share.bad-name") }).call("syns.share", { name: "Con" }))).toMatchObject({ code: "invalid_params", reason: "bad_name" });
    expect(failureOf(await harness({ share: rec("share.name-taken") }).call("syns.share", { name: "taken" }))).toMatchObject({ code: "conflict", reason: "name_taken" });
  });
  it("unshare: --yes, since the CLI asks on standard input without it; retired passed on as the CLI reports it (A67)", async () => {
    const h = harness({ unshare: rec("unshare.kept.0313") });
    expect(resultOf(await h.call("syns.unshare"))).toEqual({ owner: "acme", name: "q3-plan", holder: "acme/vela-workspace", path: "q3-plan", unshared: true, retired: false });
    expect(argsOf(h)).toEqual([["unshare", "--yes", "--json", "--", "."]]);
    expect(resultOf(await harness({ unshare: rec("unshare.ok") }).call("syns.unshare"))).not.toHaveProperty("retired");
  });
  it("unshare of a folder not shared is the CLI's 404: not_found, no pre-check", async () => {
    const h = harness({ unshare: rec("not-found-404"), repo: rec("repo.ok") });
    expect(failureOf(await h.call("syns.unshare"))).toMatchObject({ code: "not_found" });
    expect(argsOf(h).map((args) => args[0])).toEqual(["unshare", "repo"]);
  });
  it("at a repository's root the folder commands are refused by the CLI: bad_scope (A64)", async () => {
    for (const name of ["syns.shareInfo", "syns.share", "syns.unshare", "syns.folderVisibility"]) {
      const h = harness({ share: rec("share.root-dot.0313"), unshare: rec("share.root-dot.0313") });
      expect(failureOf(await h.call(name, SAMPLES[name])), name).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
    }
    expect(failureOf(await harness({ "enable-checks": rec("enable-checks.root.0313") }).call("syns.enableChecks"))).toMatchObject({ reason: "bad_scope" });
  });
  it("cli_too_old below 0.3.11 for sharing, below 0.3.12 for a folder's visibility", async () => {
    const at = (version: string) => harness({ "--version": { exitCode: 0, stdout: `syns ${version}\n`, stderr: "", timedOut: false, spawnError: null, overflowed: false }, share: rec("share.visibility.0313") });
    expect(failureOf(await at("0.3.10").call("syns.share"))).toMatchObject({ reason: "cli_too_old", detail: { need: "0.3.11", have: "0.3.10" } });
    expect(failureOf(await at("0.3.11").call("syns.folderVisibility", { visibility: "public" }))).toMatchObject({ reason: "cli_too_old", detail: { need: "0.3.12", have: "0.3.11" } });
    expect((await at("0.3.12").call("syns.folderVisibility", { visibility: "public" })).ok).toBe(true);
  });
});

describe("visibility (A68)", () => {
  it("folderVisibility: share --visibility on ., with a name for a first marking", async () => {
    const h = harness({ share: rec("share.visibility.0313") });
    expect(resultOf(await h.call("syns.folderVisibility", { visibility: "public", name: "q3-plan" }))).toMatchObject({ owner: "acme", name: "q3-plan", visibility: "private", holder: "acme/vela-workspace", path: "q3-plan" });
    expect(argsOf(h)).toEqual([["share", "--visibility=public", "--name=q3-plan", "--json", "--", "."]]);
  });
  it("repoVisibility: repo --visibility, the CLI's record passed on", async () => {
    const h = harness({ repo: rec("repo.visibility.0313") });
    expect(resultOf(await h.call("syns.repoVisibility", { visibility: "private" }))).toEqual({ owner: "acme", name: "vela-workspace", visibility: "private", role: "owner", sharedFolder: false, status: "draft", description: "A workspace" });
    expect(argsOf(h)).toEqual([["repo", "--visibility=private", "--json"]]);
  });
  it("repoVisibility in a placed folder is the CLI's holder root required: bad_scope", async () => {
    expect(failureOf(await harness({ repo: rec("repo.visibility.holder-root.0313") }).call("syns.repoVisibility", { visibility: "public" }))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
  });
  it("takes only the CLI's two values", async () => {
    expect(failureOf(await harness().call("syns.folderVisibility", { visibility: "internal" }))).toMatchObject({ code: "invalid_params" });
  });
});

describe("the scope's people (A65, A69)", () => {
  it("collaborators: the CLI's list, limit and offset passed through", async () => {
    const h = harness({ collaborators: rec("collaborators.one") });
    expect(resultOf(await h.call("syns.collaborators", { limit: 20, offset: 40 }))).toEqual({ total: 1, limit: 100, offset: 0, data: [{ user: { id: "usr_dana0001", username: "dana", name: "Dana Reader", email: "dana@example.test", image: null }, role: "read", createdAt: "2026-10-03T17:30:00.000Z" }] });
    expect(argsOf(h)).toEqual([["collaborators", "--limit=20", "--offset=40", "--json"]]);
  });
  it("in a placed folder the CLI answers holder root required: bad_scope, until the CLI addresses the folder's identity there (D59)", async () => {
    for (const name of ["syns.collaborators", "syns.collaboratorAdd", "syns.collaboratorRole", "syns.collaboratorRemove"]) {
      expect(failureOf(await harness({ collaborators: rec("collaborators.holder-root.0313") }).call(name, SAMPLES[name])), name).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
    }
  });
  it("add: by username or e-mail, any of the CLI's roles, admin included", async () => {
    const h = harness({ collaborators: rec("collaborators.add.ok") });
    expect(resultOf(await h.call("syns.collaboratorAdd", { user: "dana@example.test", role: "admin" }))).toEqual({ added: true, target: "dana", role: "read" });
    expect(argsOf(h)).toEqual([["collaborators", "add", "--role=admin", "--json", "--", "dana@example.test"]]);
  });
  it("the CLI's refusals come back: no_such_user, already_collaborator, not_permitted, and its own words for the rest", async () => {
    expect(failureOf(await harness({ collaborators: rec("collaborators.no-user") }).call("syns.collaboratorAdd", { user: "nobody", role: "read" }))).toMatchObject({ code: "not_found", reason: "no_such_user" });
    expect(failureOf(await harness({ collaborators: rec("share.name-taken") }).call("syns.collaboratorAdd", { user: "dana", role: "read" }))).toMatchObject({ code: "conflict", reason: "already_collaborator" });
    expect(failureOf(await harness({ collaborators: rec("collaborators.forbidden") }).call("syns.collaboratorRole", { id: "usr_dana0001", role: "write" }))).toMatchObject({ code: "unavailable", reason: "not_permitted" });
    const refused = failureOf(await harness({ collaborators: rec("server-422") }).call("syns.collaboratorAdd", { user: "dana", role: "admin" }));
    expect(refused).toMatchObject({ code: "handler_error", message: "server error (422): validation_error" });
    expect(refused).not.toHaveProperty("reason");
  });
  it("role and remove pass the page's id as the CLI takes it, remove with --yes; nothing is looked up", async () => {
    const h = harness({ collaborators: (request: RunRequest) => rec(request.args[1] === "role" ? "collaborators.role.ok" : "collaborators.remove.ok") });
    expect(resultOf(await h.call("syns.collaboratorRole", { id: "usr_dana0001", role: "write" }))).toEqual({ user: { id: "usr_dana0001", username: "dana", name: "Dana Reader", email: "dana@example.test", image: null }, role: "write", createdAt: "2026-10-03T17:30:00.000Z" });
    expect(resultOf(await h.call("syns.collaboratorRemove", { id: "usr_dana0001" }))).toEqual({ removed: true, userId: "usr_dana0001" });
    expect(argsOf(h)).toEqual([
      ["collaborators", "role", "--role=write", "--json", "--", "usr_dana0001"],
      ["collaborators", "remove", "--yes", "--json", "--", "usr_dana0001"],
    ]);
  });
  it("a removal of someone holding no grant is the CLI's 404: not_found", async () => {
    expect(failureOf(await harness({ collaborators: rec("not-found-404"), repo: rec("repo.ok") }).call("syns.collaboratorRemove", { id: "usr_nobody" }))).toMatchObject({ code: "not_found" });
  });
  it("users: the CLI's search, its fields passed on", async () => {
    const h = harness({ users: rec("users.ok") });
    expect(resultOf(await h.call("syns.users", { query: "dana", limit: 5 }))).toEqual({ data: [{ id: "usr_dana0001", username: "dana", name: "Dana Reader", image: "https://example.test/dana.png" }] });
    expect(argsOf(h)).toEqual([["users", "--limit=5", "--json", "--", "dana"]]);
  });
});

describe("checks and templates", () => {
  it("enableChecks: enable-checks in the folder, the page's provenance in SYNS_*, D12's version and number (A70)", async () => {
    const h = harness({ "enable-checks": rec("enable-checks.ok.0313") });
    expect(resultOf(await h.call("syns.enableChecks"))).toEqual({ holder: "acme/vela-workspace", path: "q3-plan", enabled: ["true"], version: "0f4364fec57226e534c41e91f5e0b63dc655a452", number: 9 });
    const run = h.runner.calls.find((call) => call.args[0] === "enable-checks")!;
    expect(run.args).toEqual(buildArgs("enable-checks"));
    expect(run.env).toEqual({ SYNS_INTEGRATION: "syns-bb-plugin", SYNS_RUN: "thr_page", SYNS_TRIGGER: "thread-page" });
  });
  it("enableChecks with nothing waiting: enabled [], no version; the CLI's own guard: checkout_dirty", async () => {
    expect(resultOf(await harness({ "enable-checks": rec("enable-checks.none.0313") }).call("syns.enableChecks"))).toEqual({ holder: "acme/vela-workspace", path: "q3-plan", enabled: [] });
    expect(failureOf(await harness({ "enable-checks": rec("enable-checks.dirty.0313") }).call("syns.enableChecks"))).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
  });
  it("explore: query, every tag, status, limit and offset as the CLI takes them; its rows' fields passed on (A71)", async () => {
    const h = harness({ explore: rec("explore.ok") });
    const result = resultOf(await h.call("syns.explore", { query: "board", tags: ["syns-app", "kind-whiteboard"], status: "draft", limit: 1, offset: 0 }));
    expect(result).toEqual({ total: 2, limit: 1, offset: 0, data: [{ owner: "acme", name: "whiteboard-template", description: "A whiteboard as a Syns app template", tags: ["syns-app", "kind-whiteboard"], status: "draft", visibility: "public", fileCount: 35, forkCount: 1, updatedAt: "2026-10-06T04:04:23.369Z" }] });
    expect(argsOf(h)).toEqual([["explore", "--query=board", "--tag=syns-app", "--tag=kind-whiteboard", "--status=draft", "--limit=1", "--offset=0", "--json"]]);
  });
});

describe("fix round 1 (review thr_2sffsq2zs6)", () => {
  const ROOT = { owner: "acme", name: "work", commitSha: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837", version: 5, role: "owner", visibility: "private", fileCount: 40 };
  const scopedReplies = {
    ...ANY,
    repo: (request: RunRequest) => (request.args.some((arg) => arg.startsWith("--visibility")) ? rec("repo.visibility.0313") : ok(request.cwd === "/work/checkout" ? ROOT : { ...ROOT, holder: "acme/work", path: "q3-plan" })),
  };

  it("every one of the twelve runs its command in the document's scope folder; none is atRoot (finding 5)", async () => {
    for (const name of NEW) {
      expect(METHODS.find((method) => method.name === name)!.atRoot, name).toBeUndefined();
      const h = harness(scopedReplies);
      const answer = await h.invoke({ method: name, params: SAMPLES[name], caller: { sessionId: "thr_page", scope: "q3-plan" }, requestId: "r" });
      expect(answer.ok, name).toBe(true);
      const own = h.runner.calls.filter((call) => call.args[0] !== "--version" && !(call.args[0] === "repo" && call.args.length === 2));
      expect(own.map((call) => call.cwd), name).toEqual(["/work/checkout/q3-plan"]);
    }
  });

  it("a value beginning with - stays a value: after --, or inside --option=value (finding 5)", async () => {
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["syns.collaboratorAdd", { user: "--repo=x", role: "read" }, ["collaborators", "add", "--role=read", "--json", "--", "--repo=x"]],
      ["syns.collaboratorRole", { id: "--yes", role: "read" }, ["collaborators", "role", "--role=read", "--json", "--", "--yes"]],
      ["syns.collaboratorRemove", { id: "-y" }, ["collaborators", "remove", "--yes", "--json", "--", "-y"]],
      ["syns.users", { query: "--server=http://x" }, ["users", "--json", "--", "--server=http://x"]],
      ["syns.share", { name: "--repo=x" }, ["share", "--name=--repo=x", "--json", "--", "."]],
      ["syns.explore", { query: "-q", tags: ["--if-repo"] }, ["explore", "--query=-q", "--tag=--if-repo", "--json"]],
    ];
    for (const [name, params, args] of cases) {
      const h = harness(ANY);
      await h.call(name, params);
      expect(argsOf(h), name).toEqual([args]);
    }
  });

  it("no run of any method carries --repo, --server or --if-repo as a flag (finding 5)", async () => {
    for (const method of METHODS) {
      const h = harness({ ...ANY, cat: rec("cat.ok"), ls: rec("ls.ok"), history: rec("history.ok"), commit: rec("write.ok"), read: rec("read.ok"), glob: rec("glob.ok"), grep: rec("grep.content.ok"), diff: rec("diff.ok"), write: rec("write.ok"), edit: rec("write.ok"), rm: rec("write.ok"), revert: rec("write.ok"), whoami: rec("whoami.ok"), place: rec("place.ok"), status: rec("status.clean") });
      await h.call(method.name, SAMPLES[method.name]);
      for (const call of h.runner.calls) {
        const end = call.args.indexOf("--");
        const flags = end === -1 ? call.args : call.args.slice(0, end);
        for (const flag of flags) expect(/^--(repo|server|if-repo)(=|$)/.test(flag), `${method.name}: ${flag}`).toBe(false);
      }
    }
  });

  it("enableChecks and explore need CLI 0.3.6 (findings 4, 5)", async () => {
    for (const name of ["syns.enableChecks", "syns.explore"]) {
      const h = harness({ ...ANY, "--version": { exitCode: 0, stdout: "syns 0.3.5\n", stderr: "", timedOut: false, spawnError: null, overflowed: false } });
      expect(failureOf(await h.call(name, SAMPLES[name])), name).toMatchObject({ code: "unavailable", reason: "cli_too_old", detail: { need: "0.3.6", have: "0.3.5" } });
      expect(argsOf(h), name).toEqual([]);
    }
  });

  it("an id of . or .., or one holding / or \\, is refused before anything runs: the CLI's client would collapse it onto the repository's route (finding 1, D60)", async () => {
    for (const name of ["syns.collaboratorRole", "syns.collaboratorRemove"]) {
      for (const id of [".", "..", "a/b", "a\\b", ""]) {
        const h = harness(ANY);
        const params = name === "syns.collaboratorRole" ? { id, role: "read" } : { id };
        const refused = failureOf(await h.call(name, params));
        expect(refused, `${name} ${JSON.stringify(id)}`).toMatchObject({ code: "invalid_params" });
        expect(refused.message, `${name} ${JSON.stringify(id)}`).toContain("$.id");
        expect(h.runner.calls, `${name} ${JSON.stringify(id)}`).toHaveLength(0);
      }
      expect((await harness(ANY).call(name, name === "syns.collaboratorRole" ? { id: "usr.dana..01", role: "read" } : { id: "usr.dana..01" })).ok, name).toBe(true);
    }
  });

  it("a 403 says only what the CLI said; a not_found from the new methods names no path or version (finding 3)", async () => {
    const refused = failureOf(await harness({ collaborators: rec("collaborators.forbidden") }).call("syns.collaborators"));
    expect(refused.message).toBe("Syns refused this for this account: it may need a higher role, or a limit was reached.");
    const gone = failureOf(await harness({ unshare: rec("not-found-404"), repo: rec("repo.ok") }).call("syns.unshare"));
    expect(gone).toMatchObject({ code: "not_found", message: "Syns answered that what this asked for is not there." });
    expect(failureOf(await harness({ read: rec("not-found-404"), repo: rec("repo.ok") }).call("syns.read", { path: "a.md" })).message).toBe("That path or version does not exist in the repository.");
  });

  it("a refusal in the CLI's own words reaches the page with its local paths redacted; the log keeps them (finding 2)", async () => {
    const text = "turned on the checks of q3-plan as version 9 of acme/work, commit 0f43, but could not write /work/checkout/q3-plan/.syns.yaml: denied — syns pull at /work/checkout retrieves it; see /etc/x";
    const h = harness({ "enable-checks": { exitCode: 1, stdout: JSON.stringify({ error: text }), stderr: "", timedOut: false, spawnError: null, overflowed: false } });
    const answer = failureOf(await h.call("syns.enableChecks"));
    expect(answer.message).toBe("turned on the checks of q3-plan as version 9 of acme/work, commit 0f43, but could not write ./q3-plan/.syns.yaml: denied — syns pull at . retrieves it; see <path>");
    expect(h.log.join("\n")).toContain("/work/checkout/q3-plan/.syns.yaml");
  });

  it("a key the CLI gave in another type is dropped and logged by its place, never its value (finding 6)", async () => {
    const h = harness({ users: ok({ data: [{ id: "u1", username: "dana", name: 7, image: null }] }) });
    expect(resultOf(await h.call("syns.users", { query: "dana" }))).toEqual({ data: [{ id: "u1", username: "dana", image: null }] });
    expect(h.log.join("\n")).toContain("syns.users session=thr_page dropped from the CLI's output: $.data[0].name");
  });

  it("bad_name and no_such_user are given only to a method that declares them (finding 6)", async () => {
    const answer = failureOf(await harness({ collaborators: rec("share.bad-name") }).call("syns.collaboratorRole", { id: "u1", role: "read" }));
    expect(answer).toMatchObject({ code: "handler_error" });
    expect(answer).not.toHaveProperty("reason");
  });
});
