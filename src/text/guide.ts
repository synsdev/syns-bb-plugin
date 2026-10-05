import { REASONS } from "../errors.js";
import { EVERY_CHANGE, EVERY_METHOD, EVERY_WRITE, path, reasonsOf, version, type Method, type Schema } from "../method.js";

/**
 * The guide text (spec 04), at most 16 KiB. The prose is written for the
 * sixteen methods this version registers (S4.4); the method and error sections
 * are generated from the table, so they cannot disagree with the declaration (S4.3).
 */

const PROSE = `# Syns: the session's repository, from a page

## When this applies

Only when the session's folder is a Syns repository, or a folder placed in one. At load, look for \`syns.repo\` in \`context.get\` and call it. Absent, or \`unavailable\` / \`no_repo\`: say so on the page and keep the rest working. The page never names a repository, session or folder. Never show invented data in its place.

## A placed folder

A folder placed in a repository (a tool) is all the page sees: every \`path\` sent or answered is counted from it; nothing outside is reachable. \`syns.repo\` adds \`holder\` (OWNER/NAME) and \`path\`, where the folder stands: show those. \`owner\`, \`name\`, \`role\`, \`visibility\` and \`fileCount\` are the holder's; build no path or link from them. \`version\` is the holder's head, moving with any change to the holder, so \`syns.diff\` may list nothing. Once the CLI checks writes against the folder only, a write is \`stale_head\` only when the folder changed after \`base\`; before, any change to the holder. Writes publish to all who share the holder.

## Versions

\`version\` is a commit id, forty hex characters, opaque: compare it, pass it back, show it to nobody. \`number\` is the same version as a small integer, for display. \`blob\` is a file's content hash: it changes exactly when the content does, so two listings say which files to re-read.

## Loading a wiki

1. \`syns.ls { recursive: true }\`: every file with its \`blob\`, and the \`version\` listed. \`truncated: true\` means incomplete: list folder by folder.
2. \`syns.readMany { paths, version }\` in groups of up to 64, passing that \`version\`. Follow \`deferred\` with the same \`version\` until it is empty. An entry with \`error\` did not load. \`too_large\` carries \`size\`; the bound counts the text as JSON escapes it (a quote or newline is two). Read it with \`syns.read\`.

300 files: one \`syns.ls\` and about five \`syns.readMany\`, inside the shared 120 calls a minute.

After a \`syns.read { fit: true }\` window, read on from \`offset + limit\`. Its lines are joined with \`\\n\`, without \`\\r\` or a final newline, so to write a file back exactly, read it with \`syns.readMany\`.

## Finding things

\`syns.glob\` matches paths; \`syns.grep\` searches texts by regular expression, answering lines (\`output: "content"\`, the default, the only one taking \`context\`), paths (\`"files"\`) or counts (\`"count"\`). \`skipped\` names files it could not read. \`syns.glob\` pages like \`syns.ls\`: follow \`nextOffset\`, passing \`version\`.

## Staying current

Poll only \`syns.repo\`, with the host's \`watch\`. When its \`version\` differs from the one held, \`syns.diff { from }\` with the held one lists each changed path and \`status\` (\`added\`, \`modified\`, \`deleted\`) up to \`to.version\`. Re-read those with \`syns.readMany\` at \`to.version\` and hold it. \`patch: true\` adds each patch. There is no push.

\`syns.history { limit }\` says who changed what. A page's write has \`by.integration\` \`syns-bb-plugin\` and \`by.trigger\` \`thread-page\`; then \`by.run\` is the bb session whose page made it. Others set \`by.run\` too (an agent's push names its session): never read it alone as a page's. \`syns.revert\` records none. Its \`path\` matches one file exactly.

## Pictures

Join the decoded pieces of \`syns.readBinary\`; \`sha256\` and \`mediaType\` describe the whole file. \`syns.writeBinary { path, base64, base }\` stores up to 720 KiB in one call; a larger file goes in 720 KiB pieces, in order, each with \`offset\`, \`size\` and the whole file's \`sha256\`, answering \`complete: false\` and \`received\` until the last publishes it. \`bad_offset\`: send from \`detail.expected\` (0: start again). For a picture beside texts in one version, gather it with \`hold: true\` and name its \`upload\` in a \`syns.commit\` file.

## Writing

Every write but \`syns.revert\` carries \`base\`, the \`version\` last read. One file's text: \`syns.write\`; a new file: with \`create: true\`, which refuses rather than overwrite. One passage: \`syns.edit\`, \`old\` occurring once unless \`replaceAll\`. Remove: \`syns.rm\`. Several changes as one version: \`syns.commit\`. Writes publish at once, unconfirmed, to everyone sharing the repository: say what a control changes before it is used. A request past a method's bound (1 MiB for \`syns.write\`, measured as JSON) comes back from the bridge as \`invalid_response\`: split the change.

- \`changed: 0\`: nothing differed (\`syns.commit\`, \`syns.edit\` with \`old\` equal to \`new\`) or the path was gone (\`syns.rm\`); no version made.

After a write, the returned \`version\` is the new \`base\`.

\`syns.revert { path, to }\` restores a file's text at an earlier version. It has no stale check and no provenance: it takes no \`base\`, so it can overwrite a change the reader has not seen. Call \`syns.repo\` just before offering it, and say what it overwrites.
`;

