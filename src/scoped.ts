import { SynsError, fail } from "./errors.js";
import { path, pathGlob, repoPath, type Method, type Schema } from "./method.js";

/**
 * A call's scope in the server half (S1.25, D85): the method's paths count from that folder of the repository, and
 * what it answers is cut back to count from it, anything outside dropped; a read's leading `../` reaches the rest of the
 * session's folder, and its answer counts from the scope with `../` (Q-0025). Which values are paths is read from the
 * schemas alone: `path` and `pathGlob` in params, `repoPath` in results. The host half checks the folder (S2.31).
 */

/** A call's params under its scope: what the schema checks, what the method runs with, and whether a read reached out. */
export interface Scoped {
  /** The params as asked, but a read's `../` path resolved: the schema checks it as the path the CLI is given. */
  checked: Record<string, unknown>;
  /** Every `path` and `pathGlob` value counted from the session's folder; an absent root `path` is the scope, or the folder a `../` climbs to. */
  given: Record<string, unknown>;
  /** A read's path began with `../`: its answer counts every path from the scope with `../`, and drops none (Q-0025). */
  reaches: boolean;
}

/**
 * A read's path or pattern may begin with `../` segments, resolved against the scope; one climbing above the session's
 * folder is `bad_scope`. A write's `..`, a `..` after a path's start, a leading `/`: `bad_scope`, before the params are
 * checked (S1.25, D91 point 3 as amended by Q-0025).
 */
export function scopeParams(method: Method, params: Record<string, unknown>, scope: string): Scoped {
  const folders = scope.split("/");
  let top = folders.length;
  const resolve = (value: string): { checked: string; given: string } => {
    const segments = value.split("/");
    let up = 0;
    while (segments[up] === "..") up++;
    if (value.startsWith("/") || segments.slice(up).includes("..") || (up > 0 && method.effect !== "read") || up > folders.length) throw fail("bad_scope");
    if (up === 0) return { checked: value, given: `${scope}/${value}` };
    top = Math.min(top, folders.length - up);
    const resolved = [...folders.slice(0, folders.length - up), ...segments.slice(up)].join("/");
    if (resolved.startsWith("/")) throw fail("bad_scope");
    return { checked: resolved, given: resolved };
  };
  const checked = under(method.params, params, (value) => resolve(value).checked) as Record<string, unknown>;
  const given = under(method.params, params, (value) => resolve(value).given) as Record<string, unknown>;
  if (given.path === "" && !(method.params.required as string[] | undefined)?.includes("path")) {
    // `../..` up to the session's folder is its root: the method runs as with no path at all.
    delete checked.path;
    delete given.path;
  } else if (method.rootPath && params.path === undefined && top > 0) given.path = folders.slice(0, top).join("/");
  return { checked, given, reaches: top < folders.length };
}

function under(schema: Schema, value: unknown, one: (text: string) => string): unknown {
  if (schema === path || schema === pathGlob) return typeof value === "string" ? one(value) : value;
  if (Array.isArray(value)) return schema.items ? value.map((item) => under(schema.items as Schema, item, one)) : value;
  if (typeof value === "object" && value !== null && schema.properties) {
    const properties = schema.properties as Record<string, Schema>;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, Object.hasOwn(properties, key) ? under(properties[key]!, child, one) : child]));
  }
  return value;
}

const OUTSIDE = Symbol("outside the scope");

/** The result the page gets: each repository path counted from the scope; one outside dropped, with the list item holding it, unless the call reached out with `../`. */
export function scopeResult(method: Method, result: unknown, scope: string, reaches = false): unknown {
  const prefix = `${scope}/`;
  const folders = scope.split("/");
  // A path outside, counted from the scope: up to the nearest folder it shares, then down. Only a prefix is read, so a line's text after its path stays as it is.
  const climb = (value: string): string => {
    for (let k = folders.length - 1; k > 0; k--) {
      const at = `${folders.slice(0, k).join("/")}/`;
      if (value.startsWith(at)) return `${"../".repeat(folders.length - k)}${value.slice(at.length)}`;
    }
    return `${"../".repeat(folders.length)}${value}`;
  };
  const count = (value: string): string | typeof OUTSIDE => (value.startsWith(prefix) ? value.slice(prefix.length) : reaches ? climb(value) : OUTSIDE);
  const kept = within(method.result, result, count, false);
  if (kept === OUTSIDE) throw new SynsError("handler_error", { log: `${method.name} answered a path outside the call's scope` });
  return kept;
}

