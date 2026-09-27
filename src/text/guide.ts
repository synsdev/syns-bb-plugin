import { REASONS } from "../errors.js";
import { EVERY_METHOD, EVERY_WRITE, path, reasonsOf, version, type Method, type Schema } from "../method.js";

/**
 * The guide text (spec 04), at most 16 KiB. The prose is written for the
 * fourteen methods this version registers (S4.4); the method and error sections
 * are generated from the table, so they cannot disagree with the declaration (S4.3).
 */

const PROSE = `# Syns: the session's repository, from a page

## When this applies

Only when the session's folder is a Syns repository. At load, look for \`syns.repo\` in \`context.get\` and call it. Absent, or \`unavailable\` / \`no_repo\`: say so on the page and keep the rest working. The page never names a repository, session or folder. Never show invented data in its place.

## Versions

\`version\` is a commit id, forty hex characters, opaque: compare it, pass it back, show it to nobody. \`number\` is the same version as a small integer, for display. \`blob\` is a file's content hash: it changes exactly when the content does, so two listings say which files to re-read. Pages show published state: an agent's edits arrive after its turn is pushed.

## Loading a wiki

1. \`syns.ls { recursive: true }\`: every file with its \`blob\`, and the \`version\` listed. \`truncated: true\` means incomplete: list folder by folder.
2. \`syns.readMany { paths, version }\` in groups of up to 64, passing that \`version\`. Follow \`deferred\` with the same \`version\` until it is empty. An entry with \`error\` did not load. \`too_large\` carries \`size\`: the bound is on the text as JSON escapes it, a quote, backslash or newline counting twice, so a file of quotes stops near 500 KB. Read it with \`syns.read\`.

300 files is one \`syns.ls\` and about five \`syns.readMany\`, inside the host's shared 120 calls a minute. One call per file is not.

\`syns.read\` cuts a window short to fit one answer: \`limit\` says how many lines came; read on from \`offset + limit\`. Its lines are joined with \`\\n\`, without \`\\r\` or a final newline, so to write a file back exactly, read it with \`syns.readMany\`.

## Finding things

\`syns.glob\` matches paths; \`syns.grep\` searches texts with a regular expression, answering lines (\`output: "content"\`, the default, the only one taking \`context\`), paths (\`"files"\`) or counts (\`"count"\`). \`skipped\` names files it could not read. \`syns.glob\` pages like \`syns.ls\`: follow \`nextOffset\`, passing \`version\`. \`syns.grep\` lowers the most \`headLimit\` it takes as \`context\` grows, and names it when refusing.

## Staying current

Poll only \`syns.repo\`, with the host's \`watch\`. When its \`version\` differs from the one held, \`syns.diff { from }\` with the held one lists each changed path and \`status\` (\`added\`, \`modified\`, \`deleted\`) up to \`to.version\`. Re-read those with \`syns.readMany\` at \`to.version\` and hold it. \`patch: true\` adds each patch. There is no push.

\`syns.history { limit }\` (at most 100) says who changed what. \`by.run\` is this page's session id when the page made it, another bb session id when that session's page did, null from outside pages: an agent's push, the CLI, the web, or \`syns.revert\`. Its \`path\` matches one file exactly: a folder answers nothing.

## Writing

Every write but \`syns.revert\` carries \`base\`, the \`version\` last read. One file's text: \`syns.write\`; a new file: with \`create: true\`, which refuses rather than overwrite. One passage: \`syns.edit\`, \`old\` occurring once unless \`replaceAll\`. Remove: \`syns.rm\`. Several changes as one version: \`syns.commit\`. Writes publish at once, unconfirmed, to everyone sharing the repository: say what a control changes before it is used. A request past a method's bound (1 MiB for \`syns.write\`, measured as JSON) comes back from the bridge as \`invalid_response\`: split the change.

- \`conflict\` / \`stale_head\`: the repository moved past \`base\`; nothing written; \`detail.current\` is the head. Re-read, show what changed, let the reader retry. Never retry blindly.
- \`conflict\` / \`checkout_dirty\`: the session's folder holds unpublished edits, usually its agent mid-turn. Nothing written. Say so; retry when \`syns.repo\`'s \`version\` moves.
- \`conflict\` / \`exists\`: \`create: true\` and the path is there. Nothing written.
- \`no_match\`, \`many_matches\`: \`old\` is not in the file once (\`detail.count\`). Nothing written; re-read.
- \`changed: 0\`: nothing differed (\`syns.commit\`, \`syns.edit\` with \`old\` equal to \`new\`) or the path was gone (\`syns.rm\`); no version made.

After a write, the returned \`version\` is the new \`base\`.

\`syns.revert { path, to }\` restores a file's text at an earlier version. It has no stale check and no provenance: it takes no \`base\`, so it can overwrite a change the reader has not seen. Call \`syns.repo\` just before offering it, and say what it overwrites.
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

/** A method's reasons beyond the ones every method, and every guarded write, answers: those are said once. */
const own = (method: Method): string[] => {
  const shared = new Set<string>([...EVERY_METHOD, ...(method.effect === "contributed-write" && !method.unguarded ? EVERY_WRITE : [])]);
  return reasonsOf(method).filter((reason) => !shared.has(reason));
};

function methodSection(table: readonly Method[]): string {
  const blocks = table.map((method) =>
    [
      `### \`${method.name}\` — ${method.effect} · ${kib(method.maxRequestBytes)} / ${kib(method.maxResponseBytes)}`,
      method.description,
      `- Params: \`${render(method.params)}\``,
      `- Result: \`${render(method.result)}\``,
      ...(own(method).length > 0 ? [`- Reasons: ${own(method).map((reason) => `\`${reason}\``).join(", ")}`] : []),
    ].join("\n"),
  );
  return `## Every method\n\n\`path\` is repository-relative with \`/\` separators, at most 1,024 characters; it may not begin with \`/\` or \`-\`, hold a \`\\\` or a control character, or have a \`.\` or \`..\` segment. Bounds are request / response. A \`?\` marks an optional key; no other key is accepted. Every method may answer ${EVERY_METHOD.map((reason) => `\`${reason}\``).join(", ")}; every write but \`syns.revert\` also ${EVERY_WRITE.map((reason) => `\`${reason}\``).join(", ")}. Other reasons are listed.\n\n${blocks.join("\n\n")}\n`;
}

function errorSection(table: readonly Method[]): string {
  const declared = [...new Set(table.flatMap(reasonsOf))];
  const rows = declared.map((reason) => `- \`${REASONS[reason].code}\` / \`${reason}\` — ${REASONS[reason].meaning}`);
  return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`: \`conflict\` means re-read, \`unavailable\` means not now or not here, \`not_found\` means it is not there. The \`message\` is a sentence a reader may be shown.\n\n${rows.join("\n")}\n- \`not_found\` — the path, or the \`version\`, does not exist.\n- \`invalid_params\` — the parameters do not fit the method; fix the page.\n- \`response_too_large\` — ask for less: a narrower \`path\`, a smaller \`limit\`.\n- \`handler_error\` — anything else; the plugin's log names the cause.\n`;
}

export function buildGuide(table: readonly Method[]): string {
  return [PROSE, methodSection(table), errorSection(table), CANNOT].join("\n").trim();
}
