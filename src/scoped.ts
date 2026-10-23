import { SynsError, fail } from "./errors.js";
import { path, pathGlob, repoPath, type Method, type Schema } from "./method.js";

/**
 * A call's scope in the server half (S1.25, D85): the method's paths count from that folder of the repository, and
 * what it answers is cut back to count from it, anything outside dropped. Which values are paths is read from the
 * schemas alone: `path` and `pathGlob` in params, `repoPath` in results. The host half checks the folder (S2.31).
 */

/** A write or read naming a path that leaves the scope (a `..` segment, a leading `/`) is outside it: `bad_scope`, before the params are checked. */
export function refuseEscape(schema: Schema, value: unknown): void {
  if (schema === path || schema === pathGlob) {
    if (typeof value === "string" && (value.startsWith("/") || value.split("/").includes(".."))) throw fail("bad_scope");
  } else if (Array.isArray(value)) {
    if (schema.items) for (const item of value) refuseEscape(schema.items as Schema, item);
  } else if (typeof value === "object" && value !== null && schema.properties) {
    const properties = schema.properties as Record<string, Schema>;
    for (const [key, child] of Object.entries(value)) if (Object.hasOwn(properties, key)) refuseEscape(properties[key]!, child);
  }
}

/** The params the method runs with: every `path` and `pathGlob` value under the scope; an absent root `path` is the scope. */
export function scopeParams(method: Method, params: Record<string, unknown>, scope: string): Record<string, unknown> {
  const given = under(method.params, params, scope) as Record<string, unknown>;
  if (method.rootPath && given.path === undefined) given.path = scope;
  return given;
}

function under(schema: Schema, value: unknown, scope: string): unknown {
  if (schema === path || schema === pathGlob) return typeof value === "string" ? `${scope}/${value}` : value;
  if (Array.isArray(value)) return schema.items ? value.map((item) => under(schema.items as Schema, item, scope)) : value;
  if (typeof value === "object" && value !== null && schema.properties) {
    const properties = schema.properties as Record<string, Schema>;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, Object.hasOwn(properties, key) ? under(properties[key]!, child, scope) : child]));
  }
  return value;
}

const OUTSIDE = Symbol("outside the scope");

/** The result the page gets: each repository path counted from the scope; one outside dropped, with the list item holding it. */
export function scopeResult(method: Method, result: unknown, scope: string): unknown {
  const kept = within(method.result, result, `${scope}/`, false);
  if (kept === OUTSIDE) throw new SynsError("handler_error", { log: `${method.name} answered a path outside the call's scope` });
  return kept;
}

function within(schema: Schema, value: unknown, prefix: string, item: boolean): unknown {
  if (schema === repoPath) return typeof value !== "string" ? value : value.startsWith(prefix) ? value.slice(prefix.length) : OUTSIDE;
  if (Array.isArray(value)) return schema.items ? value.map((one) => within(schema.items as Schema, one, prefix, true)).filter((one) => one !== OUTSIDE) : value;
  if (typeof value === "object" && value !== null && schema.properties) {
    const properties = schema.properties as Record<string, Schema>;
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const one = Object.hasOwn(properties, key) ? within(properties[key]!, child, prefix, false) : child;
      // What names a path outside is outside; so is a list item whose paths are all outside (a commit elsewhere).
      if (one === OUTSIDE) return OUTSIDE;
      if (item && properties[key]?.items === repoPath && Array.isArray(one) && one.length === 0) return OUTSIDE;
      kept[key] = one;
    }
    return kept;
  }
  return value;
}
