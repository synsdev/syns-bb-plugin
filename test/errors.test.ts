import { describe, expect, it } from "vitest";
import { CLI_NOT_FOUND } from "../src/cli.js";
import { REASONS, SynsError, interpret, toAnswer } from "../src/errors.js";
import { rec, spawnFailed, timedOut } from "./fake-runner.js";

const never = async () => {
  throw new Error("repo must not be run");
};

async function failure(run: Parameters<typeof interpret>[0], declared: string[] = [], runRepo: Parameters<typeof interpret>[2] = never): Promise<SynsError> {
  try {
    await interpret(run, declared, runRepo);
  } catch (error) {
    if (error instanceof SynsError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("the recognition table (S3.4, A36)", () => {
  it("row 1: exit 7 with currentSha is stale_head, with the current version as detail", async () => {
    const error = await failure(rec("stale-parent"));
    expect(toAnswer(error).error).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837" } });
  });
  it("row 2: exit 2 with 'cannot determine repo identity' is no_repo", async () => {
    expect(toAnswer(await failure(rec("no-identity"))).error).toMatchObject({ code: "unavailable", reason: "no_repo" });
  });
  it("row 2a: exit 2 with 'folder out of place' is folder_out_of_place (D38)", async () => {
    expect(toAnswer(await failure(rec("folder-out-of-place"))).error).toMatchObject({ code: "unavailable", reason: "folder_out_of_place" });
  });
  it("row 2b: exit 1 with 'folder_write_unsupported' is folder_write_unsupported (D38)", async () => {
    expect(toAnswer(await failure(rec("folder-write-unsupported"))).error).toMatchObject({ code: "unavailable", reason: "folder_write_unsupported" });
  });
  it("row 3: 'holds unpublished local changes' is checkout_dirty", async () => {
    expect(toAnswer(await failure(rec("checkout-dirty"))).error).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
  });
  it("row 4: 'authentication required' is not_logged_in where the method declares it, else no_access", async () => {
    expect(toAnswer(await failure(rec("auth-required"), ["not_logged_in"])).error).toMatchObject({ code: "unavailable", reason: "not_logged_in" });
    expect(toAnswer(await failure(rec("auth-required"))).error).toMatchObject({ code: "unavailable", reason: "no_access" });
  });
  it("row 5: '--old matched no content' is no_match", async () => {
    expect(toAnswer(await failure(rec("edit-no-match"))).error).toMatchObject({ code: "invalid_params", reason: "no_match" });
  });
  it("row 6: '--old matched N times' is many_matches with the count", async () => {
    expect(toAnswer(await failure(rec("edit-many-matches"))).error).toMatchObject({ code: "invalid_params", reason: "many_matches", detail: { count: 33 } });
  });
  it("row 8: 'invalid pattern' is bad_pattern, from grep and from glob", async () => {
    for (const recording of ["bad-pattern.grep", "bad-pattern.glob"]) expect(toAnswer(await failure(rec(recording))).error, recording).toMatchObject({ code: "invalid_params", reason: "bad_pattern" });
  });
  it("row 9: anything else is handler_error, and keeps the exit code and output for the log", async () => {
    const error = await failure(rec("malformed-changeset"));
    expect(toAnswer(error).error).toEqual({ code: "handler_error", message: expect.any(String) });
    expect(error.log).toContain("exit=1");
    expect(error.log).toContain("the changeset document does not parse");
  });
  it("row 9 carries the CLI's own words as the message, at most 300 characters (D59)", async () => {
    const error = await failure(rec("malformed-changeset"));
    expect(error.message).toContain("the changeset document does not parse");
    expect(error.message.length).toBeLessThanOrEqual(300);
  });
  it("row 9 without words of the CLI's keeps the plugin's sentence", async () => {
    expect((await failure(rec("arg-error"))).message).toBe("Syns could not complete this. The plugin's log has the cause.");
  });
  it("the CLI's refusals that a command does not act in this scope are bad_scope (D59, HOST_FACTS §17)", async () => {
    for (const recording of ["share.root-dot.0313", "enable-checks.root.0313", "repo.visibility.holder-root.0313", "collaborators.holder-root.0313"]) expect(toAnswer(await failure(rec(recording))).error, recording).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
  });
  it("row 9: the CLI's own argument error (plain text on stderr, exit 2) is handler_error", async () => {
    const error = await failure(rec("arg-error"));
    expect(error.code).toBe("handler_error");
    expect(error.log).toContain("exit=2");
    expect(error.log).toContain("unexpected argument");
  });
  it("row 8a: 'version not found' is not_found, about the version", async () => {
    const error = await failure(rec("version-not-found"));
    expect(toAnswer(error).error).toEqual({ code: "not_found", message: expect.any(String) });
    expect(error.subject).toBe("version");
  });

  it("row 8a: 'path not found at version' is not_found, about the path", async () => {
    const error = await failure(rec("path-not-found-at-version"));
    expect(toAnswer(error).error).toEqual({ code: "not_found", message: expect.any(String) });
    expect(error.subject).toBeUndefined();
  });
});

describe("the 404 (S3.5, A37)", () => {
  it("is not_found when repo then succeeds", async () => {
    let asked = 0;
    const error = await failure(rec("not-found-404"), [], async () => {
      asked += 1;
      return rec("repo.ok");
    });
    expect(toAnswer(error).error).toEqual({ code: "not_found", message: expect.any(String) });
    expect(asked).toBe(1);
  });
  it("is no_access when repo fails too", async () => {
    const error = await failure(rec("not-found-404"), [], async () => rec("not-found-404"));
    expect(toAnswer(error).error).toMatchObject({ code: "unavailable", reason: "no_access" });
  });
});

describe("processes that did not run to an answer", () => {
  it("no executable is cli_missing (S3.6, A39)", async () => {
    expect(toAnswer(await failure(spawnFailed(CLI_NOT_FOUND))).error).toMatchObject({ code: "unavailable", reason: "cli_missing" });
  });
  it("any other start failure is handler_error (S3.6)", async () => {
    const error = await failure(spawnFailed("Error: spawn EACCES"));
    expect(error.code).toBe("handler_error");
    expect(error.log).toContain("EACCES");
  });
  it("a stopped process is timeout (S2.14)", async () => {
    expect(toAnswer(await failure(timedOut())).error).toMatchObject({ code: "unavailable", reason: "timeout" });
  });
  it("output that is not JSON is handler_error, and the log holds none of it on exit 0 (S2.13, S2.20, A40)", async () => {
    const error = await failure(rec("not-json"));
    expect(error.code).toBe("handler_error");
    expect(error.log).toContain("exit=0");
    expect(error.log).not.toContain("secret file text");
  });
  it("output beyond the host half's bound is response_too_large (S2.16)", async () => {
    const error = await failure({ ...rec("cat.ok"), exitCode: null, overflowed: true });
    expect(error.code).toBe("response_too_large");
  });
});

describe("success", () => {
  it("returns the parsed document", async () => {
    expect(await interpret(rec("repo.ok"), [], never)).toMatchObject({ owner: "acme", fileCount: 32 });
  });
});

describe("page-facing messages (S3.1)", () => {
  it("every reason has the plugin's own sentence of at most 300 characters, and a code from the host's set", () => {
    for (const [reason, entry] of Object.entries(REASONS)) {
      expect(entry.message.length, reason).toBeGreaterThan(0);
      expect(entry.message.length, reason).toBeLessThanOrEqual(300);
      expect(["unavailable", "conflict", "invalid_params", "not_found"]).toContain(entry.code);
    }
  });
  it("never carries the CLI's text: no folder path, no CLI hint", async () => {
    const dirty = toAnswer(await failure(rec("checkout-dirty"))).error.message;
    expect(dirty).not.toContain("the checkout at");
    const login = toAnswer(await failure(rec("auth-required"))).error.message;
    expect(login).not.toContain("syns login' first");
  });
});
