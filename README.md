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
| `agentInstructions` | `true` | Tell every eligible session about `syns.*`, in about 1.8 KiB joined to the Thread Pages instruction |
| `synsPath` | unset | Absolute path of the `syns` executable, when it is not on the daemon's `PATH` or in `~/.cargo/bin`, `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` |

## The methods

| Method | Effect | What it does |
| --- | --- | --- |
| `syns.repo` | read | Owner, name and head `version`. The call a page polls with `watch` |
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

`version` is a commit SHA and opaque. Every write but `syns.revert` requires
`base`, the version the page last read; a moved head refuses it as `conflict`
with reason `stale_head` and the current version. While an agent is mid-turn in
the folder with unpublished edits, writes are refused as `checkout_dirty`.
Failures carry a fixed `code` and usually a `reason`: `no_repo`, `no_access`,
`cli_missing`, `timeout`, `stale_head`, `checkout_dirty`, `exists`, `no_match`,
`many_matches`, `bad_pattern`, `invalid_change`.

Page authors get the full reference, generated from the code, with
`bb thread-page guide`, section *Capabilities from other plugins*.

## Known limits

- **`syns.revert` is not checked.** The CLI's `revert` takes no parent, records
  no provenance and is not covered by the unpublished-changes guard, so a revert
  goes through whatever moved since the page read, and `syns.history` cannot show
  that a page made it. The plugin calls it as it is; the fix belongs in the CLI.
- **`syns.rm` of a path that is not there succeeds** with `changed: 0`, as the
  CLI does.
- **Pages show published state.** An agent's edits in the folder reach a page
  after its turn ends and is pushed.
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
npm test            # 235 tests; no network, no login, no bb — the CLI is replayed from recordings
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
