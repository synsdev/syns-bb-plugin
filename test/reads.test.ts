import { describe, expect, it } from "vitest";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

describe("syns.repo", () => {
  it("returns owner, name and the head, built field by field, for exactly one CLI process (A11, S1.7, S1.10)", async () => {
    const h = harness({ repo: rec("repo.ok") });
    expect(resultOf(await h.call("syns.repo"))).toEqual({ owner: "acme", name: "syns-bb-plugin-scratch", version: HEAD, role: "owner", visibility: "private", fileCount: 32 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["repo", "--json"]]);
  });
  it("reports a repository with no commit yet as version null", async () => {
    const h = harness({ repo: ok({ owner: "o", name: "n", commitSha: null, role: "owner", visibility: "private", fileCount: 0 }) });
    expect(resultOf(await h.call("syns.repo")).version).toBeNull();
  });
  it("passes on a placed folder's holder, path and version number, and the holder's identity beside them (A55, D34)", async () => {
    const h = harness({ repo: rec("repo.folder") });
    expect(resultOf(await h.call("syns.repo"))).toEqual({ owner: "acme", name: "work", version: "7a1e39bf2c8b1642ce9bccded11e1754c51a0a5d", number: 12, role: "owner", visibility: "private", fileCount: 20, holder: "acme/work", path: "clients/vela/q3-board" });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["repo", "--json"]]);
  });
  it("leaves holder, path and number absent where the CLI reports none, as at a repository's root today (D34)", async () => {
    const result = resultOf(await harness({ repo: rec("repo.ok") }).call("syns.repo"));
    for (const key of ["holder", "path", "number"]) expect(result, key).not.toHaveProperty(key);
  });
  it("passes number at a root, as CLI 0.3.6 reports it there, with no holder or path (A55, D34)", async () => {
    const result = resultOf(await harness({ repo: rec("repo.root-036") }).call("syns.repo"));
    expect(result).toEqual({ owner: "acme", name: "work", version: "970e5fa7cc0dee1b8946862e1a27107a5ceecc62", number: 5, role: "owner", visibility: "private", fileCount: 34 });
  });
  it("passes number at a root too, once the CLI reports it there, and null with no commit yet (D34)", async () => {
    expect(resultOf(await harness({ repo: ok({ owner: "o", name: "n", commitSha: HEAD, version: 3, role: "owner", visibility: "private", fileCount: 1 }) }).call("syns.repo"))).toMatchObject({ version: HEAD, number: 3 });
    const empty = resultOf(await harness({ repo: ok({ owner: "o", name: "n", commitSha: null, version: null, holder: "o/n", path: "a", role: "owner", visibility: "private", fileCount: 0 }) }).call("syns.repo"));
    expect(empty).toMatchObject({ version: null, number: null, holder: "o/n", path: "a" });
  });
  it("passes sharedFolder when the CLI reports it: true in a folder-only checkout, whose fileCount is 0 (D-119, D41)", async () => {
    const result = resultOf(await harness({ repo: ok({ owner: "acme", name: "work-docs", commitSha: HEAD, version: 9, sharedFolder: true, role: "read", visibility: "private", fileCount: 0 }) }).call("syns.repo"));
    expect(result).toMatchObject({ name: "work-docs", sharedFolder: true, fileCount: 0, number: 9 });
    expect(resultOf(await harness({ repo: rec("repo.ok") }).call("syns.repo"))).not.toHaveProperty("sharedFolder");
  });
  it("passes on no field the CLI reports beyond the named ones, and none of the wrong type (S1.7)", async () => {
    const result = resultOf(await harness({ repo: ok({ owner: "o", name: "n", commitSha: HEAD, version: "12", holder: 7, path: null, description: "d", tags: ["x"], role: "owner", visibility: "private", fileCount: 1 }) }).call("syns.repo"));
    expect(Object.keys(result).sort()).toEqual(["fileCount", "name", "owner", "role", "version", "visibility"]);
  });
  it("answers no_access when the CLI prints the 404 and repo, asked again, fails too (S3.5)", async () => {
    const h = harness({ repo: rec("not-found-404") });
    expect(failureOf(await h.call("syns.repo"))).toMatchObject({ code: "unavailable", reason: "no_access" });
  });
});

