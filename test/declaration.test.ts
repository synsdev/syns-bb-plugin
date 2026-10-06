import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION, buildDeclaration } from "../src/declaration.js";
import { K64, object, reasonsOf, type Method, type Schema } from "../src/method.js";
import { METHODS } from "../src/methods/index.js";
import { FRAGMENT, FRAGMENT_MAX } from "../src/text/fragment.js";
import { GUIDE_MAX, buildGuide } from "../src/text/guide.js";
import { ok } from "./fake-runner.js";
import { harness, resultOf } from "./harness.js";

/** 0.6.0, the page surface (D49, D59). */
const SURFACE = ["syns.collaboratorAdd", "syns.collaboratorRemove", "syns.collaboratorRole", "syns.collaborators", "syns.enableChecks", "syns.explore", "syns.folderVisibility", "syns.repoVisibility", "syns.share", "syns.shareInfo", "syns.unshare", "syns.users"];
/** The writes that change who reaches a repository or folder, not its files: no base, no message (A61). */
const SHARING_WRITES = ["syns.collaboratorAdd", "syns.collaboratorRemove", "syns.collaboratorRole", "syns.folderVisibility", "syns.repoVisibility", "syns.share", "syns.unshare"];
const SIXTEEN = ["syns.commit", "syns.diff", "syns.edit", "syns.glob", "syns.grep", "syns.history", "syns.ls", "syns.read", "syns.readBinary", "syns.readMany", "syns.repo", "syns.revert", "syns.rm", "syns.whoami", "syns.write", "syns.writeBinary"];
const ALL = [...SIXTEEN, "syns.place", ...SURFACE].sort();
/** The keywords Thread Pages compiles; any other refuses the method (its contributed.ts). */
const SUBSET = new Set(["type", "description", "properties", "required", "additionalProperties", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "pattern", "items", "minItems", "maxItems"]);

function walk(schema: Schema, visit: (node: Schema, at: string) => void, at = "$"): void {
  visit(schema, at);
  for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) walk(child, visit, `${at}.${key}`);
  if (schema.items) walk(schema.items as Schema, visit, `${at}[]`);
}
const typesOf = (node: Schema): string[] => (Array.isArray(node.type) ? (node.type as string[]) : [node.type as string]);
const namesIn = (text: string): string[] => [...new Set(text.match(/syns\.[a-z][A-Za-z0-9]*/g) ?? [])].sort();

const declaration = buildDeclaration(METHODS, { agentInstructions: true });

describe("the table", () => {
  it("holds the twenty-nine methods: the sixteen of spec 01, syns.place, and the twelve of spec 06 (D23, D43, D59)", () => {
    expect(METHODS.map((method) => method.name).sort()).toEqual(ALL);
    expect(METHODS.filter((method) => method.effect === "contributed-write").map((method) => method.name).sort()).toEqual(["syns.commit", "syns.edit", "syns.enableChecks", "syns.place", "syns.revert", "syns.rm", "syns.write", "syns.writeBinary", ...SHARING_WRITES].sort());
  });
});

