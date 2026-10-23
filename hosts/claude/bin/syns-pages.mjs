import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
//#region src/cli.ts
const CLI_NOT_FOUND = "cli_not_found";
/** The host half's answer when a scoped cwd is not a Syns folder inside the session's folder, once symlinks are followed (D43, D46). */
const SCOPE_OUTSIDE = "scope_outside";
const LIMITS = {
	processMs: 2e4,
	callMs: 25e3,
	perMachine: 16
};
/**
* The argument array of one CLI run: every option as `--option=value`, always
* `--json`, every positional after `--`. A value a page supplied can therefore
* never be read as a flag. A list repeats its option once for each value.
* S2.11, S2.13
*/
function buildArgs(verb, options = {}, positionals = []) {
	const args = typeof verb === "string" ? [verb] : [...verb];
	for (const [name, value] of Object.entries(options)) {
		if (value === void 0 || value === false) continue;
		if (typeof value === "object") args.push(...value.map((one) => `--${name}=${one}`));
		else args.push(value === true ? `--${name}` : `--${name}=${value}`);
	}
	args.push("--json");
	if (positionals.length > 0) args.push("--", ...positionals);
	return args;
}
const TIMED_OUT = {
	exitCode: null,
	stdout: "",
	stderr: "",
	timedOut: true,
	spawnError: null,
	overflowed: false
};
function createCli(runner, limits = LIMITS) {
	const machines = /* @__PURE__ */ new Map();
	return {
		limits,
		async run(where, args, stdin, deadline, env, signal) {
			if (signal?.aborted) return TIMED_OUT;
			let machine = machines.get(where.hostId);
			if (!machine) machines.set(where.hostId, machine = {
				running: 0,
				waiting: []
			});
			const slots = machine;
			if (slots.running >= limits.perMachine) {
				if (!await new Promise((resolve) => {
					const take = () => {
						signal?.removeEventListener("abort", leave);
						resolve(true);
					};
					const leave = () => {
						const at = slots.waiting.indexOf(take);
						if (at !== -1) slots.waiting.splice(at, 1);
						resolve(false);
					};
					slots.waiting.push(take);
					signal?.addEventListener("abort", leave, { once: true });
				})) return TIMED_OUT;
			} else slots.running += 1;
			try {
				const left = deadline - Date.now();
				if (left <= 0 || signal?.aborted) return TIMED_OUT;
				const input = stdin === void 0 ? {} : typeof stdin === "string" ? { stdin } : { stdinBase64: stdin.toString("base64") };
				return await runner.run({
					hostId: where.hostId,
					cwd: where.cwd,
					...where.within ? { within: where.within } : {},
					args,
					...env ? { env } : {},
					...input,
					timeoutMs: Math.min(limits.processMs, left),
					...signal ? { signal } : {}
				});
			} finally {
				const next = slots.waiting.shift();
				if (next) next();
				else slots.running -= 1;
			}
		}
	};
}
//#endregion
//#region src/errors.ts
const SHA = {
	type: "string",
	pattern: "^[0-9a-f]{40}$",
	maxLength: 40
};
/** `LIM-file-size`: the most one file in Syns may hold (D-088, HOST_FACTS §12). */
const FILE_MAX = 26214400;
const REASONS = {
	no_repo: {
		code: "unavailable",
		message: "This session's folder is not a Syns repository.",
		meaning: "The session's folder holds no Syns repository, or the caller is the home page."
	},
	no_access: {
		code: "unavailable",
		message: "The Syns account on this session's machine cannot reach the repository, or is logged out.",
		meaning: "The machine's account cannot reach the repository, or is logged out."
	},
	not_logged_in: {
		code: "unavailable",
		message: "Nobody is logged in to Syns on this session's machine. Run syns login there.",
		meaning: "No Syns login on that machine: someone runs syns login there."
	},
	cli_missing: {
		code: "unavailable",
		message: "The Syns command-line tool was not found on this session's machine.",
		meaning: "No syns on that machine; an operator installs it or names it in the plugin's settings."
	},
	timeout: {
		code: "unavailable",
		message: "Syns did not answer in time. Try again.",
		meaning: "The CLI did not answer in time. Retry a read; after a write, re-read syns.repo first."
	},
	folder_out_of_place: {
		code: "unavailable",
		message: "This session's folder is not where its repository records it, so Syns will not use it.",
		meaning: "A placed folder stands away from the path its identity file records; an operator moves it back."
	},
	folder_write_unsupported: {
		code: "unavailable",
		message: "The Syns server cannot take writes from inside a placed folder yet. Nothing was written.",
		meaning: "The server is too old for writes in a placed folder. Nothing written; reads work."
	},
	occupied: {
		code: "conflict",
		message: "That folder already holds files. Nothing was placed.",
		meaning: "path already holds a file at the head or on disk; choose another."
	},
	no_such_template: {
		code: "not_found",
		message: "That template does not exist, or this account cannot read it.",
		meaning: "template is no repository the reader can read."
	},
	bad_scope: {
		code: "invalid_params",
		message: "This page asked for something its folder cannot do here: it is not a placed folder of its session's repository, or this action needs another kind of folder.",
		meaning: "The scope is not a placed folder of the session's own repository, or the CLI does not act there: a folder action at a root, a holder action in a placed folder, a folder's people before it is shared."
	},
	stale_head: {
		code: "conflict",
		message: "The repository changed since this page last read it. Nothing was written.",
		meaning: "The repository, or placed folder, changed after base; nothing written; detail.current is the head. Re-read, show what changed, never retry blindly.",
		detail: {
			type: "object",
			properties: { current: SHA },
			required: ["current"]
		}
	},
	checkout_dirty: {
		code: "conflict",
		message: "An agent is working in this session's folder and has unpublished edits. Nothing was written; try again when its turn ends.",
		meaning: "The session's folder has unpublished edits, usually its agent mid-turn. Nothing written; retry when syns.repo's version moves."
	},
	exists: {
		code: "conflict",
		message: "A file is already there. Nothing was written.",
		meaning: "create was set and the path exists at base."
	},
	no_match: {
		code: "invalid_params",
		message: "The text to replace was not found in the file. Nothing was written.",
		meaning: "old occurs nowhere in the file."
	},
	many_matches: {
		code: "invalid_params",
		message: "The text to replace occurs more than once in the file. Nothing was written.",
		meaning: "old occurs detail.count times and replaceAll is not set.",
		detail: {
			type: "object",
			properties: { count: {
				type: "integer",
				minimum: 2
			} },
			required: ["count"]
		}
	},
	bad_pattern: {
		code: "invalid_params",
		message: "The search pattern could not be understood.",
		meaning: "The regular expression or glob does not parse."
	},
	bad_offset: {
		code: "conflict",
		message: "The picture's pieces did not arrive in order, or were dropped. Send it again from the offset expected.",
		meaning: "Send the piece at detail.expected; 0 means start again (pieces or an upload are dropped after a minute).",
		detail: {
			type: "object",
			properties: { expected: {
				type: "integer",
				minimum: 0
			} },
			required: ["expected"]
		}
	},
	bad_hash: {
		code: "invalid_params",
		message: "The picture that arrived is not the one described. Nothing was written.",
		meaning: "The gathered bytes do not match sha256; nothing published."
	},
	too_large: {
		code: "invalid_params",
		message: "The file is larger than one file in Syns may be. Nothing was written.",
		meaning: "Past detail.max bytes, the most one file may hold (25 MiB).",
		detail: {
			type: "object",
			properties: { max: { type: "integer" } },
			required: ["max"]
		}
	},
	bad_name: {
		code: "invalid_params",
		message: "That name cannot be used. Use lower-case letters, digits, dots, dashes and underscores.",
		meaning: "name breaks the repository-name rule."
	},
	name_taken: {
		code: "conflict",
		message: "That name is already taken. Nothing was shared.",
		meaning: "Another repository holds name; offer the reader another."
	},
	not_permitted: {
		code: "unavailable",
		message: "Syns refused this for this account: it may need a higher role, or a limit was reached.",
		meaning: "Syns answered 403 for this account: a role too low for it, or a server limit. The CLI says no more."
	},
	no_such_user: {
		code: "not_found",
		message: "There is no Syns user by that name or e-mail.",
		meaning: "user names nobody on Syns."
	},
	already_collaborator: {
		code: "conflict",
		message: "That person already has access to this folder.",
		meaning: "user already holds a grant here; nothing changed."
	},
	invalid_change: {
		code: "invalid_params",
		message: "The change names a path twice, or changes nothing. Nothing was written.",
		meaning: "A path named twice across files and deletions, or no change at all."
	}
};
/** bad_scope's sentence when the CLI says the placed folder is not shared yet (D63). */
const NOT_SHARED_YET = "This folder is not shared yet: share it first, then add people to it. If it was just shared, try again after the next sync.";
/** Sentences for failures that carry a code and no reason. */
const CODE_MESSAGES = {
	invalid_params: "The page sent parameters this method does not accept.",
	not_found: "That path or version does not exist in the repository.",
	conflict: "The repository changed. Nothing was written.",
	unavailable: "Syns is not available for this session right now.",
	handler_error: "Syns could not complete this. The plugin's log has the cause.",
	unknown_method: "The Syns plugin has no such method.",
	response_too_large: "The answer is too large to return. Ask for less at a time."
};
var SynsError = class extends Error {
	code;
	reason;
	detail;
	/** For the plugin's log only (S2.18). Never sent to a page. */
	log;
	/** Set on a not_found that is known to be about the version rather than a path. */
	subject;
	constructor(code, options = {}) {
		super(options.message ?? (options.reason ? REASONS[options.reason].message : CODE_MESSAGES[code]));
		this.code = code;
		if (options.reason) this.reason = options.reason;
		if (options.detail) this.detail = options.detail;
		if (options.log) this.log = options.log;
		if (options.subject) this.subject = options.subject;
	}
};
const fail = (reason, detail) => new SynsError(REASONS[reason].code, {
	reason,
	...detail ? { detail } : {}
});
function toAnswer(error) {
	return {
		ok: false,
		error: {
			code: error.code,
			message: error.message.slice(0, 300),
			...error.reason ? { reason: error.reason } : {},
			...error.detail ? { detail: error.detail } : {}
		}
	};
}
function parse(text) {
	try {
		return { value: JSON.parse(text) };
	} catch {
		return null;
	}
}
/** One path character: none of the white space, quotes and punctuation that end a path in a sentence. */
const PATH_CHAR = String.raw`[^\s'"` + "`" + String.raw`,;()\[\]]`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
* The CLI's words with local paths taken out, before they reach a page (D60,
* D61): the session's folder becomes `.`, and every other absolute path
* `<path>`, POSIX or Windows, a `file://` URL included. A quoted path is
* replaced whole, spaces and all. A template's code may send what it is shown
* elsewhere; a username and a folder layout are not its to send. The log keeps
* the raw text.
*/
function redact(text, where = {}) {
	let out = text;
	const folder = where.folder?.replace(/[\\/]+$/, "");
	if (folder && folder.length > 1) out = out.replace(new RegExp(`${escape(folder)}(?=[\\\\/]|$|[\\s'"\`,;:)\\]])`, "g"), ".");
	const absolute = String.raw`(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)`;
	return out.replace(new RegExp(String.raw`(['"` + "`" + String.raw`])${absolute}[^'"` + "`" + String.raw`\n]*\1`, "g"), (_, quote) => `${quote}<path>${quote}`).replace(new RegExp(String.raw`file:\/\/${PATH_CHAR}*`, "g"), "<path>").replace(new RegExp(String.raw`\\\\${PATH_CHAR}+`, "g"), "<path>").replace(new RegExp(String.raw`(?<![\w])[A-Za-z]:[\\/]${PATH_CHAR}*`, "g"), "<path>").replace(new RegExp(String.raw`(?<![\w.:/<\\])\/${PATH_CHAR}+`, "g"), "<path>");
}
/** The first line of standard error that starts `error:`, or nothing. */
const stderrError = (stderr) => stderr.split("\n").find((line) => line.startsWith("error:")) ?? "";
/** Whether `whoami --json` says nobody is logged in on the machine (HOST_FACTS §8). Anything else, a timeout included, is no. */
async function signedOut(runWhoami) {
	const run = await runWhoami();
	if (run.exitCode !== 1 || run.spawnError !== null || run.timedOut) return false;
	const parsed = parse(run.stdout);
	const error = parsed && typeof parsed.value === "object" && parsed.value !== null ? parsed.value.error : void 0;
	return typeof error === "string" && error.includes("authentication required");
}
async function interpret(run, declared, runRepo, where = {}, runWhoami) {
	if (run.spawnError !== null) {
		if (run.spawnError === "cli_not_found") throw fail("cli_missing");
		if (run.spawnError === "scope_outside") throw fail("bad_scope");
		throw new SynsError("handler_error", { log: `could not start: ${run.spawnError.slice(0, 500)}` });
	}
	if (run.timedOut) throw fail("timeout");
	if (run.overflowed) throw new SynsError("response_too_large");
	const parsed = parse(run.stdout);
	if (run.exitCode === 0) {
		if (!parsed) throw new SynsError("handler_error", { log: `exit=0 output is not JSON (${run.stdout.length} characters)` });
		return parsed.value;
	}
	const document = parsed && typeof parsed.value === "object" && parsed.value !== null ? parsed.value : {};
	const error = typeof document.error === "string" ? document.error : "";
	const exit = run.exitCode;
	if (exit === 7 && typeof document.currentSha === "string") throw fail("stale_head", { current: document.currentSha });
	if (exit === 2 && error.includes("cannot determine repo identity")) throw fail("no_repo");
	if (exit === 2 && error.startsWith("folder out of place")) throw fail("folder_out_of_place");
	if (exit === 1 && error.startsWith("folder_write_unsupported")) throw fail("folder_write_unsupported");
	if (exit === 1 && error.includes("holds unpublished local changes")) throw fail("checkout_dirty");
	if (exit === 1 && error.includes("authentication required")) throw fail("not_logged_in");
	if (exit === 1 && error.includes("--old matched no content")) throw fail("no_match");
	if (exit === 1 && error.startsWith("configuration error") && error.includes(" already holds ")) throw fail("occupied");
	if (exit === 1 && error.startsWith("not_found:") && error.includes("is no repository you can read")) throw fail("no_such_template");
	if (exit === 1 && error.includes("the folder path must name a folder")) throw fail("bad_scope");
	if (exit === 1 && error.includes("holds no folder placed from a template")) throw fail("bad_scope");
	if (exit === 2 && error.startsWith("holder root required") && error.includes("acts on a shared folder's own people")) throw new SynsError("invalid_params", {
		reason: "bad_scope",
		message: NOT_SHARED_YET
	});
	if (exit === 2 && error.startsWith("holder root required")) throw fail("bad_scope");
	if (exit === 1 && error.includes("configuration error: a name holds") && declared.includes("bad_name")) throw fail("bad_name");
	if (exit === 1 && error.includes("(403)")) throw fail(declared.includes("not_permitted") ? "not_permitted" : "no_access");
	if (exit === 1 && error.includes("no user '") && declared.includes("no_such_user")) throw fail("no_such_user");
	if (exit === 1 && error.includes("(409)") && declared.includes("name_taken")) throw fail("name_taken");
	if (exit === 1 && error.includes("(409)") && declared.includes("already_collaborator")) throw fail("already_collaborator");
	const times = exit === 1 ? /--old matched (\d+) times/.exec(error) : null;
	if (times) throw fail("many_matches", { count: Number(times[1]) });
	if (exit === 1 && error.includes("(404)")) {
		const repo = await runRepo();
		if (repo.exitCode === 0 && repo.spawnError === null && !repo.timedOut) throw new SynsError("not_found", where.notFound ? { message: where.notFound } : {});
		if (runWhoami && await signedOut(runWhoami)) throw fail("not_logged_in");
		throw fail("no_access");
	}
	if (exit === 1 && error.includes("invalid pattern")) throw fail("bad_pattern");
	if (exit === 1 && error.startsWith("payload_too_large")) throw fail("too_large", { max: FILE_MAX });
	if (exit === 1 && error.includes("path not found at version")) throw new SynsError("not_found");
	if (exit === 1 && error.includes("version not found")) throw new SynsError("not_found", { subject: "version" });
	const words = redact((error || stderrError(run.stderr)).trim(), where);
	throw new SynsError("handler_error", {
		...words ? { message: words.slice(0, 300) } : {},
		log: `exit=${exit} output=${(run.stdout + run.stderr).trim().slice(0, 500)}`
	});
}
//#endregion
//#region src/method.ts
const K64 = 65536;
const M1 = 1048576;
/** Left for the host's envelope around a result: `{ v, id, ok, result }`, its id at most 96 characters. */
const ENVELOPE = 1024;
/** How many bytes a value takes on the wire: its JSON, where a quote or a newline in a text is two characters. */
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const EVERY_METHOD = [
	"no_repo",
	"no_access",
	"not_logged_in",
	"cli_missing",
	"timeout",
	"folder_out_of_place",
	"bad_scope"
];
/** Every write, syns.revert included: a placed folder's write against a server without folder writes (D38). */
const EVERY_CHANGE = ["folder_write_unsupported"];
const EVERY_WRITE = ["stale_head", "checkout_dirty"];
/** Every reason a method can answer with: the common ones, a write's, and its own. S3.2 */
const reasonsOf = (method) => [
	...EVERY_METHOD,
	...fileWrite(method) ? EVERY_CHANGE : [],
	...fileWrite(method) && !method.unguarded ? EVERY_WRITE : [],
	...method.reasons ?? []
];
/** A write of a repository's files, as opposed to a sharing change (D41). */
const fileWrite = (method) => method.effect === "contributed-write" && !method.sharing;
/** A closed object. */
const object = (properties, required = []) => ({
	type: "object",
	additionalProperties: false,
	properties,
	required
});
/**
* S2.9: not empty, at most 1,024 characters, not beginning with `/` or `-`, no
* `\`, no control character, no segment equal to `.` or `..`.
*/
const path = {
	type: "string",
	minLength: 1,
	maxLength: 1024,
	pattern: "^(?![/-])(?!(?:.*/)?\\.{1,2}(?:/|$))[^\\\\\\u0000-\\u001f\\u007f-\\u009f]+$"
};
/** A commit SHA, opaque to the page (D12). */
const version = {
	type: "string",
	pattern: "^[0-9a-f]{40}$",
	maxLength: 40
};
/** The `version` the page last read; every write against a parent requires it. S1.4 */
const base = version;
/** S1.6 */
const message = {
	type: "string",
	maxLength: 500
};
const nullable = (type) => ({ type: [type, "null"] });
/** The provenance of a page's commit (D6, S1.5). A page can set none of the three. */
const provenance = (sessionId) => ({
	integration: "syns-pages",
	trigger: "page",
	run: sessionId
});
const typeMatches = (type, value) => {
	switch (type) {
		case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array": return Array.isArray(value);
		case "integer": return typeof value === "number" && Number.isSafeInteger(value);
		case "null": return value === null;
		default: return typeof value === type;
	}
};
/**
* The first way `value` fails `schema`, or null. The same subset, read the same
* way, as the host's own check; here it refuses bad parameters before any
* process runs, and refuses a CLI output with a hole in it (S3.7).
*/
function validate(schema, value, at = "$") {
	const types = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === void 0) return `${at}: missing`;
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
			const problem = validate(schema.items, value[index], `${at}[${index}]`);
			if (problem) return problem;
		}
	} else if (typeof value === "object" && value !== null) {
		const properties = schema.properties ?? {};
		const record = value;
		if (schema.additionalProperties === false) {
			const unknown = Object.keys(record).find((key) => !Object.hasOwn(properties, key));
			if (unknown !== void 0) return `${at}.${unknown}: unknown key`;
		}
		for (const key of schema.required ?? []) if (!Object.hasOwn(record, key) || record[key] === void 0) return `${at}.${key}: missing`;
		for (const [key, child] of Object.entries(properties)) {
			if (!Object.hasOwn(record, key) || record[key] === void 0) continue;
			const problem = validate(child, record[key], `${at}.${key}`);
			if (problem) return problem;
		}
	}
	return null;
}
/**
* Named groups of result keys several methods share, so the guide prints each
* once (D56): a result holding all of a group's keys, as the same schema
* objects, is written `…name` there.
*/
/** The not_found sentence of the methods that name no path or version (fix round 1, finding 3). */
const NOT_FOUND = "Syns answered that what this asked for is not there.";
const GROUPS = /* @__PURE__ */ new Map();
const group = (name, properties) => {
	GROUPS.set(name, properties);
	return properties;
};
/**
* The CLI's own JSON, kept to what `schema` names (S1.7): each named key whose
* value has a type the schema allows, objects and lists kept the same way.
* Nothing is renamed or made up; a key the CLI did not report stays absent,
* and the result's check (S3.7) refuses a required one that is missing.
*/
function pick(schema, value, at = "$", dropped) {
	const kept = keep$1(schema, value, at, dropped);
	if (kept === void 0 && value !== void 0) dropped?.push(at);
	return kept;
}
function keep$1(schema, value, at, dropped) {
	const types = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === null) return types.includes("null") ? null : void 0;
	if (Array.isArray(value)) return types.includes("array") ? value.map((item, index) => pick(schema.items, item, `${at}[${index}]`, dropped)).filter((item) => item !== void 0) : void 0;
	if (typeof value === "object") {
		if (!types.includes("object")) return void 0;
		const properties = schema.properties ?? {};
		const record = value;
		const kept = {};
		for (const [key, child] of Object.entries(properties)) {
			if (!Object.hasOwn(record, key)) continue;
			const one = pick(child, record[key], `${at}.${key}`, dropped);
			if (one !== void 0) kept[key] = one;
		}
		return kept;
	}
	const type = typeof value === "number" && Number.isSafeInteger(value) && types.includes("integer") ? "integer" : typeof value;
	return types.includes(type) ? value : void 0;
}
//#endregion
//#region src/text/fragment.ts
/**
* The instruction fragment (spec 04): read by every eligible session, every time, on any host. It leads with the
* workspace line (S4.6): when it applies, in words (S4.2), and that the page opens inside the repository's workspace
* with nothing to add, since the plugin's page script brings it (S2.27). Then the two steps an agent takes before its
* first page, and where apps go. It is declared to the host with the method list and injected nowhere else (S4.1).
* The declaration is the same on every host (07 R-X1), so the text names no host's command. The owner's text
* (IN-0056 §4), verbatim; the protocol allows 2,048 bytes.
*/
const FRAGMENT = `**Syns workspace.** When this session's folder is empty or a Syns repository, your page opens inside the repository's workspace, beside its files and apps; nothing to add to your page. Before your first page in a session:
- No \`.page/index.html\`: \`mkdir -p .page && syns cat .page/index.html --repo bartsoj/syns-workspace-light-template > .page/index.html\`
- No \`.syns.yaml\`: \`syns push -n <a short name for this work> --visibility private\`

Make what the person will keep using an app: a folder holding an \`index.html\`; the workspace runs it with \`syns.*\` counted from that folder (the guide's *syns* section). The workspace itself is the repository's \`.page/index.html\`: change it as the person asks.
`;
//#endregion
//#region src/text/guide.ts
const PROSE = `# Syns: the session's repository, from a page

## When this applies

Only when the session's folder is a Syns repository, or a folder placed in one. At load, look for \`syns.repo\` in \`context.get\` and call it. Absent, or \`unavailable\` / \`no_repo\`: say so on the page and keep the rest working. The page never names a repository, session or folder. Never show invented data in its place.

## A placed folder

A folder placed in a repository (a tool) is all the page sees: every \`path\` is counted from it; nothing outside is reachable. A document may also set a scope (\`threadPage.setScope\`): a placed folder of the session's own repository, holding its own identity file; its calls then answer for that folder alone. \`bad_scope\` refuses anything else: a plain folder, one below a placed folder, another checkout, a folder outside the session's, or any scope where the session's folder is no Syns repository. \`syns.repo\` adds \`holder\` (OWNER/NAME) and \`path\`: show those. \`owner\`, \`name\`, \`role\`, \`visibility\` and \`fileCount\` are the holder's; build no path or link from them. \`version\` is the holder's head, so \`syns.diff\` may list nothing. Once the CLI checks writes against the folder only, a write is \`stale_head\` only when the folder changed after \`base\`; before, any change to the holder. Writes publish to all who share the holder. \`syns.place { template, path }\` places a template as a new folder, always at the session's folder.

## Versions

\`version\` is a commit id, opaque: compare it, pass it back, show it to nobody. \`number\` is the same version for display. \`blob\` changes exactly when a file's content does.

## Loading a wiki

1. \`syns.ls { recursive: true }\`: every file with its \`blob\`, and the \`version\` listed. \`truncated: true\` means incomplete: list folder by folder.
2. \`syns.readMany { paths, version }\` in groups of up to 64, passing that \`version\`; follow \`deferred\` the same way. \`too_large\` carries \`size\` when known (the bound counts the text as JSON escapes it): read it with \`syns.read\`.

300 files: one \`syns.ls\` and about five \`syns.readMany\`, inside the shared 120 calls a minute. A \`syns.read\` window's lines are joined with \`\\n\`, without \`\\r\` or a final newline: to write a file back exactly, read it with \`syns.readMany\`.

## Staying current

Poll only \`syns.repo\`, with the host's \`watch\`. When its \`version\` differs from the one held, \`syns.diff { from }\` lists each changed path and \`status\` up to \`to.version\`; re-read those at \`to.version\`. There is no push.

\`syns.history\` says who changed what. A page's write has \`by.integration\` \`syns-pages\` and \`by.trigger\` \`page\`; then \`by.run\` is the session whose page made it. Others set \`by.run\` too: never read it alone as a page's. \`syns.revert\` records none.

## Writing

Every file write but \`syns.revert\` carries \`base\`, the \`version\` last read; the returned \`version\` is the next \`base\`. A new file: \`syns.write\` with \`create: true\`, which refuses rather than overwrite. \`changed: 0\`: nothing differed, or the path was gone; no version made. A request past a method's bound comes back from the bridge as \`invalid_response\`: split it. \`syns.revert\` has no stale check and no provenance: call \`syns.repo\` just before offering it, and say what it overwrites. A picture larger than 720 KiB goes in ordered pieces; \`bad_offset\`: send from \`detail.expected\`. Beside texts in one version: \`hold: true\`, then its \`upload\` in \`syns.commit\`.
`;
const SHARING = `## Sharing and people

Each method acts where the CLI acts, in the page's own scope. In a placed folder: \`syns.shareInfo\`, \`syns.share\`, \`syns.unshare\`, \`syns.folderVisibility\`, \`syns.enableChecks\`. At a repository's root: \`syns.repoVisibility\`. The collaborator methods act on the scope's people: in a shared placed folder its own (until shared, \`bad_scope\` saying to share first); at a root the **whole repository's**, so never offer root people for one folder. Elsewhere the CLI refuses: \`bad_scope\`; show controls only where they apply (\`syns.repo\`'s \`holder\`, \`syns.shareInfo\`'s \`shared\`). \`syns.collaboratorRole\` and \`syns.collaboratorRemove\` take the \`user.id\` that \`syns.collaborators\` answers; find someone with \`syns.users\`. Roles are the CLI's; a shared folder takes \`read\` or \`write\`.

They act at once, with no dialog, and reach other people. So:

- **Only from a control the reader presses for that action:** never on load, from a timer or \`watch\`, or chained after another call.
- **The control shows who gets what** before it is pressed: the person and the role, or everyone the folder reaches. \`admin\` can also share, change visibility and manage people: say so.
- **Public is labelled apart:** "anyone, signed in or not, can find and read this". Never a default; never one option in a list beside private. A public name beginning with a private holder's name shows that name: say so first.
- **\`syns.unshare\`** removes everyone who reached the folder through it; its name stays reserved.

Poll none of these with \`watch\`. Errors come back from the CLI: a refusal with no reason carries the CLI's own words as \`message\`.
`;
const CANNOT = `## What a page cannot do here

Choose a repository, or reach outside its scope. Read unpublished edits. Write a file without a \`base\`, but for \`syns.revert\`. Set a commit's provenance. Run any CLI command but the ones behind these methods: no login, upgrade, push, pull, sync, delete or fork.
`;
/** The guide's short names for JSON types, said once in the method section's opening. */
const SHORT = {
	integer: "int",
	boolean: "bool"
};
/** A schema in one line, from the same object the host is sent. */
function render(schema, grouping = true) {
	if (schema === path) return "path";
	if (schema.pattern === version.pattern) return Array.isArray(schema.type) ? "version|null" : "version";
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	const one = (type) => {
		if (type === "object") {
			const properties = schema.properties ?? {};
			const required = schema.required ?? [];
			const grouped = [...GROUPS].filter(() => grouping).filter(([, keys]) => Object.entries(keys).every(([key, child]) => properties[key] === child));
			const inGroup = new Set(grouped.flatMap(([, keys]) => Object.keys(keys)));
			const fields = [...grouped.map(([name]) => `…${name}`), ...Object.entries(properties).filter(([key]) => !inGroup.has(key)).map(([key, child]) => {
				const type = render(child, grouping);
				return `${key}${required.includes(key) ? "" : "?"}${type === key ? "" : `: ${type}`}`;
			})];
			return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
		}
		if (type === "array") {
			const count = schema.minItems !== void 0 || schema.maxItems !== void 0 ? ` (${schema.minItems ?? 0}–${schema.maxItems ?? "…"})` : "";
			return `[${render(schema.items, grouping)}]${count}`;
		}
		if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join("|");
		if (type === "string") return schema.maxLength !== void 0 ? `string(≤${schema.maxLength})` : "string";
		if (type === "integer" && (schema.minimum !== void 0 || schema.maximum !== void 0)) return `int(${schema.minimum ?? "…"}–${schema.maximum ?? "…"})`;
		return SHORT[type] ?? type;
	};
	return types.map(one).join("|");
}
function methodSection(table) {
	const lines = table.map((method) => `- \`${method.name}\` \`${render(method.params)}\` → \`${render(method.result)}\``);
	return `## Every method\n\nThe host's roster above (*Registered now*) gives each method's effect, bounds, description and every reason it may answer. Each line below: the method, its params → its result. \`path\` is counted from the repository's root, or the placed folder, with \`/\` separators, at most 1,024 characters; no leading \`/\` or \`-\`, no \`\\\` or control character, no \`.\` or \`..\` segment. A \`?\` marks an optional key; a bare \`version\` or \`path\` key has that type; no other key is accepted. ${[...GROUPS].map(([name, keys]) => `\`…${name}\` is \`${render({
		type: "object",
		properties: keys
	}, false)}\`.`).join(" ")}\n\n${lines.join("\n")}\n`;
}
/** The codes a reason may carry, in the order the guide lists them, with what each means for the page. */
const CODES = [
	["unavailable", "not now or not here"],
	["conflict", "re-read"],
	["invalid_params", "fix the page; with no reason, the parameters do not fit the method"],
	["not_found", "it is not there; with no reason, the path, the `version`, or what was named"]
];
function errorSection(table) {
	const declared = [...new Set(table.flatMap(reasonsOf))];
	const named = new Map(CODES);
	return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`. \`message\` may be shown to the reader.\n\n${[...named.keys(), ...new Set(declared.map((reason) => REASONS[reason].code).filter((code) => !named.has(code)))].map((code) => {
		const rows = declared.filter((reason) => REASONS[reason].code === code).map((reason) => `- \`${reason}\` — ${REASONS[reason].meaning}`);
		return `\`${code}\`${named.has(code) ? `: ${named.get(code)}.` : ""}\n${rows.join("\n")}`.trim();
	}).join("\n\n")}\n\n\`response_too_large\`: ask for less. \`handler_error\`: anything else; \`message\` holds the CLI's own words when it gave some.\n`;
}
function buildGuide(table) {
	return [
		PROSE,
		SHARING,
		methodSection(table),
		errorSection(table),
		CANNOT
	].join("\n").trim();
}
//#endregion
//#region src/declaration.ts
/** The plugin's version, as declared to the host. A test holds it equal to package.json's. */
const VERSION = "0.10.0";
/** threadPagesContributions, generated from the table. With `agentInstructions` off no fragment is declared (S4.5); the page script is declared either way (S2.27). */
function buildDeclaration(table, settings) {
	return {
		version: VERSION,
		pageScript: true,
		methods: table.map((method) => ({
			name: method.name,
			description: method.description,
			effect: method.effect,
			params: method.params,
			result: method.result,
			maxRequestBytes: method.maxRequestBytes,
			maxResponseBytes: method.maxResponseBytes,
			reasons: Object.fromEntries(reasonsOf(method).map((reason) => {
				const entry = REASONS[reason];
				return [reason, {
					description: entry.meaning,
					...entry.detail ? { detail: entry.detail } : {}
				}];
			}))
		})),
		...settings.agentInstructions ? { instruction: FRAGMENT.trim() } : {},
		guide: buildGuide(table)
	};
}
//#endregion
//#region src/held.ts
/**
* What the server half holds between calls (D24–D27): a picture being gathered
* piece by piece, and a picture's bytes being handed out piece by piece. Memory
* only, never a file. Each entry is dropped a minute after it was last touched;
* all of them together hold at most 64 MiB, the oldest dropped first to make
* room; a session gathers at most two pictures at once.
*/
const HELD_TOTAL = 67108864;
const HELD_IDLE_MS = 6e4;
function createHeld(now = Date.now, total = HELD_TOTAL, idleMs = HELD_IDLE_MS) {
	const entries = /* @__PURE__ */ new Map();
	const sweep = () => {
		const cutoff = now() - idleMs;
		for (const [key, entry] of entries) if (entry.touched < cutoff) entries.delete(key);
	};
	const used = () => [...entries.values()].reduce((sum, entry) => sum + entry.reserved, 0);
	return {
		get(key) {
			sweep();
			const entry = entries.get(key);
			if (!entry) return void 0;
			entry.touched = now();
			entries.delete(key);
			entries.set(key, entry);
			return entry;
		},
		put(key, value, reserved) {
			sweep();
			entries.delete(key);
			for (const [other] of entries) {
				if (used() + reserved <= total) break;
				entries.delete(other);
			}
			entries.set(key, Object.assign(value, {
				touched: now(),
				reserved
			}));
		},
		drop(key) {
			entries.delete(key);
		},
		gathering(session) {
			sweep();
			return [...entries.entries()].filter(([, entry]) => entry.kind === "upload" && entry.session === session && !entry.complete).map(([key]) => key);
		},
		used
	};
}
//#endregion
//#region src/methods/binary.ts
/**
* Pictures (D23–D27, roadmap 212, D-088). Bytes cross the bridge as base64, at
* most PIECE bytes a call either way, so a piece and its fields fit one 1 MiB
* call. A larger picture is read, or gathered for a write, piece by piece; the
* plugin holds it in memory between calls (held.ts).
*/
/** 720 KiB: 983,040 characters of base64, a multiple of three bytes so no piece carries padding but the last. */
const PIECE = 737280;
/** Base64, whole groups of four, padding only at the end. */
const base64 = {
	type: "string",
	maxLength: PIECE / 3 * 4,
	pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
};
const sha256 = {
	type: "string",
	pattern: "^[0-9a-f]{64}$",
	maxLength: 64
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const record$8 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
/** Held keys: a picture read, one being gathered, one gathered whole and kept for syns.commit. */
const readKey = (session, at, file) => `read|${session}|${at}|${file}`;
const gatherKey = (session, file, parent, digest) => `gather|${session}|${file}|${parent}|${digest}`;
const keptKey = (session, digest) => `kept|${session}|${digest}`;
const readBinary = {
	name: "syns.readBinary",
	description: "One file's bytes as base64 in pieces of up to 720 KiB, at version (default head). Follow nextOffset with the first piece's version until it is null.",
	effect: "read",
	params: object({
		path,
		version,
		offset: {
			type: "integer",
			minimum: 0,
			maximum: FILE_MAX
		}
	}, ["path"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			path: { type: "string" },
			size: { type: "integer" },
			blob: { type: "string" },
			mediaType: nullable("string"),
			sha256,
			offset: { type: "integer" },
			base64: { type: "string" },
			nextOffset: nullable("integer")
		},
		required: [
			"version",
			"number",
			"path",
			"size",
			"blob",
			"mediaType",
			"sha256",
			"offset",
			"base64",
			"nextOffset"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	check(params) {
		if ((params.offset ?? 0) > 0 && params.version === void 0) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readBinary: a later piece needs the version of the first" });
	},
	async procedure(params, context) {
		let held = params.version === void 0 ? void 0 : context.held.get(readKey(context.sessionId, params.version, params.path));
		if (!held) {
			const out = record$8(await context.syns(buildArgs("cat", { version: params.version }, [params.path])));
			const data = typeof out.contentBase64 === "string" ? Buffer.from(out.contentBase64, "base64") : typeof out.content === "string" ? Buffer.from(out.content, "utf8") : null;
			if (!data || typeof out.commitSha !== "string") throw new SynsError("handler_error", { log: "exit=0 cat carries neither content nor contentBase64" });
			held = {
				kind: "read",
				bytes: data,
				version: out.commitSha,
				number: out.version,
				path: params.path,
				blob: out.sha,
				mediaType: typeof out.mediaType === "string" ? out.mediaType : null,
				sha256: hash(data)
			};
			context.held.put(readKey(context.sessionId, held.version, params.path), held, data.length);
		}
		const offset = params.offset ?? 0;
		if (offset > held.bytes.length) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.readBinary: offset is past the file's ${held.bytes.length} bytes` });
		const end = Math.min(offset + PIECE, held.bytes.length);
		return {
			version: held.version,
			number: held.number,
			path: held.path,
			size: held.bytes.length,
			blob: held.blob,
			mediaType: held.mediaType,
			sha256: held.sha256,
			offset,
			base64: held.bytes.subarray(offset, end).toString("base64"),
			nextOffset: end < held.bytes.length ? end : null
		};
	}
};
/** `write --bytes` against base, the page's provenance, the bytes on standard input. */
async function publish(params, data, context) {
	const args = buildArgs("write", {
		bytes: true,
		parent: params.base,
		message: params.message || `Write ${params.path} from a page`.slice(0, 500),
		...provenance(context.sessionId)
	}, [params.path]);
	const out = record$8(await context.syns(args, data));
	return {
		complete: true,
		received: data.length,
		version: out.commitSha,
		number: out.version,
		changed: out.filesChanged
	};
}
/** Keep a gathered picture for a syns.commit that names it by its sha256 (D26). */
function keep(params, data, digest, context) {
	const kept = {
		kind: "upload",
		session: context.sessionId,
		path: params.path,
		base: params.base,
		size: data.length,
		sha256: digest,
		chunks: [data],
		received: data.length,
		complete: true
	};
	context.held.put(keptKey(context.sessionId, digest), kept, data.length);
	return {
		complete: true,
		received: data.length,
		upload: digest
	};
}
const writeBinary = {
	name: "syns.writeBinary",
	description: "Store a file's bytes against base: whole up to 720 KiB, or in ordered pieces with offset, size and sha256, published after the last. hold: true keeps it for syns.commit.",
	effect: "contributed-write",
	params: object({
		path,
		base64,
		base,
		message,
		offset: {
			type: "integer",
			minimum: 0,
			maximum: FILE_MAX
		},
		size: {
			type: "integer",
			minimum: 0,
			maximum: 2 * FILE_MAX
		},
		sha256,
		hold: { type: "boolean" }
	}, [
		"path",
		"base64",
		"base"
	]),
	result: {
		type: "object",
		properties: {
			complete: {
				type: "boolean",
				description: "false: send the piece at received. true: published (version, number, changed), or kept (upload)."
			},
			received: { type: "integer" },
			version,
			number: { type: "integer" },
			changed: { type: "integer" },
			upload: sha256
		},
		required: ["complete", "received"]
	},
	maxRequestBytes: M1,
	maxResponseBytes: K64,
	reasons: [
		"bad_offset",
		"bad_hash",
		"too_large"
	],
	check(params) {
		const given = [
			params.offset,
			params.size,
			params.sha256
		].filter((value) => value !== void 0).length;
		if (given !== 0 && given !== 3) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: a piece carries offset, size and sha256 together" });
		if (params.size !== void 0 && params.size > 26214400) throw fail("too_large", { max: FILE_MAX });
	},
	async procedure(params, context) {
		const piece = Buffer.from(params.base64, "base64");
		if (params.offset === void 0) {
			if (params.hold === true) return keep(params, piece, hash(piece), context);
			return publish(params, piece, context);
		}
		const size = params.size;
		const digest = params.sha256;
		const key = gatherKey(context.sessionId, params.path, params.base, digest);
		let gathering;
		if (params.offset === 0) {
			context.held.drop(key);
			const others = context.held.gathering(context.sessionId);
			for (const other of others.slice(0, Math.max(0, others.length - 2 + 1))) context.held.drop(other);
			gathering = {
				kind: "upload",
				session: context.sessionId,
				path: params.path,
				base: params.base,
				size,
				sha256: digest,
				chunks: [],
				received: 0,
				complete: false
			};
			context.held.put(key, gathering, size);
		} else {
			gathering = context.held.get(key);
			if (!gathering || gathering.received !== params.offset) throw fail("bad_offset", { expected: gathering?.received ?? 0 });
		}
		if (gathering.received + piece.length > size) {
			context.held.drop(key);
			throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: the pieces are longer than size" });
		}
		gathering.chunks.push(piece);
		gathering.received += piece.length;
		if (gathering.received < size) return {
			complete: false,
			received: gathering.received
		};
		context.held.drop(key);
		const data = Buffer.concat(gathering.chunks);
		if (hash(data) !== digest) throw fail("bad_hash");
		if (params.hold === true) return keep(params, data, digest, context);
		return publish(params, data, context);
	}
};
//#endregion
//#region src/methods/commit.ts
const pathsOf = (params) => [...(params.files ?? []).map((file) => file.path), ...params.deletions ?? []];
const record$7 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const commit = {
	name: "syns.commit",
	description: "Several changes as one new version against base, all or nothing: files, each with text, base64 bytes, or an upload held by syns.writeBinary, and deletions. No path twice. Published at once.",
	effect: "contributed-write",
	params: object({
		base,
		message,
		files: {
			type: "array",
			maxItems: 64,
			items: object({
				path,
				text: {
					type: "string",
					maxLength: M1
				},
				base64,
				upload: sha256
			}, ["path"])
		},
		deletions: {
			type: "array",
			maxItems: 64,
			items: path
		}
	}, ["base"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: nothing differed, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: M1,
	maxResponseBytes: K64,
	reasons: ["invalid_change", "bad_offset"],
	check(params) {
		for (const file of params.files ?? []) if ([
			file.text,
			file.base64,
			file.upload
		].filter((value) => value !== void 0).length !== 1) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.commit: each file carries exactly one of text, base64 and upload" });
		const paths = pathsOf(params);
		if (paths.length === 0 || new Set(paths).size !== paths.length) throw fail("invalid_change");
	},
	pathCount: (params) => pathsOf(params).length,
	async procedure(params, context) {
		const used = [];
		const files = (params.files ?? []).map((file) => {
			if (file.text !== void 0) return {
				path: file.path,
				content: file.text
			};
			if (file.base64 !== void 0) return {
				path: file.path,
				contentBase64: file.base64
			};
			const key = keptKey(context.sessionId, file.upload);
			const kept = context.held.get(key);
			if (!kept) throw fail("bad_offset", { expected: 0 });
			used.push(key);
			return {
				path: file.path,
				contentBase64: Buffer.concat(kept.chunks).toString("base64")
			};
		});
		const paths = pathsOf(params);
		const fallback = `Commit ${paths.length === 1 ? paths[0] : `${paths.length} paths`} from a page`.slice(0, 500);
		const stdin = JSON.stringify({
			files,
			deletions: (params.deletions ?? []).map((deleted) => ({ path: deleted }))
		});
		const out = record$7(await context.syns(buildArgs("commit", {
			parent: params.base,
			message: params.message || fallback,
			...provenance(context.sessionId)
		}), stdin));
		for (const key of used) context.held.drop(key);
		return {
			version: out.commitSha,
			number: out.version,
			changed: out.filesChanged
		};
	}
};
//#endregion
//#region src/methods/diff.ts
const record$6 = (value) => typeof value === "object" && value !== null ? value : {};
const end = {
	type: "object",
	properties: {
		version,
		number: { type: "integer" }
	},
	required: ["version", "number"]
};
const diff = {
	name: "syns.diff",
	description: "The net change between two versions: each changed path with its status (added, modified, deleted). to defaults to the head. patch: true adds each file's patch text. After the head moves, diff { from } says which files to re-read.",
	effect: "read",
	params: object({
		from: version,
		to: version,
		patch: { type: "boolean" }
	}, ["from"]),
	result: {
		type: "object",
		properties: {
			from: end,
			to: end,
			files: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						status: { type: "string" },
						patch: { type: "string" }
					},
					required: ["path", "status"]
				}
			}
		},
		required: [
			"from",
			"to",
			"files"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	async procedure(params, context) {
		let to = params.to;
		if (to === void 0) {
			const head = (await context.syns(buildArgs("repo")))?.commitSha;
			if (typeof head !== "string") throw new SynsError("not_found");
			to = head;
		}
		const out = record$6(await context.syns(buildArgs("diff", {
			from: params.from,
			to
		})));
		const ends = [record$6(out.from), record$6(out.to)].map((one) => ({
			version: one.sha,
			number: one.version
		}));
		return {
			from: ends[0],
			to: ends[1],
			files: Array.isArray(out.files) ? out.files.map(record$6).map((file) => ({
				path: file.path,
				status: file.status,
				...params.patch === true && typeof file.diff === "string" ? { patch: file.diff } : {}
			})) : void 0
		};
	}
};
//#endregion
//#region src/methods/edit.ts
const MAX_TEXT = 32768;
const NO_NUL = "^[^\\u0000]*$";
const record$5 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const edit = {
	name: "syns.edit",
	description: "Replace old with new in one file, as a new version made against base. old must occur exactly once unless replaceAll is true. old equal to new changes nothing: changed 0. Both at most 32,768 characters.",
	effect: "contributed-write",
	params: object({
		path,
		old: {
			type: "string",
			minLength: 1,
			maxLength: MAX_TEXT,
			pattern: NO_NUL
		},
		new: {
			type: "string",
			maxLength: MAX_TEXT,
			pattern: NO_NUL
		},
		replaceAll: { type: "boolean" },
		base,
		message
	}, [
		"path",
		"old",
		"new",
		"base"
	]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: old equals new, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: 131072,
	maxResponseBytes: K64,
	reasons: ["no_match", "many_matches"],
	async procedure(params, context) {
		if (params.old === params.new) {
			const newest = record$5(record$5(await context.syns(buildArgs("history", { limit: 1 }))).data?.[0]);
			if (typeof newest.sha !== "string" || typeof newest.version !== "number") throw new SynsError("handler_error", { log: "exit=0 history names no head" });
			if (newest.sha !== params.base) throw fail("stale_head", { current: newest.sha });
			return {
				version: newest.sha,
				number: newest.version,
				changed: 0
			};
		}
		const out = record$5(await context.syns(buildArgs("edit", {
			old: params.old,
			new: params.new,
			"replace-all": params.replaceAll === true,
			parent: params.base,
			message: params.message || `Edit ${params.path} from a page`.slice(0, 500),
			...provenance(context.sessionId)
		}, [params.path])));
		return {
			version: out.commitSha,
			number: out.version,
			changed: out.filesChanged
		};
	}
};
//#endregion
//#region src/methods/glob.ts
const PAGE$1 = 2e3;
const record$4 = (value) => typeof value === "object" && value !== null ? value : {};
const glob = {
	name: "syns.glob",
	description: "The files whose whole path matches a glob pattern such as notes/**/*.md, under path (default root), at version (default head). No match: an empty list. Paged: up to 2000 from offset; nextOffset is null on the last page.",
	effect: "read",
	params: object({
		pattern: {
			type: "string",
			minLength: 1,
			maxLength: 512
		},
		path,
		version,
		offset: {
			type: "integer",
			minimum: 0
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: PAGE$1
		}
	}, ["pattern"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			truncated: { type: "boolean" },
			total: { type: "integer" },
			nextOffset: nullable("integer"),
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						size: { type: "integer" },
						blob: { type: "string" }
					},
					required: [
						"path",
						"size",
						"blob"
					]
				}
			}
		},
		required: [
			"version",
			"number",
			"truncated",
			"total",
			"nextOffset",
			"matches"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	reasons: ["bad_pattern"],
	command: (params) => ({ args: buildArgs("glob", {
		path: params.path,
		version: params.version
	}, [params.pattern]) }),
	shape: (out, params) => {
		const all = Array.isArray(out.matches) ? out.matches.map(record$4) : void 0;
		const offset = params.offset ?? 0;
		const end = offset + (params.limit ?? PAGE$1);
		return {
			version: out.commitSha,
			number: out.version,
			truncated: out.truncated,
			total: all?.length,
			nextOffset: all === void 0 ? void 0 : end < all.length ? end : null,
			matches: all?.slice(offset, end).map((match) => ({
				path: match.path,
				size: match.size,
				blob: match.sha
			}))
		};
	}
};
//#endregion
//#region src/methods/grep.ts
const record$3 = (value) => typeof value === "object" && value !== null ? value : {};
const rows = (value) => Array.isArray(value) ? value.map(record$3) : void 0;
const lineAndText = {
	type: "object",
	properties: {
		line: { type: "integer" },
		text: { type: "string" }
	},
	required: ["line", "text"]
};
const mostRows = (params) => (params.output ?? "content") === "content" ? Math.min(1e3, Math.floor(9e3 / (5 + 6 * (params.context ?? 0)))) : 1e3;
const grep = {
	name: "syns.grep",
	description: "Regex search under path, in files matching glob, at version (default head). output: content (default), files or count. headLimit caps rows (default 200). At most 400 files a call: pass nextOffset as offset and the first page's version",
	effect: "read",
	params: object({
		pattern: {
			type: "string",
			minLength: 1,
			maxLength: 512
		},
		path,
		glob: {
			type: "array",
			maxItems: 8,
			items: {
				type: "string",
				minLength: 1,
				maxLength: 512
			}
		},
		ignoreCase: { type: "boolean" },
		context: {
			type: "integer",
			minimum: 0,
			maximum: 10,
			description: "Lines either side of each match. Only with output content."
		},
		output: {
			type: "string",
			enum: [
				"content",
				"files",
				"count"
			],
			maxLength: 7
		},
		headLimit: {
			type: "integer",
			minimum: 1,
			maximum: 1e3,
			description: "Rows at most: default 200, fewer with context."
		},
		offset: {
			type: "integer",
			minimum: 0,
			maximum: 4294967295,
			description: "Files to skip, in path order: the last call's nextOffset."
		},
		version
	}, ["pattern"]),
	result: {
		type: "object",
		description: "Beside the common keys, exactly one of matches, files and counts: the one output names.",
		properties: {
			version,
			number: { type: "integer" },
			output: {
				type: "string",
				enum: [
					"content",
					"files",
					"count"
				]
			},
			truncated: { type: "boolean" },
			nextOffset: nullable("integer"),
			skipped: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						reason: { type: "string" }
					},
					required: ["path", "reason"]
				}
			},
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						line: { type: "integer" },
						text: { type: "string" },
						context: {
							type: "array",
							items: lineAndText
						}
					},
					required: [
						"path",
						"line",
						"text",
						"context"
					]
				}
			},
			files: {
				type: "array",
				items: { type: "string" }
			},
			counts: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						count: { type: "integer" }
					},
					required: ["path", "count"]
				}
			}
		},
		required: [
			"version",
			"number",
			"output",
			"truncated",
			"nextOffset",
			"skipped"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	reasons: ["bad_pattern"],
	check(params) {
		if ((params.offset ?? 0) > 0 && params.version === void 0) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.grep: a later page needs the version of the first" });
		if ((params.headLimit ?? 0) > mostRows(params)) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.grep: with this output and context, headLimit can be at most ${mostRows(params)}` });
		if ((params.context ?? 0) > 0 && (params.output ?? "content") !== "content") throw new SynsError("invalid_params", { message: "Invalid parameters for syns.grep: context applies only with output content" });
	},
	command(params) {
		const content = (params.output ?? "content") === "content";
		return { args: buildArgs("grep", {
			path: params.path,
			glob: params.glob,
			"ignore-case": params.ignoreCase === true,
			"line-number": content,
			context: content && params.context ? params.context : void 0,
			output: params.output ?? "content",
			"head-limit": params.headLimit ?? Math.min(200, mostRows(params)),
			offset: params.offset ? params.offset : void 0,
			version: params.version
		}, [params.pattern]) };
	},
	shape(out) {
		const nextOffset = typeof out.nextOffset === "number" ? out.nextOffset : null;
		const common = {
			version: out.commitSha,
			number: out.version,
			output: out.output,
			truncated: out.truncated,
			nextOffset,
			skipped: rows(out.skipped)?.map((skip) => ({
				path: skip.path,
				reason: skip.reason
			}))
		};
		const found = out.output === "files" ? { files: Array.isArray(out.files) ? out.files : void 0 } : out.output === "count" ? { counts: rows(out.counts)?.map((count) => ({
			path: count.path,
			count: count.count
		})) } : { matches: rows(out.matches)?.map((match) => ({
			path: match.path,
			line: match.line,
			text: match.text,
			context: rows(match.context)?.map((line) => ({
				line: line.line,
				text: line.text
			}))
		})) };
		if (Object.values(found)[0] === void 0) throw new SynsError("handler_error", { log: `exit=0 the result lacks the rows of output ${String(out.output)}` });
		return {
			...common,
			...found
		};
	}
};
//#endregion
//#region src/methods/history.ts
const MAX_PATHS = 200;
const record$2 = (value) => typeof value === "object" && value !== null ? value : {};
const history = {
	name: "syns.history",
	description: "Newest versions first: who or what made each, and the paths it changed. A page's commit has by.integration syns-pages and by.trigger page. No paging past limit (default 20); total says how many.",
	effect: "read",
	params: object({
		path,
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100
		}
	}),
	result: {
		type: "object",
		properties: {
			total: { type: "integer" },
			entries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						version,
						number: { type: "integer" },
						parent: {
							...version,
							type: ["string", "null"]
						},
						author: nullable("string"),
						at: { type: "string" },
						message: { type: "string" },
						paths: {
							type: "array",
							items: { type: "string" },
							maxItems: MAX_PATHS
						},
						pathsTruncated: { type: "boolean" },
						by: {
							type: "object",
							properties: {
								integration: nullable("string"),
								run: nullable("string"),
								trigger: nullable("string")
							},
							required: [
								"integration",
								"run",
								"trigger"
							]
						}
					},
					required: [
						"version",
						"number",
						"parent",
						"author",
						"at",
						"message",
						"paths",
						"pathsTruncated",
						"by"
					]
				}
			}
		},
		required: ["total", "entries"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	command: (params) => ({ args: buildArgs("history", {
		file: params.path,
		limit: params.limit ?? 20
	}) }),
	shape: (out, params) => ({
		total: out.total,
		entries: Array.isArray(out.data) ? out.data.map(record$2).map((row) => {
			const paths = Array.isArray(row.filesChanged) ? row.filesChanged : typeof params.path === "string" ? [params.path] : void 0;
			const provenance = record$2(row.provenance);
			return {
				version: row.sha,
				number: row.version,
				parent: row.parentSha ?? null,
				author: row.author ?? null,
				at: row.createdAt,
				message: row.message,
				paths: paths?.slice(0, MAX_PATHS),
				pathsTruncated: paths ? paths.length > MAX_PATHS : void 0,
				by: {
					integration: provenance.integration ?? null,
					run: provenance.run ?? null,
					trigger: provenance.trigger ?? null
				}
			};
		}) : void 0
	})
};
//#endregion
//#region src/methods/ls.ts
const PAGE = 1500;
const LINES_PAGE = 9e3;
const record$1 = (value) => typeof value === "object" && value !== null ? value : {};
/** One entry as one string: `path\tblob\tsize`, a folder's blob and size empty. */
const line = (entry) => `${String(entry.path)}\t${entry.sha ?? ""}\t${entry.size ?? ""}`;
const ls = {
	name: "syns.ls",
	description: "Files and folders under path (default root), one level or recursive, at version (default head). blob changes exactly when content does. Paged from offset: 1500 entries, or 9000 with format lines; nextOffset null at the end. Pass version on.",
	effect: "read",
	params: object({
		path,
		recursive: { type: "boolean" },
		version,
		offset: {
			type: "integer",
			minimum: 0
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: LINES_PAGE,
			description: "At most 1500, or 9000 with format lines."
		},
		format: {
			type: "string",
			enum: ["lines"],
			maxLength: 5,
			description: "lines: each entry one string path\\tblob\\tsize in lines, a folder's blob and size empty."
		}
	}),
	result: {
		type: "object",
		description: "entries, or with format lines, lines.",
		properties: {
			version,
			number: { type: "integer" },
			truncated: { type: "boolean" },
			total: { type: "integer" },
			nextOffset: nullable("integer"),
			entries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						type: {
							type: "string",
							enum: ["file", "dir"]
						},
						size: nullable("integer"),
						blob: nullable("string")
					},
					required: [
						"path",
						"type",
						"size",
						"blob"
					]
				}
			},
			lines: {
				type: "array",
				items: { type: "string" }
			}
		},
		required: [
			"version",
			"number",
			"truncated",
			"total",
			"nextOffset"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	check(params) {
		if (params.format !== "lines" && (params.limit ?? 0) > PAGE) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.ls: limit can be at most ${PAGE}, or ${LINES_PAGE} with format lines` });
	},
	command: (params) => ({ args: buildArgs("ls", {
		recursive: params.recursive === true,
		version: params.version
	}, params.path === void 0 ? [] : [params.path]) }),
	shape: (out, params) => {
		if (!Array.isArray(out.entries)) throw new SynsError("handler_error", { log: "exit=0 the result lacks what the specification requires at $.entries" });
		const all = out.entries.map(record$1);
		const offset = params.offset ?? 0;
		const common = {
			version: out.commitSha,
			number: out.version,
			truncated: out.truncated,
			total: all.length
		};
		if (params.format !== "lines") {
			const end = offset + (params.limit ?? PAGE);
			return {
				...common,
				nextOffset: end < all.length ? end : null,
				entries: all.slice(offset, end).map((entry) => ({
					path: entry.path,
					type: entry.type,
					size: entry.size ?? null,
					blob: entry.sha ?? null
				}))
			};
		}
		const end = Math.min(all.length, offset + (params.limit ?? LINES_PAGE));
		const room = 1047552 - bytes({
			...common,
			nextOffset: all.length,
			lines: []
		});
		const lines = [];
		let used = 0;
		for (let at = offset; at < end; at += 1) {
			const one = line(all[at]);
			const size = bytes(one) + 1;
			if (lines.length > 0 && used + size > room) break;
			lines.push(one);
			used += size;
		}
		const next = offset + lines.length;
		return {
			...common,
			nextOffset: next < all.length ? next : null,
			lines
		};
	}
};
//#endregion
//#region src/methods/read.ts
/**
* The lines of a window that fit one answer, from its first (D22). A text crosses as a JSON string, so a
* line is measured as it is escaped. At least one line, or response_too_large.
*/
function fit(result, room, trim) {
	if (bytes(result) <= room) return result;
	if (!trim) throw new SynsError("response_too_large");
	const lines = String(result.text).split("\n");
	let used = bytes({
		...result,
		text: ""
	});
	let kept = 0;
	for (const line of lines) {
		const cost = bytes(line) - 2 + (kept > 0 ? 2 : 0);
		if (used + cost > room) break;
		used += cost;
		kept += 1;
	}
	if (kept === 0) throw new SynsError("response_too_large", { log: "one line is larger than an answer" });
	return {
		...result,
		text: lines.slice(0, kept).join("\n"),
		limit: kept
	};
}
const read = {
	name: "syns.read",
	description: "One file, a window of lines: limit lines (default 2000) from offset (default 1), at version (default head). With fit: true a window too large for one answer is cut short, limit saying how many lines came. Line ends come as \\n.",
	effect: "read",
	params: object({
		path,
		version,
		offset: {
			type: "integer",
			minimum: 1
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 5e3
		},
		fit: { type: "boolean" }
	}, ["path"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			path: { type: "string" },
			text: { type: "string" },
			offset: { type: "integer" },
			limit: { type: "integer" },
			totalLines: { type: "integer" },
			size: { type: "integer" },
			blob: { type: "string" }
		},
		required: [
			"version",
			"number",
			"path",
			"text",
			"offset",
			"limit",
			"totalLines",
			"size",
			"blob"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	command: (params) => ({ args: buildArgs("read", {
		offset: params.offset ?? 1,
		limit: params.limit ?? 2e3,
		version: params.version
	}, [params.path]) }),
	shape: (out, params) => fit({
		version: out.commitSha,
		number: out.version,
		path: out.path,
		text: out.content,
		offset: out.offset,
		limit: out.limit,
		totalLines: out.totalLines,
		size: out.size,
		blob: out.sha
	}, 1047552, params.fit === true)
};
//#endregion
//#region src/methods/place.ts
/** OWNER/NAME of a template repository. */
const template = {
	type: "string",
	minLength: 3,
	maxLength: 201,
	pattern: "^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$"
};
/**
* `syns place TEMPLATE PATH [--version N] --json` (D43). It acts on the
* session's repository as a whole, so it runs at the session's folder even
* from a document scoped to a placed folder. It publishes one version and writes the
* files to the session's checkout. The CLI checks the head itself, so it takes
* no base. It has no provenance flags, so the page's provenance goes in
* SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER (D44).
*/
/** Working-copy states with no unpublished local edit, measured safe to place in (HOST_FACTS §16, D46): behind only, the place lands on the newer head and the next sync converges with no review. */
const CLEAN = /* @__PURE__ */ new Set(["converged", "remote_changes"]);
const place = {
	name: "syns.place",
	description: "Place a template (OWNER/NAME, at version or its head) as a new folder at path of this session's repository: one version, the files on disk too. Runs at the session's folder whatever the scope.",
	effect: "contributed-write",
	unguarded: true,
	atRoot: true,
	params: object({
		template,
		path,
		version: {
			type: "integer",
			minimum: 1
		}
	}, ["template", "path"]),
	result: {
		type: "object",
		properties: {
			path: { type: "string" },
			holder: { type: "string" },
			template: {
				type: "object",
				properties: {
					repo: { type: "string" },
					version: { type: "integer" },
					sha: { type: "string" }
				},
				required: [
					"repo",
					"version",
					"sha"
				]
			},
			version,
			number: { type: "integer" },
			checks: {
				type: "array",
				items: { type: "string" }
			},
			enableChecks: nullable("string")
		},
		required: [
			"path",
			"holder",
			"template",
			"version",
			"number",
			"checks",
			"enableChecks"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	reasons: [
		"occupied",
		"no_such_template",
		"stale_head",
		"checkout_dirty"
	],
	async procedure(params, context) {
		const status = await context.syns(["status", "--json"]);
		if (!CLEAN.has(String(status.workingCopyState))) throw fail("checkout_dirty");
		const out = await context.syns(buildArgs("place", { version: params.version }, [params.template, params.path]), void 0, { provenanceEnv: true });
		const placed = typeof out.template === "object" && out.template !== null ? out.template : {};
		return {
			path: out.path,
			holder: out.holder,
			template: {
				repo: placed.repo,
				version: placed.version,
				sha: placed.sha
			},
			version: out.commitSha,
			number: out.version,
			checks: Array.isArray(out.checks) ? out.checks : [],
			enableChecks: typeof out.enableChecks === "string" ? out.enableChecks : null
		};
	}
};
//#endregion
//#region src/methods/readMany.ts
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const readMany = {
	name: "syns.readMany",
	description: "Up to 64 whole files in one call, all at one version (default the head). Each entry is a text or an error: not_found, too_large, not_text. deferred lists paths that did not fit: ask again with them and the returned version.",
	effect: "read",
	params: object({
		paths: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			items: path
		},
		version
	}, ["paths"]),
	result: {
		type: "object",
		properties: {
			version,
			files: {
				type: "array",
				items: {
					type: "object",
					description: "Either path, text, size and blob, or path and error. not_text carries size and blob; too_large does when known.",
					properties: {
						path: { type: "string" },
						text: { type: "string" },
						size: { type: "integer" },
						blob: nullable("string"),
						error: {
							type: "string",
							enum: [
								"not_found",
								"too_large",
								"not_text"
							]
						}
					},
					required: ["path"]
				}
			},
			deferred: {
				type: "array",
				items: { type: "string" }
			}
		},
		required: [
			"version",
			"files",
			"deferred"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	check(params) {
		if (new Set(params.paths).size !== params.paths.length) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readMany: paths must be distinct" });
	},
	async procedure(params, context) {
		const room = readMany.maxResponseBytes - ENVELOPE - bytes({
			version: "0".repeat(40),
			files: [],
			deferred: params.paths
		});
		const out = record(await context.syns(buildArgs("cat", {
			version: params.version,
			"paths-from": "-",
			"max-bytes": room
		}), `${params.paths.join("\n")}\n`));
		const served = new Map(Array.isArray(out.files) ? out.files.map(record).map((entry) => [entry.path, entry]) : []);
		const later = new Set(Array.isArray(out.deferred) ? out.deferred : []);
		const entries = [];
		const deferredByCli = [];
		for (const filePath of params.paths) {
			const entry = served.get(filePath);
			if (entry === void 0) {
				if (!later.has(filePath)) throw new SynsError("handler_error", { log: "exit=0 the CLI's files answer leaves a path out" });
				deferredByCli.push(filePath);
				continue;
			}
			const error = record(entry.error);
			if (entry.error !== void 0) {
				if (error.code === "NOT_FOUND") {
					entries.push({
						path: filePath,
						error: "not_found"
					});
					continue;
				}
				const words = context.redact(String(error.message ?? "").trim());
				throw new SynsError("handler_error", {
					...words ? { message: words.slice(0, 300) } : {},
					log: `readMany per-file ${String(error.code).slice(0, 64)}`
				});
			}
			if (typeof entry.content !== "string") entries.push({
				path: filePath,
				error: "not_text",
				size: entry.size,
				blob: entry.sha ?? null
			});
			else entries.push({
				path: filePath,
				text: entry.content,
				size: entry.size,
				blob: entry.sha ?? null
			});
		}
		if (entries.length === 0 && deferredByCli.length > 0) return {
			version: out.commitSha,
			files: [{
				path: deferredByCli[0],
				error: "too_large"
			}],
			deferred: deferredByCli.slice(1)
		};
		const files = [];
		const deferred = [];
		let used = 0;
		for (const entry of entries) {
			const kept = bytes(entry) + 1 > room && "text" in entry ? {
				path: entry.path,
				error: "too_large",
				size: entry.size,
				blob: entry.blob
			} : entry;
			const size = bytes(kept) + 1;
			if (deferred.length > 0 || used + size > room) {
				deferred.push(entry.path);
				continue;
			}
			files.push(kept);
			used += size;
		}
		return {
			version: out.commitSha,
			files,
			deferred: [...deferred, ...deferredByCli]
		};
	}
};
//#endregion
//#region src/methods/repo.ts
/** What the CLI reports in a placed folder, and may report at a root later: passed on only when present, and of its type (D34). */
const passed = (out) => ({
	...Number.isInteger(out.version) || out.version === null ? { number: out.version } : {},
	...typeof out.holder === "string" ? { holder: out.holder } : {},
	...typeof out.path === "string" ? { path: out.path } : {},
	...typeof out.sharedFolder === "boolean" ? { sharedFolder: out.sharedFolder } : {}
});
const repo = {
	name: "syns.repo",
	description: "The Syns repository of this session's folder, or the placed folder it is, and its head version. The method a page polls with watch: one cheap call.",
	effect: "read",
	params: object({}),
	result: {
		type: "object",
		properties: {
			owner: { type: "string" },
			name: { type: "string" },
			version: {
				...version,
				type: ["string", "null"],
				description: "The head. null for a repository with no commit yet."
			},
			number: {
				...nullable("integer"),
				description: "The head as a number, for display."
			},
			role: nullable("string"),
			visibility: { type: "string" },
			fileCount: { type: "integer" },
			holder: {
				type: "string",
				description: "In a placed folder: OWNER/NAME of the repository holding it. owner, name, role, visibility and fileCount are then the holder's."
			},
			path: {
				type: "string",
				description: "In a placed folder: its path in the holder. Every path a page uses is counted from it."
			},
			sharedFolder: {
				type: "boolean",
				description: "true in a folder-only collaborator's checkout of a shared folder: the record is the folder's identity, and fileCount is 0."
			}
		},
		required: [
			"owner",
			"name",
			"version",
			"role",
			"visibility",
			"fileCount"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: () => ({ args: buildArgs("repo") }),
	shape: (out) => ({
		owner: out.owner,
		name: out.name,
		version: out.commitSha ?? null,
		role: out.role ?? null,
		visibility: out.visibility,
		fileCount: out.fileCount,
		...passed(out)
	})
};
//#endregion
//#region src/methods/revert.ts
const revert = {
	name: "syns.revert",
	description: "Put one file back to its text at the earlier version to, as a new version. Today the CLI checks no base, so the head is not checked, and records no provenance: syns.history shows this commit with by all null.",
	effect: "contributed-write",
	unguarded: true,
	params: object({
		path,
		to: version,
		message
	}, ["path", "to"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" }
		},
		required: ["version", "number"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: (params) => ({ args: buildArgs("revert", {
		to: params.to,
		message: params.message || void 0
	}, [params.path]) }),
	shape: (out) => ({
		version: out.commitSha,
		number: out.version
	})
};
//#endregion
//#region src/methods/rm.ts
const rm = {
	name: "syns.rm",
	description: "Remove one path as a new version, made against base. A path that is not there is success with the unchanged version and changed: 0, as the CLI answers it. Published at once, with no confirmation.",
	effect: "contributed-write",
	params: object({
		path,
		base,
		message
	}, ["path", "base"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: the path was not there, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: (params, sessionId) => ({ args: buildArgs("rm", {
		parent: params.base,
		message: params.message || `Remove ${params.path} from a page`.slice(0, 500),
		...provenance(sessionId)
	}, [params.path]) }),
	shape: (out) => ({
		version: out.commitSha,
		number: out.version,
		changed: out.filesChanged
	})
};
//#endregion
//#region src/methods/enableChecks.ts
/**
* `syns enable-checks --json` in the page's placed folder (D49, D59): one
* version of the holder turning on the checks the folder recorded from its
* template. The CLI guards it against an unpublished edit itself, and reads
* the page's provenance from SYNS_* (HOST_FACTS §17), as syns.place does
* (D44). It takes no base: the CLI writes against the folder's own.
*/
const enableChecks = {
	name: "syns.enableChecks",
	description: "Turn on, for everyone working in the holder, the checks this placed folder recorded from its template; they run on every push. enabled: [] makes no version. Only from the reader's own press, naming the commands.",
	effect: "contributed-write",
	unguarded: true,
	params: object({}),
	result: {
		type: "object",
		properties: {
			holder: { type: "string" },
			path: { type: "string" },
			enabled: {
				type: "array",
				items: { type: "string" }
			},
			version,
			number: { type: "integer" }
		},
		required: [
			"holder",
			"path",
			"enabled"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["stale_head", "checkout_dirty"],
	command: () => ({
		args: buildArgs("enable-checks"),
		provenanceEnv: true
	}),
	shape: (out) => ({
		holder: out.holder,
		path: out.path,
		enabled: Array.isArray(out.enabled) ? out.enabled.filter((one) => typeof one === "string") : out.enabled,
		...typeof out.commitSha === "string" ? { version: out.commitSha } : {},
		...Number.isInteger(out.version) ? { number: out.version } : {}
	})
};
//#endregion
//#region src/methods/explore.ts
const exploreResult = {
	type: "object",
	properties: {
		total: { type: "integer" },
		limit: { type: "integer" },
		offset: { type: "integer" },
		data: {
			type: "array",
			items: {
				type: "object",
				properties: {
					owner: { type: "string" },
					name: { type: "string" },
					description: nullable("string"),
					tags: {
						type: "array",
						items: { type: "string" }
					},
					status: nullable("string"),
					visibility: { type: "string" },
					fileCount: { type: "integer" },
					forkCount: { type: "integer" },
					updatedAt: nullable("string")
				},
				required: ["owner", "name"]
			}
		}
	},
	required: ["total", "data"]
};
const explore = {
	name: "syns.explore",
	description: "Public Syns repositories matching query, every tag in tags (syns-app for app templates) and status, limit at a time from offset; total says how many.",
	effect: "read",
	params: object({
		query: {
			type: "string",
			maxLength: 200
		},
		tags: {
			type: "array",
			items: {
				type: "string",
				maxLength: 100
			},
			maxItems: 8
		},
		status: {
			type: "string",
			enum: [
				"active",
				"draft",
				"completed",
				"abandoned"
			],
			maxLength: 9
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100
		},
		offset: {
			type: "integer",
			minimum: 0
		}
	}),
	result: exploreResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	command: (params) => ({ args: buildArgs("explore", {
		query: params.query,
		tag: params.tags,
		status: params.status,
		limit: params.limit,
		offset: params.offset
	}) })
};
//#endregion
//#region src/methods/people.ts
/**
* The scope's people (D49, D59): `syns collaborators` and its verbs, one
* command each, in the page's scope folder. The CLI decides whose
* collaborators they are and which roles it takes; inside a placed folder it
* answers holder root required, which comes back as bad_scope (HOST_FACTS §17).
* And `syns users`, to find someone.
*/
const ROLE = {
	type: "string",
	enum: [
		"admin",
		"write",
		"read"
	],
	maxLength: 5
};
/**
* A user id, as the CLI's role and remove take it. A security guard, the one
* restriction beyond the CLI's own (D60): the CLI puts the id in a URL path
* and its HTTP client collapses `.` and `..` there, so `..` would address the
* repository's own route. No `/` or `\` either.
*/
const id = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^(?!\\.{1,2}$)[^/\\\\]+$"
};
/** Paging inside the host's 10,000 nodes. */
const limit = {
	type: "integer",
	minimum: 1,
	maximum: 100
};
const offset = {
	type: "integer",
	minimum: 0
};
const COLLABORATOR = {
	type: "object",
	properties: group("collaborator", {
		user: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: nullable("string"),
				name: nullable("string"),
				email: nullable("string"),
				image: nullable("string")
			},
			required: ["id"]
		},
		role: { type: "string" },
		createdAt: nullable("string")
	}),
	required: ["user", "role"]
};
const collaboratorsResult = {
	type: "object",
	properties: {
		total: { type: "integer" },
		limit: { type: "integer" },
		offset: { type: "integer" },
		data: {
			type: "array",
			items: COLLABORATOR
		}
	},
	required: ["total", "data"]
};
const collaborators = {
	name: "syns.collaborators",
	description: "Who has access to this scope, and each one's role: a shared placed folder's own people, or at a root the whole repository's. limit at a time from offset; total says how many.",
	effect: "read",
	params: object({
		limit,
		offset
	}),
	result: collaboratorsResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs("collaborators", {
		limit: params.limit,
		offset: params.offset
	}) })
};
const collaboratorAdd = {
	name: "syns.collaboratorAdd",
	description: "Give a person, by Syns username or e-mail, a role on this scope: a shared placed folder, or at a root the whole repository. Only from the reader's own press on a control naming the person, role and scope.",
	effect: "contributed-write",
	sharing: true,
	params: object({
		user: {
			type: "string",
			maxLength: 320
		},
		role: ROLE
	}, ["user", "role"]),
	result: {
		type: "object",
		properties: {
			added: { type: "boolean" },
			target: { type: "string" },
			role: { type: "string" }
		},
		required: [
			"added",
			"target",
			"role"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: [
		"not_permitted",
		"no_such_user",
		"already_collaborator"
	],
	command: (params) => ({ args: buildArgs(["collaborators", "add"], { role: params.role }, [params.user]) })
};
const collaboratorRole = {
	name: "syns.collaboratorRole",
	description: "Change a collaborator's role on this scope, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person and the new role.",
	effect: "contributed-write",
	sharing: true,
	params: object({
		id,
		role: ROLE
	}, ["id", "role"]),
	result: COLLABORATOR,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs(["collaborators", "role"], { role: params.role }, [params.id]) })
};
const collaboratorRemove = {
	name: "syns.collaboratorRemove",
	description: "Take a collaborator off this scope, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person.",
	effect: "contributed-write",
	sharing: true,
	params: object({ id }, ["id"]),
	result: {
		type: "object",
		properties: {
			removed: { type: "boolean" },
			userId: { type: "string" }
		},
		required: ["removed", "userId"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs(["collaborators", "remove"], { yes: true }, [params.id]) })
};
const usersResult = {
	type: "object",
	properties: { data: {
		type: "array",
		items: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: { type: "string" },
				name: nullable("string"),
				image: nullable("string")
			},
			required: ["id", "username"]
		}
	} },
	required: ["data"]
};
const users = {
	name: "syns.users",
	description: "Syns people whose handle or display name matches query, at most limit: id, username, name, image. For finding someone to share with.",
	effect: "read",
	params: object({
		query: {
			type: "string",
			maxLength: 100
		},
		limit
	}, ["query"]),
	result: usersResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	command: (params) => ({ args: buildArgs("users", { limit: params.limit }, [params.query]) })
};
//#endregion
//#region src/methods/share.ts
/**
* Sharing, and a scope's visibility (D49, D59): each method is one CLI command,
* run in the page's scope folder, its JSON passed on. The folder commands name
* `.`, the folder the run stands in; at a repository's root the CLI refuses
* that, and `repo --visibility` is refused inside a placed folder: both come
* back as bad_scope (HOST_FACTS §17).
*/
/** The repository record the CLI prints for a repository or a folder's identity, as far as a page needs it. */
const RECORD = group("record", {
	owner: { type: "string" },
	name: { type: "string" },
	visibility: { type: "string" },
	role: nullable("string"),
	sharedFolder: { type: "boolean" },
	status: { type: "string" },
	description: nullable("string"),
	heldIn: {
		type: ["object", "null"],
		properties: {
			owner: { type: "string" },
			name: { type: "string" },
			path: { type: "string" }
		}
	}
});
const FOLDER = {
	holder: { type: "string" },
	path: { type: "string" }
};
const result = (properties, required) => ({
	type: "object",
	properties,
	required
});
/** The CLI checks a name itself (bad_name); the bound only keeps it an argument. */
const name = {
	type: "string",
	maxLength: 100
};
const visibility = {
	type: "string",
	enum: ["public", "private"],
	maxLength: 7
};
const FOLDER_ARG = ["."];
const shareInfoResult = result({
	...FOLDER,
	holderRole: nullable("string"),
	shared: { type: "boolean" },
	offeredName: { type: "string" },
	...RECORD
}, [
	"holder",
	"path",
	"shared"
]);
const shareInfo = {
	name: "syns.shareInfo",
	description: "Whether this placed folder is shared: its identity's record when it is, the name a share would offer when not, and the reader's holderRole. share . --show. At a repository's root: bad_scope.",
	effect: "read",
	params: object({}),
	result: shareInfoResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: () => ({ args: buildArgs("share", { show: true }, FOLDER_ARG) })
};
const shareResult = result({
	...RECORD,
	...FOLDER,
	created: { type: "boolean" }
}, [
	"owner",
	"name",
	"holder",
	"path",
	"created"
]);
const share = {
	name: "syns.share",
	description: "Share this placed folder under an identity of its own, named name or the CLI's offer. Already shared: created false. Reaches people at once: only from the reader's own press on a control saying so.",
	effect: "contributed-write",
	sharing: true,
	params: object({ name }),
	result: shareResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: [
		"bad_name",
		"name_taken",
		"not_permitted"
	],
	command: (params) => ({ args: buildArgs("share", { name: params.name }, FOLDER_ARG) })
};
const unshareResult = result({
	owner: { type: "string" },
	name: { type: "string" },
	...FOLDER,
	unshared: { type: "boolean" },
	retired: nullable("boolean")
}, [
	"owner",
	"name",
	"holder",
	"path",
	"unshared"
]);
const unshare = {
	name: "syns.unshare",
	description: "Stop sharing this placed folder: all who reached it through the folder lose access; its identity retires unless the folder has a visibility of its own. Only from the reader's own press on a control saying so.",
	effect: "contributed-write",
	sharing: true,
	params: object({}),
	result: unshareResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: () => ({ args: buildArgs("unshare", { yes: true }, FOLDER_ARG) })
};
const folderVisibilityResult = result({
	...RECORD,
	...FOLDER,
	created: { type: "boolean" }
}, [
	"owner",
	"name",
	"visibility",
	"holder",
	"path"
]);
const folderVisibility = {
	name: "syns.folderVisibility",
	description: "Give this placed folder a visibility of its own. public: anyone, signed in or not, can find and read it. There is no way back to inheriting. Only from the reader's own press on a control saying exactly that.",
	effect: "contributed-write",
	sharing: true,
	params: object({
		visibility,
		name
	}, ["visibility"]),
	result: folderVisibilityResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: [
		"bad_name",
		"name_taken",
		"not_permitted"
	],
	command: (params) => ({ args: buildArgs("share", {
		visibility: params.visibility,
		name: params.name
	}, FOLDER_ARG) })
};
const repoVisibilityResult = result(RECORD, [
	"owner",
	"name",
	"visibility"
]);
const repoVisibility = {
	name: "syns.repoVisibility",
	description: "Set this repository's visibility, from its root. public: anyone, signed in or not, can find and read every file. In a placed folder: bad_scope. Only from the reader's own press on a control saying exactly that.",
	effect: "contributed-write",
	sharing: true,
	params: object({ visibility }, ["visibility"]),
	result: repoVisibilityResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs("repo", { visibility: params.visibility }) })
};
//#endregion
//#region src/methods/whoami.ts
/** Every field the CLI's whoami reports, the e-mail address included (D14). */
const OPTIONAL = [
	"name",
	"email",
	"image",
	"bio",
	"company",
	"location",
	"pronouns",
	"timeZone",
	"createdAt",
	"updatedAt"
];
//#endregion
//#region src/methods/index.ts
/**
* THE TABLE (D17, S2.21). The declaration sent to Thread Pages, the guide's
* method section and the dispatch are all derived from it. A new method is a
* new file exporting one entry, and one line here.
*/
const METHODS = [
	repo,
	{
		name: "syns.whoami",
		description: "The Syns account logged in on this session's machine, every field the CLI reports. Any but id and username may be null.",
		effect: "read",
		params: object({}),
		result: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: { type: "string" },
				emailVerified: nullable("boolean"),
				...Object.fromEntries(OPTIONAL.map((key) => [key, nullable("string")]))
			},
			required: [
				"id",
				"username",
				"emailVerified",
				...OPTIONAL
			]
		},
		maxRequestBytes: K64,
		maxResponseBytes: K64,
		command: () => ({ args: buildArgs("whoami") }),
		shape: (out) => ({
			id: out.id,
			username: out.username,
			emailVerified: out.emailVerified ?? null,
			...Object.fromEntries(OPTIONAL.map((key) => [key, out[key] ?? null]))
		})
	},
	ls,
	readMany,
	history,
	commit,
	read,
	glob,
	grep,
	diff,
	{
		name: "syns.write",
		description: "One file's whole text as a new version, made against base. create: true refuses with exists when the path is already there at base. Published at once, with no confirmation.",
		effect: "contributed-write",
		params: object({
			path,
			text: {
				type: "string",
				maxLength: M1
			},
			base,
			message,
			create: { type: "boolean" }
		}, [
			"path",
			"text",
			"base"
		]),
		result: {
			type: "object",
			properties: {
				version,
				number: { type: "integer" }
			},
			required: ["version", "number"]
		},
		maxRequestBytes: M1,
		maxResponseBytes: K64,
		reasons: ["exists"],
		async procedure(params, context) {
			if (params.create === true) {
				let there = true;
				try {
					await context.syns(buildArgs("cat", { version: params.base }, [params.path]));
				} catch (error) {
					if (!(error instanceof SynsError && error.code === "not_found" && error.subject !== "version")) throw error;
					there = false;
				}
				if (there) throw fail("exists");
			}
			const fallback = `${params.create === true ? "Create" : "Write"} ${params.path} from a page`.slice(0, 500);
			const args = buildArgs("write", {
				parent: params.base,
				message: params.message || fallback,
				...provenance(context.sessionId)
			}, [params.path]);
			const out = await context.syns(args, params.text);
			return {
				version: out?.commitSha,
				number: out?.version
			};
		}
	},
	edit,
	rm,
	revert,
	readBinary,
	writeBinary,
	place,
	shareInfo,
	share,
	unshare,
	folderVisibility,
	repoVisibility,
	collaborators,
	collaboratorAdd,
	collaboratorRole,
	collaboratorRemove,
	enableChecks,
	explore,
	users
];
/** An absolute path on the session's machine, POSIX or Windows (a drive letter, or a UNC path). */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
/** Where the CLI runs for the session: the folder the host passed, on its machine. Null when there is none; a malformed one throws. */
function sessionWhere(workspace) {
	if (workspace === null || workspace === void 0) return null;
	const w = workspace;
	if (typeof w.path !== "string" || !ABSOLUTE.test(w.path) || w.machine !== null && typeof w.machine !== "string") throw new SynsError("handler_error", { log: "the host passed a workspace without an absolute path" });
	return {
		hostId: w.machine ?? "local",
		cwd: w.path
	};
}
/**
* threadPagesInvoke: look the method up in the table, check its parameters,
* take the session's folder from the host, run the CLI, map the outcome. It knows no method by name.
* spec S2.1, S2.2, S2.14, S2.18–S2.22
*/
function createDispatch({ table = METHODS, cli, log, held = createHeld(), now = Date.now }) {
	const byName = new Map(table.map((method) => [method.name, method]));
	/** Scopes found to belong to their session's repository, each held a minute (D46): the answer is about the folder, not its contents. */
	const confirmed = /* @__PURE__ */ new Map();
	/**
	* D46 rule 2, as amended (D83): one run at the scope, `syns repo --within=<session folder> --json`. The CLI
	* answers `within` from the identity files on disk (roadmap 277). Its run, when one was made, is returned: a
	* scoped `syns.repo` answers from it (S1.10, S1.14).
	*/
	async function sameRepository(session, scoped, scope, deadline, signal) {
		const key = `${session.hostId}\u0000${session.cwd}\u0000${scope}`;
		const at = confirmed.get(key);
		if (at !== void 0 && now() - at < 6e4) return void 0;
		const ran = await cli.run(scoped, buildArgs("repo", { within: session.cwd }), void 0, deadline, void 0, signal);
		let out;
		try {
			out = await interpret(ran, [], async () => ran, { folder: session.cwd }, () => cli.run(session, ["whoami", "--json"], void 0, deadline, void 0, signal));
		} catch (error) {
			if (error instanceof SynsError && (error.reason === "no_repo" || error.reason === "no_access")) throw fail("bad_scope");
			throw error;
		}
		if (out?.within !== true) throw fail("bad_scope");
		confirmed.set(key, now());
		return ran;
	}
	async function run(method, params, sessionId, scope, workspace, deadline, signal) {
		const problem = validate(method.params, params);
		if (problem) throw new SynsError("invalid_params", { message: `Invalid parameters for ${method.name} at ${problem}` });
		method.check?.(params);
		if (sessionId === null) throw fail("no_repo");
		const session = sessionWhere(workspace);
		if (!session) throw fail("no_repo");
		const where = scope === null || method.atRoot ? session : {
			hostId: session.hostId,
			cwd: `${session.cwd.replace(/\/+$/, "")}/${scope}`,
			within: session.cwd
		};
		const checked = where !== session ? await sameRepository(session, where, scope, deadline, signal) : void 0;
		const declared = method.reasons ?? [];
		let repoCheck = checked && Promise.resolve(checked);
		let whoamiCheck;
		const context = {
			sessionId,
			limits: cli.limits,
			held,
			redact: (text) => redact(text, { folder: session.cwd }),
			async syns(args, stdin, options) {
				const mark = provenance(sessionId);
				const env = options?.provenanceEnv ? {
					SYNS_INTEGRATION: mark.integration,
					SYNS_RUN: mark.run,
					SYNS_TRIGGER: mark.trigger
				} : void 0;
				const isRepo = args.join(" ") === "repo --json" && stdin === void 0 && env === void 0;
				const ran = isRepo && checked ? checked : await cli.run(where, args, stdin, deadline, env, signal);
				const repoCheckOf = () => repoCheck ??= isRepo ? Promise.resolve(ran) : cli.run(where, ["repo", "--json"], void 0, deadline, void 0, signal);
				const whoamiCheckOf = () => whoamiCheck ??= cli.run(where, ["whoami", "--json"], void 0, deadline, void 0, signal);
				return interpret(ran, declared, repoCheckOf, {
					folder: session.cwd,
					...method.notFound ? { notFound: method.notFound } : {}
				}, whoamiCheckOf);
			}
		};
		let result;
		if ("procedure" in method) result = await method.procedure(params, context);
		else {
			const command = method.command(params, sessionId);
			const output = await context.syns(command.args, command.stdin, command.provenanceEnv ? { provenanceEnv: true } : void 0);
			if (typeof output !== "object" || output === null || Array.isArray(output)) throw new SynsError("handler_error", { log: "exit=0 output is not a JSON object" });
			if (method.shape) result = method.shape(output, params);
			else {
				const dropped = [];
				result = pick(method.result, output, "$", dropped);
				if (dropped.length > 0) log.warn(`${method.name} session=${sessionId} dropped from the CLI's output: ${dropped.join(", ").slice(0, 500)}`);
			}
		}
		const hole = validate(method.result, result);
		if (hole) throw new SynsError("handler_error", { log: `exit=0 the result lacks what the specification requires at ${hole}` });
		return result;
	}
	return async (call) => {
		const method = byName.get(call.method);
		if (!method) return toAnswer(new SynsError("unknown_method"));
		const sessionId = call.caller?.sessionId ?? null;
		const rawScope = call.caller?.scope;
		if (rawScope !== void 0 && rawScope !== null && typeof rawScope !== "string") return toAnswer(fail("bad_scope"));
		const scope = typeof rawScope === "string" && rawScope !== "" ? rawScope.startsWith("/") ? rawScope : rawScope.replace(/\/+$/, "") : null;
		if (scope !== null && validate(path, scope)) return toAnswer(fail("bad_scope"));
		const params = call.params ?? {};
		const controller = new AbortController();
		let timer;
		const limit = new Promise((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(fail("timeout"));
			}, cli.limits.callMs);
		});
		let outcome = "ok";
		try {
			const work = run(method, params, sessionId, scope, call.caller?.workspace, Date.now() + cli.limits.callMs, controller.signal);
			work.catch(() => void 0);
			return {
				ok: true,
				result: await Promise.race([work, limit])
			};
		} catch (caught) {
			const error = caught instanceof SynsError ? caught : new SynsError("handler_error", { log: `threw ${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 500) });
			outcome = error.reason ?? error.code;
			if (error.code === "handler_error") log.warn(`${method.name} session=${sessionId ?? "none"} handler_error ${error.log ?? ""}`.trim());
			return toAnswer(error);
		} finally {
			clearTimeout(timer);
			controller.abort();
			if (method.effect === "contributed-write") log.info(`${method.name} session=${sessionId ?? "none"} paths=${pathCount(method, params)} outcome=${outcome}`);
		}
	};
}
/** Of parameters that may not have passed their schema. */
function pathCount(method, params) {
	try {
		return method.pathCount ? method.pathCount(params) : typeof params.path === "string" ? 1 : 0;
	} catch {
		return 0;
	}
}
//#endregion
//#region src/pagehost.ts
/**
* The page script (spec 02 §The page script, S2.27–S2.29): the Syns page host and its bootstrap, which Thread Pages puts first in
* every page of a session whose folder is a Syns repository. Kept as text, since it runs in the reader's browser and
* not here; its tests check it parses and holds nothing the host refuses (unife-pages 07 R5.90).
*/
const PAGEHOST = String.raw`/*
 * The Syns page host: pages in frames, for any app on a Thread Page of a Syns repository. Nothing in it is one
 * app's: an app (the workspace, a template's, anyone's) gives it a container and gets a page running in it.
 * The Syns plugin's page script: Thread Pages puts it first in every page of a session whose folder is a Syns
 * repository, right after its kernel. It holds neither a closing script tag nor a comment opener, which would end
 * the inline script it is carried in (unife-pages 07 R5.90).
 *
 *   const f = SynsPages.frame(container, src, options)
 *     src      { kind: "repo", folder, doc? }   a folder's index.html, else a placed template's .page/index.html,
 *                                              with syns.* answered for that folder alone (threadPage.scope)
 *              { kind: "page", path, html? }   a document of the session's own page (html: the one this
 *                                              document is, as SynsPages.page has it; else read with pages.read)
 *     options  call(method, params)    the app's own invoke (default threadPage.invoke)
 *              sessionId               default: context.get
 *              onLink(target)          { kind: "external" | "repo" | "page", path | url, newTab }; default: external only
 *              onState(state)          { status: "loading" | "shown" | "failed", message, failures: [text] }
 *     f.reload()   f.changed(paths)   f.destroy()   f.frame (the iframe)   f.title()
 *
 *   SynsPages.page            the Thread Page this document is, taken before the app loaded (the bootstrap, at the end of this file)
 *   SynsPages.tools(paths)    the folders among the repository's paths that open as pages
 *   SynsPages.pageUrl(sessionId, path, fragment)   the host's address of a document of the page
 *   SynsPages.goTo(fromPath, path)                  this document goes to another document of the page
 *
 * In the frame: a window.threadPage of its own (invoke, watch, scope); storage.* per page; drafts and the
 * scroll position kept and restored; forms answering the session; links handed to onLink; hash-only
 * history calls as fragment navigations. Calls the frame may make: syns.*, storage.*, context, session,
 * navigation and confirmed session calls; anything else is refused.
 */
(function () {
  "use strict";
  if (window.SynsPages && window.SynsPages.frame) return;
  const P = (window.SynsPages = window.SynsPages || {});
  const dirOf = function (p) { const i = String(p).lastIndexOf("/"); return i < 0 ? "" : String(p).slice(0, i + 1); };
  const baseOf = function (p) { return String(p).replace(/\/+$/, "").replace(/^.*\//, ""); };

  const SYNS = ["syns.repo", "syns.whoami", "syns.ls", "syns.glob", "syns.grep", "syns.read", "syns.readMany", "syns.readBinary",
    "syns.history", "syns.diff", "syns.write", "syns.writeBinary", "syns.edit", "syns.rm", "syns.move", "syns.commit", "syns.revert"];
  const PASS = ["context.get", "session.reply", "session.activity", "session.messages", "sessions.snapshot", "sessions.start",
    "sessions.openHost", "pages.open", "pages.read", "navigation.openExternal", "providers.list", "workspaces.list"];
  const CACHED = { "syns.repo": 4000, "syns.whoami": 60000, "context.get": 10000 };
  const cache = {};

  // Storage keys are [A-Za-z0-9._:-], 128 at most: a source is named by a short hash.
  const hash = function (s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };
  const nsKey = function (id, key) { return ("f." + hash(id) + ":" + String(key)).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128); };

  // ------------------------------------------------------------------ inside the frame
  const SHIM = function (cfg) {
    var n = 0, wait = {}, post = function (m) { parent.postMessage(m, "*"); };
    addEventListener("message", function (e) {
      var d = e.data; if (e.source !== parent || !d) return;
      if (d.__tool === "formdone") return formDone(d);
      if (d.__tool !== "answer" || !wait[d.id]) return;
      var w = wait[d.id]; delete wait[d.id];
      if (d.ok) w[0](d.result); else { var x = new Error(d.error.message || d.error.code); x.code = d.error.code; x.reason = d.error.reason; x.detail = d.error.detail; w[1](x); }
    });
    function invoke(method, params) { return new Promise(function (ok, no) { var id = ++n; wait[id] = [ok, no]; post({ __tool: "invoke", id: id, method: method, params: params || {} }); }); }
    function watch(method, params, cb, o) {
      var ms = Math.min(300000, Math.max(2000, (o && o.intervalMs) || 8000)), live = true, t;
      (function tick() { invoke(method, params).then(function (v) { if (live) cb(v, null); }, function (e) { if (live) cb(null, e); }).then(function () { if (live) t = setTimeout(tick, ms); }); })();
      return function () { live = false; clearTimeout(t); };
    }
    // A srcdoc document can't push or replace a URL of its own: a hash-only one becomes a fragment navigation.
    ["pushState", "replaceState"].forEach(function (k) {
      var o = history[k].bind(history);
      history[k] = function (st, t, u) {
        try { return o(st, t, u); } catch (e) {
          if (typeof u === "string" && u.charAt(0) === "#") { location.hash = u; return; } // location.replace would leave about:srcdoc
          throw e;
        }
      };
    });
    window.threadPage = Object.freeze({ version: 1, scope: cfg.scope, invoke: invoke, watch: watch,
      setDirty: function (on) { post({ __tool: "dirty", on: !!on }); }, setScope: function () {}, embed: function () { return function () {}; } });
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a[href]"); if (!a || e.defaultPrevented || a.hasAttribute("download") || /^(#|blob:|data:|javascript:)/i.test(a.getAttribute("href"))) return;
      e.preventDefault(); post({ __tool: "link", href: a.getAttribute("href"), newTab: e.metaKey || e.ctrlKey || a.target === "_blank" });
    });

    // ---- drafts, as Thread Pages keeps them: fields by id, else name; never passwords, files or autocomplete="off"
    var drafted = function (el) {
      if (!el.matches || !el.matches("input, textarea, select") || el.disabled) return false;
      var t = (el.type || "").toLowerCase(), ac = (el.getAttribute("autocomplete") || "").toLowerCase(), f = el.form;
      if (/^(password|file|hidden|submit|button|reset|image)$/.test(t)) return false;
      if (/^(off|current-password|new-password|one-time-code)$/.test(ac) || (f && (f.getAttribute("autocomplete") || "") === "off")) return false;
      return !!(el.id || el.name);
    };
    var keyOf = function (el) { var t = (el.type || "").toLowerCase(); var k = el.id || el.name; return (t === "radio" || t === "checkbox") && !el.id ? k + "=" + el.value : k; };
    var collect = function () {
      var out = {};
      document.querySelectorAll("input, textarea, select").forEach(function (el) {
        if (!drafted(el)) return; var t = (el.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") { if (el.checked !== el.defaultChecked) out[keyOf(el)] = el.checked; }
        else if (el.tagName === "SELECT" && el.multiple) { out[keyOf(el)] = Array.from(el.selectedOptions).map(function (o) { return o.value; }); }
        else if (el.value !== el.defaultValue) out[keyOf(el)] = el.value;
      });
      return out;
    };
    var draftTimer = null;
    var saveDraft = function () { clearTimeout(draftTimer); draftTimer = setTimeout(function () { post({ __tool: "draft", values: collect() }); }, 400); };
    document.addEventListener("input", saveDraft, true);
    document.addEventListener("change", saveDraft, true);
    var restore = function () {
      var d = cfg.draft || {};
      document.querySelectorAll("input, textarea, select").forEach(function (el) {
        if (!drafted(el) || !(keyOf(el) in d)) return;
        var v = d[keyOf(el)], t = (el.type || "").toLowerCase();
        if (t === "radio" || t === "checkbox") { if (el.checked !== el.defaultChecked) return; el.checked = !!v; }
        else if (el.tagName === "SELECT" && el.multiple) { Array.from(el.options).forEach(function (o) { o.selected = v.indexOf(o.value) >= 0; }); }
        else { if (el.value !== el.defaultValue) return; el.value = v; } // a field the page's script already filled is kept
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (cfg.scrollY) scrollTo(0, cfg.scrollY);
    };
    addEventListener("load", function () { restore(); setTimeout(restore, 300); });
    var scrollTimer = null;
    addEventListener("scroll", function () { clearTimeout(scrollTimer); scrollTimer = setTimeout(function () { post({ __tool: "scroll", y: Math.round(scrollY) }); }, 300); }, { passive: true });

    // ---- forms: every form answers the session, as on a Thread Page, unless its own script owns it
    var labelOf = function (el) {
      var fs = el.closest("fieldset"), lg = fs && fs.querySelector("legend"), t = (el.type || "").toLowerCase();
      var wrap = el.closest("label"), forL = el.id && document.querySelector('label[for="' + el.id + '"]');
      var text = function (x) { return x ? x.textContent.replace(/\s+/g, " ").trim() : ""; };
      if (el.getAttribute("data-label")) return el.getAttribute("data-label");
      if ((t === "radio" || t === "checkbox") && lg) return text(lg);
      return text(lg) || el.getAttribute("aria-label") || text(wrap) || text(forL) || el.name || "Answer";
    };
    var sending = null;
    document.addEventListener("submit", function (e) {
      var f = e.target; if (e.defaultPrevented || f.hasAttribute("data-thread-page-manual") || f.method === "dialog") return;
      e.preventDefault(); if (sending) return;
      var groups = {}, order = [];
      Array.from(f.elements).forEach(function (el) {
        var t = (el.type || "").toLowerCase();
        if (!el.name && !el.id || /^(submit|button|reset|image|file|hidden)$/.test(t) || el.tagName === "FIELDSET" || el.tagName === "BUTTON") return;
        var k = t === "radio" || t === "checkbox" ? "g:" + el.name : "f:" + (el.id || el.name);
        if (!groups[k]) { groups[k] = { label: labelOf(el), kind: t, items: [] }; order.push(k); }
        groups[k].items.push(el);
      });
      var answers = order.map(function (k) {
        var g = groups[k], v;
        if (g.kind === "checkbox") v = g.items.length === 1 ? (g.items[0].checked ? "Yes" : "No") : g.items.filter(function (x) { return x.checked; }).map(function (x) { return x.value; }).join(", ");
        else if (g.kind === "radio") { var c = g.items.filter(function (x) { return x.checked; })[0]; v = c ? c.value : ""; }
        else if (g.items[0].tagName === "SELECT" && g.items[0].multiple) v = Array.from(g.items[0].selectedOptions).map(function (o) { return o.value; }).join(", ");
        else v = g.items[0].value;
        return { label: g.label, value: String(v).trim() ? String(v) : "(left blank)" };
      });
      sending = f; Array.from(f.elements).forEach(function (el) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; });
      post({ __tool: "form", title: f.getAttribute("aria-label") || (f.querySelector("h1,h2,legend") || {}).textContent || document.title, action: e.submitter && e.submitter.value || null, answers: answers });
    });
    function formDone(d) {
      var f = sending; sending = null; if (!f) return;
      Array.from(f.elements).forEach(function (el) { el.disabled = el.dataset.wasDisabled === "1"; });
      var line = f.querySelector(".tp-status") || f.appendChild(Object.assign(document.createElement("p"), { className: "tp-status" }));
      line.style.cssText = "font-size:13px;opacity:.75;margin:8px 0 0";
      line.textContent = d.ok ? "Sent" : "Not sent: " + (d.message || "");
      if (d.ok) post({ __tool: "draft", values: collect(), sent: true });
    }
  };

  const safeScript = function (t) { return String(t).replace(/<\/(script)/gi, "<\\/$1").replace(/<!(?=--)/g, "<\\!"); };
  const local = function (ref) { return !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref); };
  const join = function (dir, ref) {
    const out = [];
    (dir + "/" + ref.split(/[?#]/)[0]).split("/").forEach(function (s) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); });
    return out.join("/");
  };

  class PageFrame {
    constructor(container, src, options) {
      this.src = Object.assign({}, src);
      this.opts = options || {};
      this.invoke = this.opts.call || function (m, p) { return window.threadPage.invoke(m, p); };
      this.id = src.kind === "repo" ? "repo:" + src.folder : "page:" + src.path;
      this.folder = src.kind === "repo" ? String(src.folder).replace(/\/+$/, "") : "";
      this.failures = [];
      this.state = { draft: {}, scrollY: 0 };
      this.stateKey = nsKey(this.id, "state");
      this.frame = document.createElement("iframe");
      this.frame.title = this.title();
      this.frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads allow-popups");
      Object.assign(this.frame.style, { flex: "1", width: "100%", height: "100%", border: "0", display: "none", background: "transparent" });
      container.appendChild(this.frame);
      this.onMessage = (e) => this.answer(e);
      window.addEventListener("message", this.onMessage);
      if (src.kind === "page" && !src.html) this.poll = setInterval(() => this.checkPage(), 4000);
      this.start();
    }
    title() { return this.src.title || (this.src.kind === "repo" ? baseOf(this.folder) : baseOf(this.src.path).replace(/\.html?$/i, "")); }
    entry() { return this.src.kind === "repo" ? this.folder + "/" + (this.src.doc || "index.html") : this.src.path; }
    destroy() { this.dead = true; clearInterval(this.poll); window.removeEventListener("message", this.onMessage); this.frame.remove(); }
    reload() { this.dirty = false; return this.load(); }
    /** Repository paths that changed: a tool reloads when one is in its folder. */
    changed(paths) { if (this.src.kind === "repo" && !this.dead && (paths || []).some((p) => String(p).startsWith(this.folder + "/"))) this.load(); }
    report(status, message) { if (this.opts.onState) this.opts.onState({ status: status, message: message || "", failures: this.failures.slice() }); }
    async session() { if (!this.sessionId) this.sessionId = this.opts.sessionId || ((await this.invoke("context.get", {})).session || {}).id; return this.sessionId; }
    async start() {
      try { const r = await this.invoke("storage.get", { key: this.stateKey }); if (r && r.found && r.value && typeof r.value === "object") this.state = Object.assign(this.state, r.value); } catch (e) { /* none kept */ }
      this.load();
    }
    saveState() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.invoke("storage.set", { key: this.stateKey, value: this.state }).catch(() => {}), 800); }

    async readAll(paths, version) {
      const got = {};
      for (let i = 0; i < paths.length; i += 64) {
        const r = await this.invoke("syns.readMany", { paths: paths.slice(i, i + 64), version: version });
        r.files.forEach((x) => { got[x.path] = x.text; });
      }
      return got;
    }
    async load() {
      this.report("loading");
      const at = this.entry(), dir = dirOf(at).replace(/\/$/, "");
      try {
        let text, version;
        if (this.src.kind === "repo") {
          const tries = this.src.doc ? [at] : [this.folder + "/index.html", this.folder + "/.page/index.html"];
          const first = await this.invoke("syns.readMany", { paths: tries });
          const f = first.files.find((x) => x.text !== undefined);
          if (!f) throw new Error(tries.join(" or ") + ": not found");
          if (!this.src.doc) { this.src.doc = f.path.slice(this.folder.length + 1); return this.load(); }
          text = f.text; version = first.version;
        } else if (this.src.html) { text = this.src.html; this.revision = "inline"; // the page this document is: the host refreshes it
        } else {
          const r = await this.invoke("pages.read", { pages: [{ sessionId: await this.session(), path: at }] });
          const e = r.pages[0] || {};
          if (e.error || e.html === undefined) throw new Error(at + ": " + ((e.error && (e.error.reason || e.error.message)) || "not served"));
          text = e.html; this.revision = e.revision;
        }
        const doc = new DOMParser().parseFromString(text, "text/html");
        doc.querySelectorAll("script[data-thread-page-kernel], script[data-thread-page-contributor], base").forEach((el) => el.remove()); // the host's kernel, page scripts and base: this frame has its own
        const refs = this.src.kind === "page" ? [] : Array.from(doc.querySelectorAll('link[rel="stylesheet"][href], script[src]'))
          .filter((el) => local(el.getAttribute("href") || el.getAttribute("src")));
        const want = refs.map((el) => join(dir, el.getAttribute("href") || el.getAttribute("src")));
        const got = await this.readAll(want, version);
        refs.forEach((el, i) => {
          const t = got[want[i]] || "";
          if (el.tagName === "LINK") { const s = doc.createElement("style"); s.textContent = t; el.replaceWith(s); }
          else { el.removeAttribute("src"); el.textContent = safeScript(t) + "\n//# sourceURL=" + want[i]; }
        });
        doc.querySelectorAll("script:not([src])").forEach((s) => { s.textContent = safeScript(s.textContent); });
        const shim = doc.createElement("script");
        shim.textContent = "(" + SHIM.toString() + ")(" + JSON.stringify({ scope: this.src.kind === "repo" ? this.folder : null, draft: this.state.draft, scrollY: this.state.scrollY }).replace(/</g, "\\u003c") + ");";
        doc.head.prepend(shim);
        if (this.dead) return;
        this.frame.srcdoc = "<!doctype html>\n" + doc.documentElement.outerHTML;
        this.frame.style.display = "";
        this.report("shown");
      } catch (e) {
        this.frame.style.display = "none";
        this.report("failed", String(e && e.message || e));
      }
    }
    // A page read with pages.read reloads when the agent saves it (drafts and scroll come back with it).
    async checkPage() {
      if (this.dead || !this.frame.isConnected || this.frame.offsetParent === null || document.visibilityState !== "visible" || !this.revision) return;
      try {
        const r = await this.invoke("pages.read", { pages: [{ sessionId: await this.session(), path: this.src.path, ifNoneMatch: this.revision }] });
        const e = r.pages[0] || {};
        if (!e.unchanged && e.revision && e.revision !== this.revision) this.load();
      } catch (e) { /* gone or busy: keep what is shown */ }
    }

    // ---- what the frame asks
    answer(e) {
      if (e.source !== this.frame.contentWindow || !e.data || !e.data.__tool) return;
      const d = e.data, win = this.frame.contentWindow, reply = (msg) => win && win.postMessage(Object.assign({ __tool: "answer", id: d.id }, msg), "*");
      if (d.__tool === "invoke") {
        this.call(d.method, d.params || {}).then((result) => reply({ ok: true, result: result }), (x) => {
          this.failures.push(d.method + ": " + (x.code || "") + (x.reason ? " (" + x.reason + ")" : "") + " " + String(x.message || x).slice(0, 160));
          this.report("shown");
          reply({ ok: false, error: { code: x.code || "unavailable", reason: x.reason, detail: x.detail, message: String(x.message || x) } });
        });
      } else if (d.__tool === "link") this.link(String(d.href || ""), !!d.newTab);
      else if (d.__tool === "dirty") this.dirty = !!d.on;
      else if (d.__tool === "draft") { this.state.draft = d.sent ? {} : (d.values || {}); this.saveState(); }
      else if (d.__tool === "scroll") { this.state.scrollY = d.y || 0; this.saveState(); }
      else if (d.__tool === "form") {
        const lines = ["**" + String(d.title || this.title()).trim() + "**" + (this.src.kind === "page" ? " (page " + this.src.path + ")" : " (tool " + this.folder + ")")];
        if (d.action) lines.push("Action: " + d.action);
        (d.answers || []).forEach((a) => lines.push("- " + a.label + ": " + a.value));
        this.invoke("session.reply", { kind: "prompt", text: lines.join("\n") })
          .then(() => win && win.postMessage({ __tool: "formdone", ok: true }, "*"), (x) => win && win.postMessage({ __tool: "formdone", ok: false, message: String(x.message || x) }, "*"));
      }
    }
    async call(method, params) {
      const repo = this.src.kind === "repo";
      if (CACHED[method] && !params.version) {
        const c = cache[method];
        if (!c || Date.now() - c.at >= CACHED[method]) { const value = this.invoke(method, params); cache[method] = { at: Date.now(), value: value }; value.catch(() => { delete cache[method]; }); }
        return this.strip(await cache[method].value);
      }
      if (PASS.includes(method)) return this.invoke(method, params);
      if (method === "storage.get" || method === "storage.set") return this.invoke(method, Object.assign({}, params, { key: nsKey(this.id, params.key) }));
      if (method === "storage.setMany") return this.invoke(method, { entries: (params.entries || []).map((x) => Object.assign({}, x, { key: nsKey(this.id, x.key) })) });
      if (!SYNS.includes(method)) throw Object.assign(new Error(method + " isn't available here"), { code: "unavailable" });
      const F = this.folder;
      const inF = (p) => {
        if (typeof p !== "string") return p;
        if (p.startsWith("/") || p.split("/").some((s) => s === ".." || s === ".")) throw Object.assign(new Error("A path must stay inside " + (F || "the repository")), { code: "invalid_params" });
        return !repo ? p : p ? F + "/" + p : F;
      };
      const p = Object.assign({}, params);
      if (repo) {
        if ("path" in p || ["syns.ls", "syns.glob"].includes(method)) p.path = inF(p.path || "");
        if (Array.isArray(p.paths)) p.paths = p.paths.map(inF);
        if (typeof p.pattern === "string" && method === "syns.glob") p.pattern = F + "/" + p.pattern;
        if (Array.isArray(p.glob)) p.glob = p.glob.map((g) => F + "/" + g);
        if (method === "syns.move") { p.from = inF(p.from); p.to = inF(p.to); }
        if (Array.isArray(p.files)) p.files = p.files.map((x) => Object.assign({}, x, { path: inF(x.path) }));
        if (Array.isArray(p.deletions)) p.deletions = p.deletions.map((x) => typeof x === "string" ? inF(x) : Object.assign({}, x, { path: inF(x.path) }));
      }
      // Reads that fail transiently (many at once, the CLI busy) are asked again, twice at most.
      const write = /^syns\.(write|writeBinary|edit|rm|move|commit|revert)$/.test(method);
      for (let n = 0; ; n++) {
        try { return this.strip(await this.invoke(method, p)); }
        catch (x) { if (write || n >= 2 || !/^(handler_error|timeout|rate_limited)$/.test(x.code || "")) throw x; await new Promise((ok) => setTimeout(ok, 600 * (n + 1))); }
      }
    }
    // A tool's answers name paths from its folder, and nothing outside it. An agent page's are the repository's.
    strip(v) {
      if (this.src.kind !== "repo") return v;
      const pre = this.folder + "/";
      const own = (s) => typeof s === "string" && (s.startsWith(pre) || s === this.folder);
      const cut = (s) => s === this.folder ? "" : s.slice(pre.length);
      const walk = (x, key) => {
        if (Array.isArray(x)) {
          return x.filter((y) => !(typeof y === "string" && /path/i.test(key || "")) || own(y))
            .filter((y) => !(y && typeof y === "object" && typeof y.path === "string") || own(y.path))
            .map((y) => typeof y === "string" && own(y) ? cut(y) : walk(y, key));
        }
        if (x && typeof x === "object") {
          const o = {};
          Object.keys(x).forEach((k) => { o[k] = (k === "path" && own(x[k])) ? cut(x[k]) : (k === "deferred" || k === "paths") ? walk(x[k], "path") : walk(x[k], k); });
          return o;
        }
        return x;
      };
      return walk(v);
    }
    // Where a link goes, for the app to open: another site, a repository file, a document of the page.
    link(href, newTab) {
      const go = this.opts.onLink || ((t) => { if (t.kind === "external") this.invoke("navigation.openExternal", { url: t.url }).catch(() => {}); });
      if (/^https?:/i.test(href)) return go({ kind: "external", url: href, newTab: true });
      if (!local(href)) return;
      const to = join(dirOf(this.entry()).replace(/\/$/, ""), href);
      if (this.src.kind === "page") return go({ kind: "page", path: to, newTab: newTab });
      if (to.startsWith(this.folder + "/") && /\.html?$/i.test(to)) { this.src.doc = to.slice(this.folder.length + 1); this.load(); return; }
      go({ kind: "repo", path: to, newTab: newTab });
    }
  }

  P.frame = function (container, src, options) { return new PageFrame(container, src, options); };
  /** The folders that open as pages: one holding an index.html (not under a dot folder, not inside another), or a placed template (.syns.yaml, its app in .page/). */
  P.tools = function (paths) {
    const placed = paths.filter((p) => /(^|\/)\.syns\.yaml$/.test(p) && p !== ".syns.yaml").map((p) => p.slice(0, -".syns.yaml".length));
    const inPlaced = (p) => placed.some((t) => p.startsWith(t));
    const html = paths.filter((p) => /\/index\.html$/.test(p) && !/(^|\/)\./.test(p) && !inPlaced(p)).map((p) => p.slice(0, -"index.html".length));
    return { placed: placed, html: html, all: placed.concat(html) };
  };
  P.pageUrl = function (sessionId, path, fragment) {
    let origin = "";
    try { origin = new URL(location.href).origin; } catch (e) { /* stays relative */ }
    return origin + "/api/v1/plugins/thread-pages/http/page?session=" + encodeURIComponent(sessionId) + (path ? "&path=" + encodeURIComponent(path) : "") + (fragment || "");
  };
  P.goTo = function (fromPath, path) {
    const here = String(fromPath || "index.html").split("/").slice(0, -1);
    const q = String(path).indexOf("?"), file = q < 0 ? String(path) : String(path).slice(0, q), query = q < 0 ? "" : String(path).slice(q);
    const to = file.split("/");
    let i = 0; while (i < here.length && i < to.length - 1 && here[i] === to[i]) i++;
    const a = document.createElement("a");
    a.href = here.slice(i).map(function () { return ".."; }).concat(to.slice(i)).join("/") + query;
    document.body.appendChild(a); a.click(); a.remove();
  };
})();

/*
 * The bootstrap. It keeps the page as the host served it (window.SynsPages.page), holds back the page's own scripts
 * (they run in the workspace's frame instead), clears the document and loads the repository's workspace
 * (.page/index.html) into it, in one read. With no workspace to load (the repository has no .page/index.html, or
 * the folder is not a repository yet), it puts the page back as written and runs its scripts.
 *   SynsPages.app   { version, reload(), onStop(fn) }   an in-page reload: stop the app, read it again, start it.
 */
(function () {
  "use strict";
  const P = window.SynsPages;
  if (P.page || !document.currentScript || document.readyState !== "loading") return;
  const me = document.currentScript;
  // The host's kernel and every contributor's page script run as served; only the page's own scripts are held.
  const served = function (s) { return s === me || s.hasAttribute("data-thread-page-kernel") || s.hasAttribute("data-thread-page-contributor"); };
  const held = new Map();
  const observer = new MutationObserver(function (records) {
    records.forEach(function (r) { r.addedNodes.forEach(function (n) {
      if (n.tagName === "SCRIPT" && !served(n) && !held.has(n)) { held.set(n, n.getAttribute("type")); n.type = "text/x-held"; }
    }); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ---- the page this script is in
  let written = null;
  function capture() {
    const kernel = document.querySelector("script[data-thread-page-kernel]");
    let docPath = "index.html";
    try { docPath = JSON.parse(kernel.getAttribute("data-config")).documentPath || docPath; } catch (e) { /* the entry document */ }
    observer.disconnect();
    const scripts = Array.from(document.scripts), clone = document.documentElement.cloneNode(true), cs = Array.from(clone.querySelectorAll("script"));
    scripts.forEach(function (s, i) {
      if (served(s)) cs[i].remove();
      else if (held.has(s)) { if (held.get(s) === null) cs[i].removeAttribute("type"); else cs[i].setAttribute("type", held.get(s)); }
    });
    clone.querySelectorAll("base").forEach(function (el) { el.remove(); });
    const body = clone.querySelector("body");
    const hasPage = !!body && (Array.from(body.children).some(function (el) { return el.tagName !== "SCRIPT"; }) || body.textContent.trim() !== "");
    P.page = Object.freeze({
      path: docPath, hasPage: hasPage,
      title: document.title || docPath.replace(/^.*\//, "").replace(/\.html?$/i, ""),
      html: hasPage ? "<!doctype html>\n" + clone.outerHTML : null,
    });
    // The page's own nodes, kept to put back when there is no workspace.
    written = { head: Array.from(document.head.childNodes), body: Array.from(document.body.childNodes), attributes: Array.from(document.body.attributes).map(function (a) { return [a.name, a.value]; }) };
    Array.from(document.head.children).forEach(function (el) { if (el !== kernel && el.tagName !== "META") el.remove(); });
    Array.from(document.body.attributes).forEach(function (a) { document.body.removeAttribute(a.name); });
    const style = document.createElement("style");
    style.textContent = ":root{color-scheme:light dark}#boot-msg{font:15px/22px system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 24px}";
    document.head.appendChild(style);
    say("Loading…");
  }
  function say(text, retry) {
    const m = document.createElement("div"); m.id = "boot-msg"; m.textContent = text;
    if (retry) { const b = document.createElement("button"); b.type = "button"; b.textContent = "Try again"; b.onclick = retry; m.append(" ", b); }
    document.body.replaceChildren(m);
  }
  // No workspace: the page as written, its held scripts run in order, then the load events they missed.
  async function showWritten() {
    document.head.replaceChildren.apply(document.head, written.head);
    Array.from(document.body.attributes).forEach(function (a) { document.body.removeAttribute(a.name); });
    written.attributes.forEach(function (a) { document.body.setAttribute(a[0], a[1]); });
    document.body.replaceChildren.apply(document.body, written.body);
    for (const [s, type] of held) {
      if (!s.isConnected) continue;
      const node = document.createElement("script");
      Array.from(s.attributes).forEach(function (a) { node.setAttribute(a.name, a.value); });
      if (type === null) node.removeAttribute("type"); else node.setAttribute("type", type);
      node.textContent = s.textContent;
      const runs = type === null || /^\s*(|module|text\/javascript|application\/javascript)\s*$/i.test(type);
      if (runs && node.hasAttribute("src")) await new Promise(function (done) { node.onload = node.onerror = done; s.replaceWith(node); });
      else s.replaceWith(node);
    }
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    if (document.readyState === "complete") window.dispatchEvent(new Event("load"));
  }

  // ---- the workspace, read in one call
  const entry = ".page/index.html", dir = ".page/";
  const local = function (ref) { return !!ref && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref); };
  const resolve = function (ref) { const out = []; (dir + ref.split(/[?#]/)[0]).split("/").forEach(function (s) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }); return out.join("/"); };
  const stops = [];
  let added = [];
  const app = P.app = { version: null, onStop: function (fn) { stops.push(fn); }, reload: function () { stop(); say("Loading…"); return load().catch(fail); } };
  function stop() { stops.splice(0).forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); added.forEach(function (n) { n.remove(); }); added = []; }
  async function read(paths, version) {
    const out = {};
    for (let ask = paths; ask.length;) {
      let r;
      for (let n = 0; ; n++) {
        try { r = await window.threadPage.invoke("syns.readMany", { paths: ask.slice(0, 64), version: version || undefined }); break; }
        catch (e) { if (n >= 3 || !/^(timeout|rate_limited|handler_error)$/.test(e.code || "")) throw e; await new Promise(function (ok) { setTimeout(ok, 1200 * (n + 1)); }); }
      }
      version = version || r.version;
      r.files.forEach(function (f) { out[f.path] = f; });
      ask = (r.deferred || []).concat(ask.slice(64));
    }
    return { files: out, version: version };
  }
  async function load() {
    if (!window.threadPage) return showWritten();
    let first;
    try { first = await read([entry]); }
    catch (e) {
      if (e.reason === "no_repo") return showWritten();
      throw e;
    }
    const index = first.files[entry];
    if (!index || index.text === undefined) return showWritten();
    app.version = first.version;
    const doc = new DOMParser().parseFromString(index.text, "text/html");
    const styles = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"][href], style'));
    const scripts = Array.from(doc.querySelectorAll("script"));
    const wanted = styles.map(function (el) { return el.getAttribute("href"); }).concat(scripts.map(function (el) { return el.getAttribute("src"); })).filter(local).map(resolve);
    const files = wanted.length ? (await read(wanted, first.version)).files : {};
    const missing = wanted.filter(function (p) { return !files[p] || files[p].text === undefined; });
    if (missing.length) return say("The workspace names files that aren't in the repository: " + missing.join(", "));
    document.title = doc.title || document.title;
    styles.forEach(function (el) {
      const href = el.getAttribute("href"), node = document.createElement(el.tagName === "LINK" && !local(href) ? "link" : "style");
      if (node.tagName === "LINK") { node.rel = "stylesheet"; node.href = href; } else node.textContent = el.tagName === "STYLE" ? el.textContent : files[resolve(href)].text;
      document.head.appendChild(node); added.push(node);
    });
    Array.from(doc.body.attributes).forEach(function (a) { document.body.setAttribute(a.name, a.value); });
    scripts.forEach(function (s) { s.remove(); });
    document.body.replaceChildren.apply(document.body, Array.from(doc.body.childNodes).map(function (n) { return document.importNode(n, true); }));
    for (const s of scripts) {
      const node = document.createElement("script");
      Array.from(s.attributes).forEach(function (a) { if (a.name !== "src") node.setAttribute(a.name, a.value); });
      const src = s.getAttribute("src");
      if (src && !local(src)) { node.src = src; await new Promise(function (done) { node.onload = node.onerror = done; document.body.appendChild(node); }); }
      else { node.textContent = src ? files[resolve(src)].text + "\n//# sourceURL=" + resolve(src) : s.textContent; document.body.appendChild(node); }
    }
  }
  function fail(e) { console.error(e); say("The workspace didn't load: " + ((e && e.message) || e), function () { say("Loading…"); load().catch(fail); }); }
  document.addEventListener("DOMContentLoaded", function () { capture(); load().catch(fail); }, { once: true });
})();
`;
//#endregion
//#region src/page-script.ts
/** How long the check may take: inside the host's 2 s for every page script (07 R5.91), so a slow CLI is a page without the script, not a late answer. */
const PAGE_SCRIPT_MS = 1500;
/**
* threadPagesPageScript (S2.27–S2.29): the page host, at the plugin's version, for a page of a session whose folder
* is a Syns repository or a folder placed in one; none for any other page. One `syns repo --json` in the folder says
* which, every time, so a folder made a repository during a turn gets the script on its next load. Never throws.
*/
async function answerPageScript(cli, ask, ms = PAGE_SCRIPT_MS) {
	let where;
	try {
		where = sessionWhere(ask?.caller?.workspace);
	} catch {
		return null;
	}
	if (!where) return null;
	const controller = new AbortController();
	let timer;
	const late = new Promise((resolve) => timer = setTimeout(() => resolve(null), ms));
	try {
		const ran = await Promise.race([cli.run(where, ["repo", "--json"], void 0, Date.now() + ms, void 0, controller.signal), late]);
		if (ran?.exitCode !== 0 || !isObject(ran.stdout)) return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return ask.have === "0.10.0" ? { version: VERSION } : {
		version: VERSION,
		script: PAGEHOST
	};
}
function isObject(text) {
	try {
		const value = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}
//#endregion
//#region src/scope.ts
/**
* The host half's check of a document's scope before it starts the CLI there
* (D43, D46). The scope must resolve, symlinks followed, to a directory at or
* below the session's folder, and hold its own `.syns.yaml`, so that the
* nearest identity file is the scope itself and the CLI answers for that
* folder alone. Answers the resolved folder, where the CLI is then started,
* so a link swapped in afterwards cannot move it; null when any of this fails.
* It resolves paths and asks what they are; it reads nothing in them.
*/
async function scopeFolder(cwd, within) {
	try {
		const [folder, root] = await Promise.all([realpath(cwd), realpath(within)]);
		if (!(await stat(folder)).isDirectory()) return null;
		if (folder !== root && !folder.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
		if (!(await stat(join(folder, ".syns.yaml"))).isFile()) return null;
		return folder;
	} catch {
		return null;
	}
}
const executable = async (file) => access(file, constants.X_OK).then(() => true, () => false);
/** The named executable if a setting names one; else PATH, then the usual folders under home. S2.8 */
async function findSyns(synsPath, env = process.env, home = homedir()) {
	if (synsPath) return await executable(synsPath) ? synsPath : null;
	const folders = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		join(home, ".cargo", "bin"),
		join(home, ".local", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin"
	];
	for (const folder of folders) {
		const candidate = join(folder, process.platform === "win32" ? "syns.exe" : "syns");
		if (await executable(candidate)) return candidate;
	}
	return null;
}
/** What a run answers when its call was aborted before it started (S2.14). */
const NOT_STARTED = {
	exitCode: null,
	stdout: "",
	stderr: "",
	timedOut: true,
	spawnError: null,
	overflowed: false
};
/**
* One process, started directly with an argument array, never through a shell. S2.10
*
* `caller` is the host's name, set as SYNS_CALLER over anything inherited or passed, so every request the CLI sends
* says which page host made it (S2.24, D83). `signal` aborting stops the process as its time limit does; it is
* listened to here and not handed to spawn, whose abort would SIGTERM the process and end as a spawn error.
*/
function runSyns(bin, args, cwd, stdin, timeoutMs, signal, caller, provenance) {
	if (signal.aborted) return Promise.resolve(NOT_STARTED);
	return new Promise((resolve) => {
		const out = [];
		const err = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let overflowed = false;
		let settled = false;
		const finish = (exitCode, spawnError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve({
				exitCode,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				timedOut,
				spawnError,
				overflowed
			});
		};
		const child = spawn(bin, args, {
			cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				NO_COLOR: "1",
				...provenance ?? {},
				SYNS_CALLER: caller
			}
		});
		const stop = () => {
			child.kill("SIGKILL");
			child.stdout.destroy();
			child.stderr.destroy();
			finish(null, null);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		const abort = () => {
			timedOut = true;
			stop();
		};
		signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => {
			if (overflowed) return;
			if (outBytes + chunk.length > 41943040) {
				overflowed = true;
				stop();
				return;
			}
			outBytes += chunk.length;
			out.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (errBytes + chunk.length > 41943040) return;
			errBytes += chunk.length;
			err.push(chunk);
		});
		child.on("error", (error) => finish(null, String(error)));
		child.on("close", (code) => finish(code, null));
		child.stdin.on("error", () => void 0);
		child.stdin.end(stdin ?? "");
	});
}
//#endregion
//#region hosts/claude/runner.ts
/** The name every request of the CLI's carries in its User-Agent on Claude Code (S2.24, D83; bartsoj/syns D-238). */
const CALLER = "claude-pages";
const refused = (spawnError) => ({
	exitCode: null,
	stdout: "",
	stderr: "",
	timedOut: false,
	spawnError,
	overflowed: false
});
/**
* The Runner on Claude Code: the session's folder is on this machine, so the CLI runs here, in-process, with what
* bb's host half calls on its machine (scopeFolder, findSyns, runSyns). No host call, so no 8 MiB bound and no
* slices. `hostId` is ignored: there is one machine.
*/
function createLocalRunner(synsPath) {
	return { async run({ cwd, within, args, env, stdin, stdinBase64, timeoutMs, signal }) {
		let folder = cwd;
		if (within !== void 0) {
			const resolved = await scopeFolder(cwd, within);
			if (resolved === null) return refused(SCOPE_OUTSIDE);
			folder = resolved;
		}
		const bin = await findSyns(synsPath);
		if (!bin) return refused(CLI_NOT_FOUND);
		const input = stdinBase64 === void 0 ? stdin : Buffer.from(stdinBase64, "base64");
		return runSyns(bin, args, folder, input, timeoutMs, signal ?? new AbortController().signal, CALLER, env);
	} };
}
//#endregion
//#region hosts/claude/process.ts
/**
* The Syns contributor on Claude Code: a process contributor (unife-pages 07 R-X5, U24). It registers the same
* declaration bb gets (R-X1) with the Unife Pages daemon over its control socket, and answers each call the daemon
* POSTs to it with the same dispatch as bb's plugin, the CLI running on this machine in the folder the call names
* (`caller.workspace`, U44).
*
*   POST   /v1/contributors            { kind: "process", namespace: "syns", declaration, endpoint } → 201
*   DELETE /v1/contributors/syns       on stop
*   the daemon POSTs { namespace, method, params, caller, requestId } to the endpoint and reads the answer,
*   and { namespace, kind: "pageScript", caller, documentPath, have } for the page script (07 §A page script, S2.27)
*
* The endpoint is a Unix socket in a folder only this user can open, so no browser and no other user reaches it.
* Started by the daemon from this plugin's unife-pages.json (U45), it registers with the token it was given and lives
* as long as that daemon. Started by hand, it registers again after a daemon restart, and a refusal (another
* registrant holds `syns`, or an installed plugin declares it) is logged and tried again a minute later.
*/
const NAMESPACE = "syns";
const CONTROL_SOCKET = "control.sock";
const BODY_LIMIT = 8388608;
/** What the environment says, as `serve` takes it. */
function optionsFromEnv(env, log) {
	return {
		socket: env.UNIFE_PAGES_CONTROL_SOCKET || join(env.UNIFE_PAGES_HOME || join(homedir(), ".unife-pages"), CONTROL_SOCKET),
		token: env.UNIFE_PAGES_CONTRIBUTOR_TOKEN || void 0,
		synsPath: env.SYNS_PATH?.trim() || void 0,
		agentInstructions: env.SYNS_PAGES_INSTRUCTION !== "0",
		log
	};
}
/**
* HTTP over the daemon's control socket, a fresh connection each time. With Node's keep-alive agent a socket reused
* after the 5 s poll still carries its 5 s idle timer, which fires as the next request starts: a third of the polls
* then failed and the process registered again every 10–15 s (measured on the owner's daemon, 9 October 2026).
* The request still says keep-alive and the socket is closed here once the answer is read: sent with Connection: close,
* about one body size in four failed with EPIPE and no answer (Node 26.7 on macOS, 14 October 2026).
*/
function controlOver(socketPath, token) {
	return (method, path, body) => new Promise((resolve, reject) => {
		const text = body === void 0 ? void 0 : JSON.stringify(body);
		const headers = {
			connection: "keep-alive",
			...text === void 0 ? {} : {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(text)
			},
			...token ? { "x-unife-contributor-token": token } : {}
		};
		const req = http.request({
			socketPath,
			path,
			method,
			timeout: 5e3,
			headers,
			agent: false
		}, (res) => {
			let out = "";
			res.setEncoding("utf8");
			res.on("data", (d) => out += d);
			res.on("end", () => {
				req.destroy();
				resolve({
					status: res.statusCode ?? 0,
					text: out
				});
			});
		});
		req.on("timeout", () => req.destroy(/* @__PURE__ */ new Error("timeout")));
		req.on("error", reject);
		req.end(text);
	});
}
async function serve(options) {
	const { log } = options;
	const control = controlOver(options.socket, options.token);
	const cli = createCli(createLocalRunner(options.synsPath), options.limits ?? LIMITS);
	const invoke = createDispatch({
		cli,
		log
	});
	const declaration = buildDeclaration(METHODS, { agentInstructions: options.agentInstructions });
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/invoke") {
			res.writeHead(404).end();
			return;
		}
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) req.destroy();
			else chunks.push(chunk);
		});
		req.on("end", () => {
			let call;
			try {
				const { namespace: _namespace, ...rest } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				call = rest;
			} catch {
				res.writeHead(400).end();
				return;
			}
			(call.kind === "pageScript" ? answerPageScript(cli, call) : invoke(call)).then((answer) => {
				const text = JSON.stringify(answer);
				res.writeHead(200, {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(text)
				}).end(text);
			});
		});
	});
	const folder = mkdtempSync(join(tmpdir(), "syns-pages-"));
	const socketPath = join(folder, "invoke.sock");
	await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, () => resolve()));
	const endpoint = `unix:${socketPath}:/invoke`;
	let registeredWith = null;
	let firstDaemon = null;
	let retryAt = 0;
	const tick = async () => {
		let pid;
		try {
			pid = JSON.parse((await control("GET", "/v1/daemon")).text).pid;
		} catch {
			registeredWith = null;
			return;
		}
		if (options.token) {
			firstDaemon ??= pid;
			if (pid !== firstDaemon) {
				log.info(`the daemon that started this process is gone; daemon ${pid} starts its own`);
				options.onDaemonGone?.();
				return;
			}
		}
		if (pid === registeredWith || Date.now() < retryAt) return;
		const answer = await control("POST", "/v1/contributors", {
			kind: "process",
			namespace: NAMESPACE,
			declaration,
			endpoint
		}).catch((error) => ({
			status: 0,
			text: error.message
		}));
		if (answer.status === 201) {
			registeredWith = pid;
			retryAt = 0;
			log.info(`registered ${NAMESPACE} ${declaration.version} with the Unife Pages daemon ${pid}`);
		} else {
			retryAt = Date.now() + 6e4;
			log.warn(`registration refused: ${answer.status} ${answer.text.slice(0, 200)}${answer.status === 403 ? " (an installed plugin may declare this namespace; see the daemon's log)" : ""}`);
		}
	};
	let ticking = tick();
	const timer = setInterval(() => void (ticking = ticking.then(tick)), options.everyMs ?? 5e3);
	return {
		endpoint,
		async stop(unregister = true) {
			clearInterval(timer);
			await ticking.catch(() => void 0);
			if (unregister && registeredWith !== null) await control("DELETE", `/v1/contributors/${NAMESPACE}`).catch(() => void 0);
			await new Promise((resolve) => server.close(() => resolve()));
			rmSync(folder, {
				recursive: true,
				force: true
			});
		}
	};
}
//#endregion
//#region hosts/claude/main.ts
/**
* Run by hand, or by a plugin that starts it: `node hosts/claude/bin/syns-pages.mjs`. Ctrl-C or SIGTERM unregisters.
* Settings are the environment: SYNS_PATH (the executable), SYNS_PAGES_INSTRUCTION=0 (declare no fragment),
* UNIFE_PAGES_HOME (the daemon's home); a daemon that starts it also sets UNIFE_PAGES_CONTROL_SOCKET and
* UNIFE_PAGES_CONTRIBUTOR_TOKEN.
*/
const say = (line) => void process.stderr.write(`syns: ${line}\n`);
const served = await serve({
	...optionsFromEnv(process.env, {
		info: say,
		warn: say
	}),
	onDaemonGone: () => void served.stop(false).finally(() => process.exit(0))
});
say(`answering at ${served.endpoint}`);
const stop = () => void served.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
//#endregion
export {};