function within(schema: Schema, value: unknown, count: (value: string) => string | typeof OUTSIDE, item: boolean): unknown {
  if (schema === repoPath) return typeof value !== "string" ? value : count(value);
  if (Array.isArray(value)) return schema.items ? value.map((one) => within(schema.items as Schema, one, count, true)).filter((one) => one !== OUTSIDE) : value;
  if (typeof value === "object" && value !== null && schema.properties) {
    const properties = schema.properties as Record<string, Schema>;
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const one = Object.hasOwn(properties, key) ? within(properties[key]!, child, count, false) : child;
      // What names a path outside is outside; so is a list item whose paths are all outside (a commit elsewhere).
      if (one === OUTSIDE) return OUTSIDE;
      if (item && properties[key]?.items === repoPath && Array.isArray(one) && one.length === 0) return OUTSIDE;
      kept[key] = one;
    }
    return kept;
  }
  return value;
}

/**
 * A patch under a call's scope: every path its header lines name (`diff --git`, `---`, `+++`, `rename from` and `to`,
 * `copy from` and `to`, `Binary files … differ`) counted from the scope, as the CLI counts a folder's (syns-cli
 * `rebase_diff_headers`); `/dev/null`, the `a/` and `b/` prefixes, a quoted path's quotes and a path outside stay as
 * they are. Only the lines ahead of a file's first hunk are headers, so a hunk's line reading `--- a/x` is never
 * rewritten (S1.25, B-0080).
 */
export function scopePatch(patch: string, scope: string): string {
  const prefix = `${scope}/`;
  const lead = (text: string, ab: string) => (text.startsWith(`${ab}${prefix}`) ? "" : text.startsWith(`"${ab}${prefix}`) ? '"' : undefined);
  const side = (text: string, ab: string) => {
    const quote = lead(text, ab);
    return quote === undefined ? text : `${quote}${ab}${text.slice(quote.length + ab.length + prefix.length)}`;
  };
  const maps = (text: string, ab: string) => text === "/dev/null" || lead(text, ab) !== undefined;
  // A path may hold the separator itself (`a b/<scope>/c.md`), so of the splits where both sides map, the one is taken
  // that names the sides the file's other header lines name, else one naming the same path twice, else the first.
  // The CLI takes the first (VERIFY F1).
  const pair = (text: string, between: string, known: (string | undefined)[]): [string, string] | undefined => {
    const both: [string, string][] = [];
    for (let at = text.indexOf(between); at >= 0; at = text.indexOf(between, at + 1)) {
      const a = text.slice(0, at), b = text.slice(at + between.length);
      if (maps(a, "a/") && maps(b, "b/")) both.push([a, b]);
    }
    const fits = (one: string, k: string | undefined) => k === undefined || one === k || one === "/dev/null";
    const named = known.some((k) => k !== undefined) ? both.find(([a, b]) => fits(a, known[0]) && fits(b, known[1])) : undefined;
    return named ?? both.find(([a, b]) => a.replace(/^("?)a\//, "$1") === b.replace(/^("?)b\//, "$1")) ?? both[0];
  };
  const joined = (split: [string, string] | undefined, text: string, between: string) => (split ? `${side(split[0], "a/")}${between}${side(split[1], "b/")}` : text);
  // What a file's header lines after its `diff --git` say its two sides are, as that line writes them.
  const sidesOf = (lines: string[], from: number): (string | undefined)[] => {
    const known: (string | undefined)[] = [undefined, undefined];
    const token = (path: string, ab: string) => (path.startsWith('"') ? `"${ab}${path.slice(1)}` : `${ab}${path}`);
    for (let k = from; k < lines.length && !lines[k]!.startsWith("diff --git ") && !lines[k]!.startsWith("@@"); k++) {
      const line = lines[k]!;
      if (line.startsWith("--- ") && line !== "--- /dev/null") known[0] = line.slice(4);
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") known[1] = line.slice(4);
      else for (const [start, at, ab] of [["rename from ", 0, "a/"], ["copy from ", 0, "a/"], ["rename to ", 1, "b/"], ["copy to ", 1, "b/"]] as const) if (line.startsWith(start)) known[at] = token(line.slice(start.length), ab);
    }
    return known;
  };
  const sides: [string, string][] = [["--- ", "a/"], ["+++ ", "b/"], ["rename from ", ""], ["rename to ", ""], ["copy from ", ""], ["copy to ", ""]];
  const lines = patch.split("\n");
  let header = true;
  let file: (string | undefined)[] = [];
  return lines.map((line, n) => {
    if (line.startsWith("diff --git ")) {
      header = true;
      const split = pair(line.slice(11), " ", sidesOf(lines, n + 1));
      file = split ?? [];
      return `diff --git ${joined(split, line.slice(11), " ")}`;
    }
    if (line.startsWith("@@")) header = false;
    if (!header) return line;
    for (const [start, ab] of sides) if (line.startsWith(start)) return `${start}${side(line.slice(start.length), ab)}`;
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) return `Binary files ${joined(pair(line.slice(13, -7), " and ", file), line.slice(13, -7), " and ")} differ`;
    return line;
  }).join("\n");
}