const TOOLS = `## A document's folder

A document may set a scope: a folder inside the session's folder. Every \`syns.*\` call from it then answers for that folder alone, as if it were the repository, its paths counted from it; \`bad_scope\` means the scope left the session's folder. \`syns.place { template, path, version? }\` places a template (OWNER/NAME) as a new folder, and always runs at the session's folder, whatever the scope: \`occupied\` if \`path\` holds files, \`no_such_template\` if the reader cannot read it. A document scoped to that folder then works on it alone.
`;

const CANNOT = `## What a page cannot do here

Choose a repository, or reach outside a placed folder: the session's folder decides. Read unpublished edits. Write without a \`base\`, but for \`syns.revert\`. Set a commit's provenance. Run a CLI command: each method is one fixed operation.
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
      // A key whose type is its own name (version, path) is written once.
      const fields = Object.entries(properties).map(([key, child]) => { const type = render(child); return `${key}${required.includes(key) ? "" : "?"}${type === key ? "" : `: ${type}`}`; });
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
  const shared = new Set<string>([...EVERY_METHOD, ...(method.effect === "contributed-write" ? EVERY_CHANGE : []), ...(method.effect === "contributed-write" && !method.unguarded ? EVERY_WRITE : [])]);
  return reasonsOf(method).filter((reason) => !shared.has(reason));
};

function methodSection(table: readonly Method[]): string {
  const blocks = table.map((method) =>
    [
      `### \`${method.name}\` — ${method.effect} · ${kib(method.maxRequestBytes)} / ${kib(method.maxResponseBytes)}`,
      `- Params: \`${render(method.params)}\``,
      `- Result: \`${render(method.result)}\``,
      ...(own(method).length > 0 ? [`- Reasons: ${own(method).map((reason) => `\`${reason}\``).join(", ")}`] : []),
    ].join("\n"),
  );
  return `## Every method\n\n\`path\` is counted from the repository's root, or the placed folder, with \`/\` separators, at most 1,024 characters; it may not begin with \`/\` or \`-\`, hold a \`\\\` or a control character, or have a \`.\` or \`..\` segment. Each method's description is in the host's roster above (*Registered now*). Bounds are request / response. A \`?\` marks an optional key; a bare \`version\` or \`path\` key has that type; no other key is accepted. Every method may answer ${EVERY_METHOD.map((reason) => `\`${reason}\``).join(", ")}; every write ${EVERY_CHANGE.map((reason) => `\`${reason}\``).join(", ")}, and all but \`syns.revert\` ${EVERY_WRITE.map((reason) => `\`${reason}\``).join(", ")}. Other reasons are listed.\n\n${blocks.join("\n\n")}\n`;
}

function errorSection(table: readonly Method[]): string {
  const declared = [...new Set(table.flatMap(reasonsOf))];
  const rows = declared.map((reason) => `- \`${REASONS[reason].code}\` / \`${reason}\` — ${REASONS[reason].meaning}`);
  return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`: \`conflict\` means re-read, \`unavailable\` means not now or not here, \`not_found\` means it is not there. The \`message\` is a sentence a reader may be shown.\n\n${rows.join("\n")}\n- \`not_found\` — the path, or the \`version\`, does not exist.\n- \`invalid_params\` — the parameters do not fit the method; fix the page.\n- \`response_too_large\` — ask for less: a narrower \`path\`, a smaller \`limit\`.\n- \`handler_error\` — anything else; the plugin's log names the cause.\n`;
}

export function buildGuide(table: readonly Method[]): string {
  return [PROSE, TOOLS, methodSection(table), errorSection(table), CANNOT].join("\n").trim();
}