describe("syns.whoami", () => {
  it("returns every field the CLI reports, username among them (A13, D14)", async () => {
    const h = harness({ whoami: rec("whoami.ok") });
    const result = resultOf(await h.call("syns.whoami"));
    expect(Object.keys(result).sort()).toEqual(["bio", "company", "createdAt", "email", "emailVerified", "id", "image", "location", "name", "pronouns", "timeZone", "updatedAt", "username"]);
    expect(result).toMatchObject({ username: "reader", email: "reader@example.test", emailVerified: true, image: null });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["whoami", "--json"]]);
  });
  it("logs nothing of an account's details (S2.20)", async () => {
    const h = harness({ whoami: rec("whoami.ok") });
    await h.call("syns.whoami");
    expect(h.log.join("\n")).not.toContain("reader");
  });
  it("answers not_logged_in when the machine has no login", async () => {
    const h = harness({ whoami: rec("auth-required") });
    expect(failureOf(await h.call("syns.whoami"))).toMatchObject({ code: "unavailable", reason: "not_logged_in" });
  });
});

describe("syns.ls", () => {
  it("lists the head by default", async () => {
    const h = harness({ ls: rec("ls.ok") });
    expect(resultOf(await h.call("syns.ls"))).toEqual({
      version: HEAD,
      number: 6,
      truncated: false,
      total: 2,
      nextOffset: null,
      entries: [
        { path: "README.md", type: "file", size: 94, blob: "7846c4f86a6274cdbd004ebed3985e953621223e" },
        { path: "notes", type: "dir", size: null, blob: null },
      ],
    });
    expect(h.runner.calls[0]!.args).toEqual(["ls", "--json"]);
  });
  it("passes recursive and version as options and the path after -- (S2.11)", async () => {
    const h = harness({ ls: rec("ls.ok") });
    await h.call("syns.ls", { path: "notes", recursive: true, version: OLD });
    expect(h.runner.calls[0]!.args).toEqual(["ls", "--recursive", `--version=${OLD}`, "--json", "--", "notes"]);
  });
  // D18: the host refuses a result over 10,000 JSON nodes; an entry is five.
  const many = (count: number) => ok({ commitSha: HEAD, version: 6, truncated: false, entries: Array.from({ length: count }, (_, i) => ({ name: `f${i}`, path: `f${i}`, type: "file", size: 1, sha: "7846c4f86a6274cdbd004ebed3985e953621223e" })) });
  it("pages a long listing: 1,500 entries by default, with total and nextOffset (D18)", async () => {
    const h = harness({ ls: many(3200) });
    const first = resultOf<any>(await h.call("syns.ls", { recursive: true }));
    expect(first.entries).toHaveLength(1500);
    expect(first.entries[0].path).toBe("f0");
    expect(first.total).toBe(3200);
    expect(first.nextOffset).toBe(1500);
    const last = resultOf<any>(await h.call("syns.ls", { recursive: true, offset: 3000 }));
    expect(last.entries).toHaveLength(200);
    expect(last.entries[0].path).toBe("f3000");
    expect(last.nextOffset).toBeNull();
  });
  it("honours a smaller limit, and an offset past the end is an empty page", async () => {
    const h = harness({ ls: many(10) });
    const page = resultOf<any>(await h.call("syns.ls", { offset: 4, limit: 3 }));
    expect(page.entries.map((entry: { path: string }) => entry.path)).toEqual(["f4", "f5", "f6"]);
    expect(page.nextOffset).toBe(7);
    const past = resultOf(await h.call("syns.ls", { offset: 50 }));
    expect(past.entries).toEqual([]);
    expect(past.total).toBe(10);
    expect(past.nextOffset).toBeNull();
  });
  it("refuses a limit over 1,500 before any process runs", async () => {
    const h = harness({ ls: many(1) });
    expect(failureOf(await h.call("syns.ls", { limit: 1501 })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
  it("never passes offset or limit to the CLI", async () => {
    const h = harness({ ls: many(3) });
    await h.call("syns.ls", { offset: 1, limit: 1 });
    expect(h.runner.calls[0]!.args).toEqual(["ls", "--json"]);
  });
  it("passes the CLI's truncated flag on", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: true, entries: [] }) });
    expect(resultOf(await h.call("syns.ls")).truncated).toBe(true);
  });
  it("a path that is not there is not_found, once repo has shown the repository is reachable (A37)", async () => {
    const h = harness({ ls: rec("not-found-404"), repo: rec("repo.ok") });
    const error = failureOf(await h.call("syns.ls", { path: "nope" }));
    expect(error.code).toBe("not_found");
    expect(error).not.toHaveProperty("reason");
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["ls", "repo"]);
  });
  it("a path missing at a named version is not_found, with no second process", async () => {
    const h = harness({ ls: rec("path-not-found-at-version") });
    expect(failureOf(await h.call("syns.ls", { path: "nope", version: OLD })).code).toBe("not_found");
    expect(h.runner.calls).toHaveLength(1);
  });
  it("an unknown version is not_found", async () => {
    const h = harness({ ls: rec("version-not-found") });
    expect(failureOf(await h.call("syns.ls", { version: OLD })).code).toBe("not_found");
  });
});

