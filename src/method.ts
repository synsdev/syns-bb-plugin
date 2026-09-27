import type { Limits } from "./cli.js";
import type { Reason } from "./errors.js";

/**
 * The type of one entry of the method table (D17, S2.21), the schema pieces
 * entries share, and the check of a value against a schema.
 *
 * Schemas are written in the JSON Schema subset Thread Pages accepts from a
 * contributor, because they are sent to it as they stand: type, properties,
 * required, additionalProperties, enum, minimum, maximum, minLength, maxLength,
 * pattern, items, minItems, maxItems, description. There is no anyOf.
 */
export type Schema = Record<string, unknown>;

export const K64 = 64 * 1024;
export const M1 = 1024 * 1024;

/** Left for the host's envelope around a result: `{ v, id, ok, result }`, its id at most 96 characters. */
export const ENVELOPE = 1024;

/** How many bytes a value takes on the wire: its JSON, where a quote or a newline in a text is two characters. */
export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** What a method's own procedure is given. */
export interface Context {
  /** The session the host says is calling. The provenance `run` of a write. S1.5 */
  readonly sessionId: string;
  readonly limits: Limits;
  /** Runs the CLI in the session's folder and returns its parsed output, or throws a SynsError. */
  syns(args: string[], stdin?: string): Promise<unknown>;
}

export interface Command {
  args: string[];
  stdin?: string;
}

interface Common {
  /** `syns.<name>` */
  name: string;
  /** At most 240 characters (the host's bound). */
  description: string;
  effect: "read" | "contributed-write";
  /** Closed, every string bounded. S1.1 */
  params: Schema;
  result: Schema;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Reasons beyond the ones every method, and every write, declares. */
  reasons?: readonly Reason[];
  /** What a schema cannot say. Throws a SynsError; runs before any process. */
  check?(params: any): void;
  /** A write whose CLI command takes no parent and has no guard (`syns.revert`, D13): it cannot answer stale_head or checkout_dirty, so it does not declare them (D29). */
  unguarded?: true;
  /** How many paths a write names, for the plugin's log. Defaults to one when there is a `path`. S2.19 */
  pathCount?(params: any): number;
}

/** One CLI process: parameters become arguments and standard input, the parsed output becomes the result. */
export interface SimpleMethod extends Common {
  command(params: any, sessionId: string): Command;
  shape(output: Record<string, unknown>, params: any): unknown;
}

/** More than one CLI process: the method supplies its own small procedure. S2.22 */
export interface ProcedureMethod extends Common {
  procedure(params: any, context: Context): Promise<unknown>;
}

export type Method = SimpleMethod | ProcedureMethod;

export const EVERY_METHOD: readonly Reason[] = ["no_repo", "no_access", "cli_missing", "timeout"];
export const EVERY_WRITE: readonly Reason[] = ["stale_head", "checkout_dirty"];

/** Every reason a method can answer with: the common ones, a write's, and its own. S3.2 */
export const reasonsOf = (method: Method): Reason[] => [...EVERY_METHOD, ...(method.effect === "contributed-write" && !method.unguarded ? EVERY_WRITE : []), ...(method.reasons ?? [])];

// --- shared schema pieces ---------------------------------------------------

/** A closed object. */
export const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", additionalProperties: false, properties, required });

/**
 * S2.9: not empty, at most 1,024 characters, not beginning with `/` or `-`, no
 * `\`, no control character, no segment equal to `.` or `..`.
 */
export const path: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern: "^(?![/-])(?!(?:.*/)?\\.{1,2}(?:/|$))[^\\\\\\u0000-\\u001f\\u007f-\\u009f]+$",
};

/** A commit SHA, opaque to the page (D12). */
export const version: Schema = { type: "string", pattern: "^[0-9a-f]{40}$", maxLength: 40 };

/** The `version` the page last read; every write against a parent requires it. S1.4 */
export const base: Schema = version;

/** S1.6 */
export const message: Schema = { type: "string", maxLength: 500 };

export const nullable = (type: "string" | "integer" | "boolean"): Schema => ({ type: [type, "null"] });

/** The provenance of a page's commit (D6, S1.5). A page can set none of the three. */
export const provenance = (sessionId: string): Record<string, string> => ({ integration: "syns-bb-plugin", trigger: "thread-page", run: sessionId });

// --- checking a value -------------------------------------------------------

const typeMatches = (type: string, value: unknown): boolean => {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
};

/**
 * The first way `value` fails `schema`, or null. The same subset, read the same
 * way, as the host's own check; here it refuses bad parameters before any
 * process runs, and refuses a CLI output with a hole in it (S3.7).
 */
export function validate(schema: Schema, value: unknown, at = "$"): string | null {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (value === undefined) return `${at}: missing`;
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) return `${at}: expected ${types.join(" or ")}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at}: not one of the allowed values`;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at}: too short`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at}: too long`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${at}: not an accepted form`;
  } else if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${at}: below ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${at}: above ${schema.maximum}`;
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at}: too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at}: too many items`;
    for (let index = 0; index < value.length; index += 1) {
      const problem = validate(schema.items as Schema, value[index], `${at}[${index}]`);
      if (problem) return problem;
    }
  } else if (typeof value === "object" && value !== null) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const record = value as Record<string, unknown>;
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(record).find((key) => !Object.hasOwn(properties, key));
      if (unknown !== undefined) return `${at}.${unknown}: unknown key`;
    }
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key) || record[key] === undefined) return `${at}.${key}: missing`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
      const problem = validate(child, record[key], `${at}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}
