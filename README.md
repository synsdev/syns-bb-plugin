# Syns bb plugin

A bb plugin that gives
[Thread Pages](https://github.com/unifedev/bb-thread-pages) read and write access
to the calling session's [Syns](https://syns.dev) repository, through the Syns
CLI. The short product description is in [PLUGIN_OVERVIEW.md](./PLUGIN_OVERVIEW.md).

```
page                     threadPage.invoke("syns.readMany", { paths })
  ↓ Thread Pages bridge  validated against this plugin's declared schema, rate-limited, no dialog
server half              session → machine and folder; method → CLI arguments; CLI failure → code + reason
  ↓ bb host call
host half                runs `syns … --json` in that folder, on that machine
  ↓
Syns CLI → Syns API      the only thing that touches the repository
```

## Install

Requires bb 0.43 or later, Thread Pages 1.4.0 or later, and the Syns CLI 0.3.3 or
later — installed and logged in (`syns login`) on every machine whose sessions
should reach a repository.

```sh
bb plugin install https://github.com/synsdev/syns-bb-plugin
```

The bb plugin id is `syns`: Thread Pages takes a contributor's namespace from the
plugin id, and the methods are `syns.*`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentInstructions` | `true` | Tell every eligible session about `syns.*`, in about 1.2 KiB joined to the Thread Pages instruction, which bb cuts at 4,096 characters |
| `synsPath` | unset | Absolute path of the `syns` executable, when it is not on the daemon's `PATH` or in `~/.cargo/bin`, `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` |

## A tool first

The plugin ships a second skill, `syns-tools`, besides the operator's
`syns-bb-plugin`. When the person asks for a piece of work they will go on
working in (a board, a deck, a document, a plan…), an agent finds a `syns-app`
template and places it as a folder with `syns place`. When the session is in no
Syns repository, it forks the template into a new private repository instead.
The template's `.page/loader.html` becomes the page, byte for byte, and the
folder's `AGENTS.md` governs. The agent moves its own session only when the
session was started for that work in a Syns repository; otherwise it starts a
new session. Either way the session lives in the holding repository's bb
project, with its environment set to the folder. Not for a page that reports on other work, nor in a review, helper
or coding session. With a CLI too old for `syns place`, the agent says so and
writes the page as before. The instruction fragment leads with that trigger.

## The methods

| Method | Effect | What it does |
| --- | --- | --- |
| `syns.repo` | read | Owner, name and head `version`; in a placed folder also `holder`, `path` and `number`. The call a page polls with `watch` |
| `syns.whoami` | read | The account logged in on that machine |
| `syns.ls` | read | Files and folders, each file with a content hash, `blob`. Paged |
| `syns.readMany` | read | Up to 64 whole files at one version; what did not fit comes back as `deferred` |
| `syns.read` | read | A window of one file's lines |
| `syns.glob` · `syns.grep` | read | Find files by path pattern · search their texts |
| `syns.diff` | read | The paths, and optionally the patches, between two versions |
| `syns.history` | read | Versions, their paths, and who or what made each |
| `syns.commit` | write | Several files and deletions as one version, all or nothing |
| `syns.write` · `syns.edit` · `syns.rm` | write | One file's text (optionally only if new) · a replacement in it · its removal |
| `syns.revert` | write | One file back to its text at an earlier version |
| `syns.readBinary` | read | A file's bytes, such as a picture, as base64 in pieces of up to 720 KiB |
| `syns.writeBinary` | write | A file's bytes: whole up to 720 KiB, or larger in ordered pieces, published after the last; up to 25 MiB |

`version` is a commit SHA and opaque. Every write but `syns.revert` requires
`base`, the version the page last read; a moved head refuses it as `conflict`
with reason `stale_head` and the current version. While an agent is mid-turn in
the folder with unpublished edits, writes are refused as `checkout_dirty`.
Failures carry a fixed `code` and usually a `reason`: `no_repo`, `no_access`,
`cli_missing`, `timeout`, `stale_head`, `checkout_dirty`, `exists`, `no_match`,
`many_matches`, `bad_pattern`, `invalid_change`, `bad_offset`, `bad_hash`,
`too_large`. `syns.commit` also takes a picture's bytes beside texts, inline or
as an upload `syns.writeBinary` gathered with `hold: true`.

Page authors get the full reference, generated from the code, with
`bb thread-page guide`, section *Capabilities from other plugins*.

## Known limits

- **`syns.revert` is not checked.** The CLI's `revert` takes no parent, records
  no provenance and is not covered by the unpublished-changes guard, so a revert
  goes through whatever moved since the page read, and `syns.history` cannot show
  that a page made it. The plugin calls it as it is; the fix belongs in the CLI.
- **`syns.rm` of a path that is not there succeeds** with `changed: 0`, as the
  CLI does.
- **Pictures cross in pieces.** A page call carries at most 1 MiB, so bytes
  travel as base64 in 720 KiB pieces; an 8 MiB photo is 12 calls each way. The
  plugin holds a picture being gathered or read in memory for a minute between
  pieces, and bb's host calls carry at most 8 MiB, so larger standard input and
  output cross between the plugin's two halves in slices, also in memory only.
- **Pages show published state.** An agent's edits in the folder reach a page
  after its turn ends and is pushed.
- **A placed folder is all its page sees.** Run in a folder whose `.syns.yaml`
  names a `holder` and a `path`, every path is counted from the folder, and
  `syns.repo` reports the holder's head, which moves with any change to the
  holder. This needs a Syns CLI with folders (roadmap 239–241).
- Thread Pages refuses any result over 10,000 JSON values, which is why `syns.ls`
  and `syns.glob` are paged and `syns.grep` lowers its row limit as context grows.
- Proven on one machine. A session on a second enrolled host, a worktree
  environment and a repository the account cannot reach are not yet shown live.

## Adding a method

Every method is one entry in `src/methods/`: its name, description, effect,
parameter and result schemas, bounds, reasons, how its parameters become CLI
arguments, and how the CLI's output becomes its result. The declaration sent to
Thread Pages, the generated part of the guide, and the dispatch all come from
that table. Add an entry and its test; touch nothing else.

```sh
npm install
npm test            # 302 tests; no network, no login — the CLI is replayed from recordings; one test reads the instruction from this machine's bb, skipped without one
npm run typecheck
npm run build       # bb plugin build
```

Argument safety is not optional: the CLI is started with an argument array,
never a shell; option values go as `--option=value`, positionals after `--`,
texts on standard input. A page's path, pattern or text is never read as a flag.

## Design

The specification, every decision with its reasoning, the measured facts about
bb, Thread Pages and the CLI that the code rests on, the build plan, and the live
verification fixture and its log live in the Syns repository
`bartsoj/syns-bb-plugin`.

## Licence

MIT.
