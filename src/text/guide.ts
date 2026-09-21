import { REASONS } from "../errors.js";
import { path, reasonsOf, version, type Method, type Schema } from "../method.js";

/**
 * The guide text (spec 04), at most 16 KiB. The prose is written for the
 * fourteen methods this version registers (S4.4); the method and error sections
 * are generated from the table, so they cannot disagree with the declaration (S4.3).
 */

const PROSE = `# Syns: the session's repository, from a page

## When this applies

Only when the session's folder is a Syns repository. A page finds out at load: look for \`syns.repo\` in \`context.get\`, then call it. Absent, or \`unavailable\` with reason \`no_repo\`: say so on the page and keep the rest working. The page never names a repository, a session or a folder; it is always the repository of the session that owns the page. Never show invented data in its place.

## Versions

\`version\` is a commit id: forty hexadecimal characters, opaque. Compare it for equality, pass it back, show it to nobody. \`number\` is the same version as a small integer, for display only. \`blob\` is a file's content hash: it changes exactly when the file's content changes, so two listings tell you which files to re-read without reading them.

Pages show published state. An agent's edits in the folder reach a page after its turn ends and is pushed.

## Loading a wiki

1. \`syns.ls { recursive: true }\` — every file with its \`blob\`, and the \`version\` it was listed at. If \`truncated\` is true the listing is incomplete: list folder by folder instead.
2. \`syns.readMany { paths, version }\` in groups of up to 64, passing the \`version\` from step 1 so every file is from one snapshot. Follow \`deferred\`: ask again with those paths and the same \`version\` until it is empty. An entry with \`error\` did not load; the others did. A file answered \`too_large\` is read in windows of lines with \`syns.read\`.

300 files is one \`syns.ls\` and about five \`syns.readMany\` calls, well inside the host's shared budget of 120 calls a minute. One call per file is not.

## Finding things

\`syns.glob\` finds files by path pattern; \`syns.grep\` searches their texts with a regular expression and answers matches with line numbers (\`output: "content"\`, the default), the matching paths (\`"files"\`) or a count for each path (\`"count"\`). \`context\` applies only with \`"content"\` and is refused otherwise. \`skipped\` names files the search could not read, such as binary ones. \`syns.glob\` is paged like \`syns.ls\`: follow \`nextOffset\`, passing \`version\` on. \`syns.grep\` lowers the most \`headLimit\` it accepts as \`context\` grows, so an answer always fits; it says the most in its refusal.

## Staying current

Poll only \`syns.repo\`, with the host's \`watch\`; it is one cheap call. When its \`version\` differs from the one you hold, call \`syns.diff { from }\` with the held one: it lists each changed path with its \`status\` (\`added\`, \`modified\`, \`deleted\`) up to the head, which it names as \`to.version\`. Re-read only those paths with \`syns.readMany\` at \`to.version\`, drop the deleted ones, and hold \`to.version\` from then on. \`patch: true\` adds each file's patch text, to show the reader what changed. There is no push and no change feed.

\`syns.history { limit: 5 }\` says who made the change. Read \`by\`: when \`by.run\` is this page's own session id the page made it; when \`by.run\` is another bb session id a page of that session made it; when \`by.run\` is null it came from outside bb pages — an agent's push, the CLI, the web, or a \`syns.revert\`.

## Writing

Every write but \`syns.revert\` carries \`base\`: the \`version\` the page last read. One file's whole text: \`syns.write\`. A new file: \`syns.write\` with \`create: true\`, which refuses rather than overwrite. One passage of a file: \`syns.edit\`, where \`old\` must occur exactly once unless \`replaceAll\` is true. Remove a path: \`syns.rm\`. Several changes as one version, all or nothing: \`syns.commit\`. Every write is published at once, with no confirmation, to everyone who shares the repository, so make clear what a control will change before the reader touches it.

- \`conflict\` / \`stale_head\`: someone changed the repository since \`base\`. Nothing was written. \`detail.current\` is the head now. Re-read, show the reader what changed, let them try again. Never retry blindly: that writes over a change the reader has not seen.
- \`conflict\` / \`checkout_dirty\`: an agent is mid-turn in this session's folder. Nothing was written. Say the agent is working, and try again when \`syns.repo\` reports a new \`version\`.
- \`conflict\` / \`exists\`: \`create: true\`, and the path is already there. Nothing was written. Offer the existing file, or ask for another name.
- \`no_match\`, \`many_matches\`: the file does not hold \`old\` once. Nothing was written. Re-read the file; \`detail.count\` says how many times it occurs.
- \`changed: 0\` from \`syns.commit\` or \`syns.rm\` means nothing differed, or the path was already gone, and no version was made.

After a successful write, take the returned \`version\` as the new \`base\`.

\`syns.revert { path, to }\` puts one file back to its text at an earlier version. Today it has no stale check and no provenance: it takes no \`base\`, so it can write over a change the reader has not seen, and \`syns.history\` shows its commit with \`by\` all null, like a change from outside. Call \`syns.repo\` just before offering it, and say what it will overwrite. It gains \`base\` when the CLI does.
`;