describe("the declaration", () => {
  it("carries only the keys the host accepts, the package's version, and stays under the host's 256 KiB", () => {
    expect(Object.keys(declaration).sort()).toEqual(["guide", "instruction", "methods", "version"]);
    expect(declaration.version).toBe(VERSION);
    expect(VERSION).toBe((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
    expect(Buffer.byteLength(JSON.stringify(declaration))).toBeLessThan(256 * 1024);
    for (const method of declaration.methods) {
      expect(Object.keys(method).sort(), method.name).toEqual(["description", "effect", "maxRequestBytes", "maxResponseBytes", "name", "params", "reasons", "result"]);
    }
  });

  it("names, describes and bounds every method as the host requires (S1.8)", () => {
    for (const method of declaration.methods) {
      expect(method.name).toMatch(/^syns\.[a-z][A-Za-z0-9]{0,63}$/);
      expect(method.description.length, method.name).toBeGreaterThan(0);
      expect(method.description.length, method.name).toBeLessThanOrEqual(240);
      expect(["read", "contributed-write"]).toContain(method.effect);
      for (const bound of [method.maxRequestBytes, method.maxResponseBytes]) {
        expect(Number.isSafeInteger(bound) && bound >= 1024 && bound <= 1024 * 1024, method.name).toBe(true);
      }
    }
  });

  it("declares the bounds of spec 01", () => {
    const bounds = Object.fromEntries(declaration.methods.map((method) => [method.name, `${method.maxRequestBytes / 1024}/${method.maxResponseBytes / 1024}`]));
    expect(bounds).toEqual({
      "syns.repo": "64/64",
      "syns.whoami": "64/64",
      "syns.ls": "64/1024",
      "syns.readMany": "64/1024",
      "syns.history": "64/1024",
      "syns.commit": "1024/64",
      "syns.read": "64/1024",
      "syns.glob": "64/1024",
      "syns.grep": "64/1024",
      "syns.diff": "64/1024",
      "syns.write": "1024/64",
      "syns.edit": "128/64",
      "syns.rm": "64/64",
      "syns.revert": "64/64",
      "syns.readBinary": "64/1024",
      "syns.writeBinary": "1024/64",
      "syns.place": "64/64",
      "syns.shareInfo": "64/64",
      "syns.share": "64/64",
      "syns.unshare": "64/64",
      "syns.folderVisibility": "64/64",
      "syns.repoVisibility": "64/64",
      "syns.collaborators": "64/1024",
      "syns.collaboratorAdd": "64/64",
      "syns.collaboratorRole": "64/64",
      "syns.collaboratorRemove": "64/64",
      "syns.enableChecks": "64/64",
      "syns.explore": "64/1024",
      "syns.users": "64/1024",
    });
  });

  it("every parameter schema is closed and every string in it bounded (A7, S1.1)", () => {
    for (const method of declaration.methods) {
      expect(typesOf(method.params)).toEqual(["object"]);
      walk(method.params, (node, at) => {
        if (typesOf(node).includes("object")) expect(node.additionalProperties, `${method.name} ${at}`).toBe(false);
        if (typesOf(node).includes("string")) expect(typeof node.maxLength, `${method.name} ${at}`).toBe("number");
      });
    }
  });

  it("uses only the schema subset the host compiles, in params, results and details", () => {
    for (const method of declaration.methods) {
      const schemas = [method.params, method.result, ...Object.values(method.reasons).flatMap((reason) => (reason.detail ? [reason.detail] : []))];
      for (const schema of schemas) {
        walk(schema, (node, at) => {
          for (const key of Object.keys(node)) expect(SUBSET.has(key), `${method.name} ${at} ${key}`).toBe(true);
          expect(node.type, `${method.name} ${at}`).toBeDefined();
          if (typesOf(node).includes("array")) expect(node.items, `${method.name} ${at}`).toBeDefined();
          for (const key of (node.required ?? []) as string[]) expect(Object.keys((node.properties ?? {}) as object), `${method.name} ${at}`).toContain(key);
        });
      }
    }
  });

  it("declares every reason a method can answer with (S3.2)", () => {
    const reasons = Object.fromEntries(declaration.methods.map((method) => [method.name, Object.keys(method.reasons).sort()]));
    const common = ["bad_scope", "cli_missing", "folder_out_of_place", "no_access", "no_repo", "timeout"];
    const write = ["checkout_dirty", "folder_write_unsupported", "stale_head"];
    expect(reasons).toEqual({
      "syns.repo": common,
      "syns.whoami": [...common, "not_logged_in"].sort(),
      "syns.ls": common,
      "syns.readMany": common,
      "syns.history": common,
      "syns.commit": [...common, ...write, "bad_offset", "invalid_change"].sort(),
      "syns.read": common,
      "syns.glob": [...common, "bad_pattern"].sort(),
      "syns.grep": [...common, "bad_pattern"].sort(),
      "syns.diff": common,
      "syns.write": [...common, ...write, "exists"].sort(),
      "syns.edit": [...common, ...write, "many_matches", "no_match"].sort(),
      "syns.rm": [...common, ...write].sort(),
      "syns.readBinary": common,
      "syns.writeBinary": [...common, ...write, "bad_hash", "bad_offset", "too_large"].sort(),
      "syns.revert": [...common, "folder_write_unsupported"].sort(),
      "syns.place": [...common, "cli_too_old", "folder_write_unsupported", "occupied", "no_such_template", "stale_head", "checkout_dirty"].sort(), // it cannot answer stale_head or checkout_dirty while the CLI's revert takes no parent and has no guard (D13, D29)
      // 0.6.0: the CLI's answers, mapped (D59). Sharing writes declare no file-write reason (A61).
      "syns.shareInfo": [...common, "cli_too_old", "not_permitted"].sort(),
      "syns.share": [...common, "cli_too_old", "bad_name", "name_taken", "not_permitted"].sort(),
      "syns.unshare": [...common, "cli_too_old", "not_permitted"].sort(),
      "syns.folderVisibility": [...common, "cli_too_old", "bad_name", "name_taken", "not_permitted"].sort(),
      "syns.repoVisibility": [...common, "not_permitted"].sort(),
      "syns.collaborators": [...common, "not_permitted"].sort(),
      "syns.collaboratorAdd": [...common, "already_collaborator", "no_such_user", "not_permitted"].sort(),
      "syns.collaboratorRole": [...common, "not_permitted"].sort(),
      "syns.collaboratorRemove": [...common, "not_permitted"].sort(),
      "syns.enableChecks": [...common, "cli_too_old", "folder_write_unsupported", "stale_head", "checkout_dirty"].sort(),
      "syns.explore": [...common, "cli_too_old"].sort(),
      "syns.users": common,
    });
    for (const method of declaration.methods) for (const reason of Object.keys(method.reasons)) expect(reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    const stale = declaration.methods.find((method) => method.name === "syns.commit")!.reasons.stale_head!;
    expect(stale.detail).toMatchObject({ type: "object", required: ["current"] });
    const many = declaration.methods.find((method) => method.name === "syns.edit")!.reasons.many_matches!;
    expect(many.detail).toMatchObject({ type: "object", required: ["count"] });
  });

  it("no method takes a repository, a session, a folder, a command or a flag (S1.2)", () => {
    for (const method of declaration.methods) {
      walk(method.params, (node) => {
        for (const key of Object.keys((node.properties ?? {}) as object)) expect(["repo", "repository", "session", "sessionId", "cwd", "folder", "command", "flag", "flags", "args"]).not.toContain(key);
      });
    }
  });

  it("every write requires base, but syns.revert, whose CLI command takes no parent (A30, S1.4, D13)", () => {
    for (const method of declaration.methods.filter((entry) => entry.effect === "contributed-write" && !["syns.place", "syns.enableChecks", ...SHARING_WRITES].includes(entry.name))) {
      if (method.name === "syns.revert") expect(Object.keys(method.params.properties as object), method.name).not.toContain("base");
      else expect(method.params.required, method.name).toContain("base");
    }
  });

  it("a sharing write takes neither base nor message (A61, D41)", () => {
    for (const name of SHARING_WRITES) {
      const method = declaration.methods.find((entry) => entry.name === name)!;
      expect(Object.keys(method.params.properties as object), name).not.toContain("base");
      expect(Object.keys(method.params.properties as object), name).not.toContain("message");
    }
  });

  it("every write takes an optional message of at most 500 characters (S1.6)", () => {
    for (const method of declaration.methods.filter((entry) => entry.effect === "contributed-write" && !["syns.place", "syns.enableChecks", ...SHARING_WRITES].includes(entry.name))) {
      expect((method.params.properties as Record<string, Schema>).message, method.name).toMatchObject({ type: "string", maxLength: 500 });
      expect(method.params.required, method.name).not.toContain("message");
    }
  });
});

describe("what agents are told", () => {
  it("the fragment is within FRAGMENT_MAX, and the guide within GUIDE_MAX, 16 KiB less 512 (A8, S4.6, S6.34); the space bb leaves is checked live in instruction-cap.test.ts", () => {
    expect(declaration.instruction!.length).toBeLessThanOrEqual(FRAGMENT_MAX);
    expect(Buffer.byteLength(declaration.instruction!)).toBeLessThanOrEqual(2 * 1024);
    expect(GUIDE_MAX).toBe(16 * 1024 - 512);
    expect(Buffer.byteLength(declaration.guide)).toBeLessThanOrEqual(GUIDE_MAX);
    expect(declaration.instruction).toBe(FRAGMENT.trim());
  });

  it("the fragment leads with one tool-first line naming the two commands, and points at the setup doc (A56, D45)", () => {
    const text = declaration.instruction!;
    expect(text.startsWith("**Tool first.** Asked for a piece of work the person will keep working in?")).toBe(true);
    expect(text.split("\n")[0]).toContain("`syns explore -t syns-app -q <words>`");
    expect(text.split("\n")[0]).toContain("`syns cat TOOLS.md --repo bartsoj/syns-templates`");
    expect(text).toContain("`syns cat SETUP.md --repo bartsoj/syns-bb-plugin-setup`");
    expect(text).not.toContain("syns-tools");
    expect(text.length).toBeLessThanOrEqual(1300);
  });

  it("the fragment and the guide say the folder rule: a placed folder is what the page sees, paths counted from it (A57, D36)", () => {
    expect(declaration.instruction).toMatch(/or a folder placed in one/);
    expect(declaration.instruction).toContain("it sees the one, or the placed folder, its session's folder belongs to; paths count from there.");
    expect(declaration.instruction).not.toMatch(/never names a repository\.\*\* It is the one/);
    expect(declaration.guide).toContain("## A placed folder");
    for (const word of ["`holder`", "counted from it", "the holder's", "Once the CLI checks writes against the folder only, a write is `stale_head` only when the folder changed after `base`"]) expect(declaration.guide, word).toContain(word);
    expect(declaration.guide).not.toContain("repository-relative");
    expect(declaration.guide).not.toContain("Choose a repository: it is the session's.");
  });

  it("the guide names exactly the registered methods, the fragment none other (A9, S4.4)", () => {
    expect(namesIn(declaration.guide)).toEqual(ALL);
    for (const name of namesIn(declaration.instruction!)) expect(ALL).toContain(name);
    for (const reason of ["exists", "no_match", "many_matches", "bad_pattern"]) expect(declaration.guide, reason).toContain(`\`${reason}\``);
  });

  it("the guide identifies a page's write by integration and trigger, never by run alone (Syns issue 214, 0.3.1)", () => {
    expect(declaration.guide).toContain("A page's write has `by.integration` `syns-bb-plugin` and `by.trigger` `thread-page`");
    expect(declaration.guide).toContain("never read it alone as a page's");
    expect(declaration.guide).not.toContain("null from outside pages");
    const history = declaration.methods.find((method) => method.name === "syns.history")!;
    expect(history.description).toContain("by.integration syns-bb-plugin and by.trigger thread-page");
    expect(history.description).not.toContain("by.run is the bb session");
  });

  it("the guide says plainly what syns.revert lacks today, and its recipes use the full set (D13, spec 04)", () => {
    expect(declaration.guide).toMatch(/syns\.revert[^\n]*no stale check[^\n]*no provenance/);
    expect(declaration.guide).toContain("syns.diff { from }");
    expect(declaration.guide).toContain("create: true");
  });

  it("the fragment says in words that it applies only in a Syns repository, and where the rest is (S4.2)", () => {
    expect(declaration.instruction).toMatch(/When this session's folder is a Syns repository/);
    expect(declaration.instruction).toContain("bb thread-page guide");
  });

  it("the fragment and the guide say shares act at once, from an explicit control only, and label public apart (D51, S6.30–S6.32, A72)", () => {
    expect(declaration.instruction).toContain("Writes and shares act at once: only from a control saying what changes, for whom.");
    for (const words of ["Only from a control the reader presses for that action", "never on load, from a timer or `watch`", "The control shows who gets what", "Public is labelled apart", "anyone, signed in or not, can find and read this", "Never a default"]) expect(declaration.guide, words).toContain(words);
    for (const name of SHARING_WRITES) expect(declaration.methods.find((entry) => entry.name === name)!.description, name).toMatch(/[Oo]nly from the reader's own press/);
    for (const name of ["syns.folderVisibility", "syns.repoVisibility"]) expect(declaration.methods.find((entry) => entry.name === name)!.description, name).toContain("public: anyone, signed in or not, can find and read");
  });

  it("the generated method section prints no effect, bounds or reasons: the host's roster does (D56, S6.33)", () => {
    const section = declaration.guide.slice(declaration.guide.indexOf("## Every method"), declaration.guide.indexOf("## Errors"));
    expect(section).not.toMatch(/^### .*—/m);
    expect(section).not.toContain("- Reasons:");
    expect(section).toContain("`…record` is `{ owner?: string");
    expect(section).toContain("Result: `{ …record }`");
  });

  it("the guide's statements about each method come from its declaration (S4.3)", () => {
    for (const method of declaration.methods) {
      expect(declaration.guide).toContain(`\`${method.name}\``);
      expect(declaration.guide, method.name).not.toContain(method.description); // the host's roster carries it (D42)
      for (const reason of Object.keys(method.reasons)) expect(declaration.guide, `${method.name} ${reason}`).toContain(`\`${reason}\``);
    }
    expect(declaration.guide).toContain("1–200"); // history's limit, from its schema
    expect(declaration.guide).toContain("1–64"); // readMany's paths, from its schema
    expect(declaration.guide).toContain("1–5000"); // read's limit, from its schema
    expect(declaration.guide).toContain("string(≤32768)"); // edit's old and new, from its schema
  });

  it("with agentInstructions off no fragment is declared; methods and guide remain (A10, S4.5)", () => {
    const quiet = buildDeclaration(METHODS, { agentInstructions: false });
    expect(quiet).not.toHaveProperty("instruction");
    expect(quiet.methods).toEqual(declaration.methods);
    expect(quiet.guide).toBe(declaration.guide);
  });
});

describe("no skills (D45)", () => {
  it("the plugin ships none: the manifest declares no skills folder, and there is none", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bb: Record<string, unknown> };
    expect(manifest.bb).not.toHaveProperty("skills");
    expect(existsSync(new URL("../skills", import.meta.url))).toBe(false);
  });
});

describe("one table drives everything (A33, S2.21)", () => {
  const ping: Method = {
    name: "syns.ping",
    description: "A method that exists only in this test.",
    effect: "read",
    params: object({}),
    result: { type: "object", properties: { pong: { type: "boolean" } }, required: ["pong"] },
    maxRequestBytes: K64,
    maxResponseBytes: K64,
    command: () => ({ args: ["ping", "--json"] }),
    shape: (out) => ({ pong: out.pong }),
  };
  const table = [...METHODS, ping];

  it("a method added to the table appears in the declaration, the guide and the dispatch with no other change", async () => {
    expect(buildDeclaration(table, { agentInstructions: true }).methods.map((method) => method.name)).toContain("syns.ping");
    expect(buildGuide(table)).toContain("`syns.ping`");
    const h = harness({ ping: ok({ pong: true }) }, { table });
    expect(resultOf(await h.call("syns.ping"))).toEqual({ pong: true });
    expect(reasonsOf(ping)).toEqual(["no_repo", "no_access", "cli_missing", "timeout", "folder_out_of_place", "bad_scope"]);
  });

  it("and is nowhere without it", async () => {
    expect(buildGuide(METHODS)).not.toContain("syns.ping");
    expect((await harness().call("syns.ping")).ok).toBe(false);
  });
});