describe("syns.history", () => {
  it("maps each row, provenance as `by`, with a default limit of 20", async () => {
    const h = harness({ history: rec("history.ok") });
    const result = resultOf<{ total: number; entries: Record<string, unknown>[] }>(await h.call("syns.history"));
    expect(result.total).toBe(6);
    expect(result.entries[0]).toEqual({
      version: "12959ec357a37b85c06b67a68d1f6b9e023c5567",
      number: 5,
      parent: OLD,
      author: "acme",
      at: "2026-09-21T12:06:03Z",
      message: "proto: rm",
      paths: ["notes/n29.md"],
      pathsTruncated: false,
      by: { integration: "syns-bb-plugin", run: "thr_examplepage", trigger: "thread-page" },
    });
    expect(result.entries[1]).toMatchObject({ parent: null, by: { integration: null, run: null, trigger: null } });
    expect(h.runner.calls[0]!.args).toEqual(["history", "--limit=20", "--json"]);
  });
  it("passes an agent's push as recorded: by.run set, but neither the plugin's integration nor its trigger (Syns issue 214)", async () => {
    const entries = resultOf<{ entries: { by: Record<string, unknown> }[] }>(await harness({ history: rec("history.agent-push") }).call("syns.history")).entries;
    expect(entries.map((entry) => entry.by)).toEqual([
      { integration: "claude-code", run: "d0280c76-0000-4000-8000-000000000001", trigger: "finish" },
      { integration: "claude-code", run: "3db5c4eb-0000-4000-8000-000000000002", trigger: "agent" },
    ]);
    // What marks a page's write is the pair below, which only the plugin sets; a run alone does not.
    for (const entry of entries) expect(entry.by.integration === "syns-bb-plugin" && entry.by.trigger === "thread-page").toBe(false);
  });
  it("passes path as --file=PATH, never as a bare argument", async () => {
    const h = harness({ history: rec("history.ok") });
    await h.call("syns.history", { path: "notes/a.md", limit: 100 });
    expect(h.runner.calls[0]!.args).toEqual(["history", "--file=notes/a.md", "--limit=100", "--json"]);
  });
  it("for one file's history, where the CLI's rows name no paths and no parent, names that file and drops its content and diff (S1.7)", async () => {
    const h = harness({ history: rec("history.file.ok") });
    const result = resultOf<{ total: number; entries: Record<string, unknown>[] }>(await h.call("syns.history", { path: "notes/n01.md", limit: 1 }));
    expect(result).toEqual({
      total: 3,
      entries: [{ version: HEAD, number: 6, parent: null, author: "acme", at: "2026-09-21T12:06:04Z", message: "proto: revert", paths: ["notes/n01.md"], pathsTruncated: false, by: { integration: null, run: null, trigger: null } }],
    });
    expect(JSON.stringify(result)).not.toContain("FILE CONTENT");
    expect(h.log.join("\n")).not.toContain("FILE CONTENT");
  });

  it("refuses a limit outside 1 to 200", async () => {
    const h = harness();
    for (const limit of [0, 201, 1.5, "20"]) expect(failureOf(await h.call("syns.history", { limit })).code).toBe("invalid_params");
  });
  it("holds at most 200 paths per row and says when there were more", async () => {
    const row = { sha: HEAD, version: 7, parentSha: OLD, author: "a", createdAt: "2026-09-21T12:06:03Z", message: "big", messageBody: null, filesChanged: Array.from({ length: 250 }, (_, i) => `f/${i}.md`), provenance: { integration: null, publisher: "a", run: null, taskRef: null, trigger: null } };
    const h = harness({ history: ok({ data: [row], limit: 20, offset: 0, total: 1 }) });
    const entry = resultOf<{ entries: { paths: string[]; pathsTruncated: boolean }[] }>(await h.call("syns.history")).entries[0]!;
    expect(entry.paths).toHaveLength(200);
    expect(entry.pathsTruncated).toBe(true);
  });
});