const CANNOT = `## What a page cannot do here

Choose a repository: it is the session's. Read unpublished edits: only pushed state is visible. Be pushed a change: poll \`syns.repo\`. Write without a \`base\`, but for \`syns.revert\` today. Set a commit's provenance: the plugin records the page's session on every commit but a revert's. Run a CLI command: each method is one fixed operation.
`;

const kib = (bytes: number): string => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)}M` : `${bytes / 1024}K`);

/** A schema in one line, from the same object the host is sent. */
function render(schema: Schema): string {
  if (schema === path) return "path";
  if (schema.pattern === version.pattern) return Array.isArray(schema.type) ? "version | null" : "version";
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const one = (type: string): string => {
    if (type === "object") {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required ?? []) as string[];
      const fields = Object.entries(properties).map(([key, child]) => `${key}${required.includes(key) ? "" : "?"}: ${render(child)}`);
      return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
    }
    if (type === "array") {
      const count = schema.minItems !== undefined || schema.maxItems !== undefined ? ` (${schema.minItems ?? 0}–${schema.maxItems ?? "…"})` : "";
      return `[${render(schema.items as Schema)}]${count}`;
    }
    if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join(" | ");
    if (type === "string") return schema.maxLength !== undefined ? `string(≤${schema.maxLength})` : "string";
    if (type === "integer" && (schema.minimum !== undefined || schema.maximum !== undefined)) return `integer(${schema.minimum ?? "…"}–${schema.maximum ?? "…"})`;
    return type;
  };
  return types.map(one).join(" | ");
}

function methodSection(table: readonly Method[]): string {
  const blocks = table.map((method) =>
    [
      `### \`${method.name}\` — ${method.effect} · ${kib(method.maxRequestBytes)} / ${kib(method.maxResponseBytes)}`,
      method.description,
      `- Params: \`${render(method.params)}\``,
      `- Result: \`${render(method.result)}\``,
      `- Reasons: ${reasonsOf(method).map((reason) => `\`${reason}\``).join(", ")}`,
    ].join("\n"),
  );
  return `## Every method\n\n\`path\` is repository-relative with \`/\` separators, at most 1,024 characters; it may not begin with \`/\` or \`-\`, hold a \`\\\` or a control character, or have a \`.\` or \`..\` segment. Bounds are request / response. A \`?\` marks an optional key; no other key is accepted.\n\n${blocks.join("\n\n")}\n`;
}

function errorSection(table: readonly Method[]): string {
  const declared = [...new Set(table.flatMap(reasonsOf))];
  const rows = declared.map((reason) => `- \`${REASONS[reason].code}\` / \`${reason}\` — ${REASONS[reason].meaning}`);
  return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`: \`conflict\` means re-read, \`unavailable\` means not now or not here, \`not_found\` means it is not there. The \`message\` is a sentence a reader may be shown.\n\n${rows.join("\n")}\n- \`not_found\` — the path, or the \`version\`, does not exist.\n- \`invalid_params\` — the parameters do not fit the method; fix the page.\n- \`response_too_large\` — ask for less: a narrower \`path\`, a smaller \`limit\`.\n- \`handler_error\` — anything else; the plugin's log names the cause.\n`;
}

export function buildGuide(table: readonly Method[]): string {
  return [PROSE, methodSection(table), errorSection(table), CANNOT].join("\n").trim();
}
