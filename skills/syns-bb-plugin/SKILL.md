---
name: syns-bb-plugin
description: "Install, configure or diagnose the Syns bb plugin, which gives Thread Pages syns.* access to a session's Syns repository. Use for its settings and for cli_missing, no_access, no_repo or timeout answers; not for writing pages."
---

# Syns bb plugin: operating it

For an agent asked to install, configure or diagnose the plugin. An agent
writing a page that calls `syns.*` needs `bb thread-page guide`, section
*Capabilities from other plugins*, not this.

## What it is

Plugin id `syns` (package `bb-plugin-syns`). It contributes sixteen `syns.*`
capabilities to Thread Pages. A page's call reaches the plugin's server half,
which finds the calling session's machine and folder and asks its host half, on
that machine, to run the Syns CLI there. The page sees the repository, or the placed folder, that
session's folder belongs to, with paths counted from there. The plugin opens no repository file and keeps no
state about a repository.

## What each machine needs

- bb 0.43 or later, and the Thread Pages plugin 1.4.0 or later.
- The Syns CLI, 0.3.3 or later, **installed and logged in on every machine whose
  sessions' pages should reach a repository**. The CLI runs on the session's
  machine under the account logged in there, so access is whatever that account
  can reach. Check on that machine: `syns --version`, `syns whoami`.
- A session whose folder is inside a Syns checkout (a folder at or below one
  holding `.syns.yaml`). Where the nearest `.syns.yaml` names a `holder` and a
  `path`, the folder is a placed folder and the page sees only it. Anywhere else
  every method answers `no_repo`, by design.

## Installing and updating

```sh
bb plugin install <path or git URL of the plugin>
bb plugin list                      # syns should be listed and enabled
bb thread-page guide                # lists syns and its methods under "Registered now"
```

From a local path, after changing the plugin's code: `bb plugin build <path>`,
then `bb plugin reload syns`. The host half (`host.ts`) is only picked up after a
build.

## The two settings

```sh
bb plugin config syns                                  # show
bb plugin config syns set synsPath /absolute/path/to/syns
bb plugin config syns unset synsPath
bb plugin config syns set agentInstructions false
```

| Key | Default | Meaning |
| --- | --- | --- |
| `synsPath` | unset | Absolute path of the `syns` executable. Unset, the host half looks on its `PATH`, then in `~/.cargo/bin`, `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. One value serves every machine, so set it only when that path is right on all of them. |
| `agentInstructions` | `true` | Whether the plugin declares its short instruction fragment to Thread Pages, which tells page-writing agents that `syns.*` exists. Off, the methods and the guide stay. |

There is deliberately no setting that turns writes off, names a repository, or
widens what a page may reach.

## Diagnosing

Read the plugin's own log first: `bb plugin logs syns -n 200`. Every write is
logged as method, session, path count and outcome; every `handler_error` with
the CLI's exit code and the first 500 characters of its output. File texts,
commit messages and account details are never logged.

To call a method as a page would, without a page:

```sh
echo '{"method":"syns.repo","params":{},"caller":{"sessionId":"<thread id>"},"requestId":"diag"}' > /tmp/syns-call.json
bb plugin rpc call syns threadPagesInvoke --input-file /tmp/syns-call.json --json
```

| A page sees | What it means for an operator | What to do |
| --- | --- | --- |
| `unavailable` / `cli_missing` | The host half found no `syns` executable on the session's machine. bb's daemon may have a narrower `PATH` than a shell. | Install the CLI on that machine, or set `synsPath`. |
| `unavailable` / `no_access` | The CLI ran, and the account on that machine cannot reach the repository, or nobody is logged in there. The CLI prints the same 404 for both. | On that machine: `syns whoami`; if logged out, `syns login`; else check the account's access to the repository. |
| `unavailable` / `not_logged_in` | Only from `syns.whoami`: no login on that machine. | `syns login` on that machine. |
| `unavailable` / `no_repo` | The session's folder is not inside a Syns checkout, the caller is the home page, or the session has no environment with a host and a folder. | Expected outside a checkout. Otherwise check the session's folder for `.syns.yaml` at or above it. |
| `unavailable` / `timeout` | One CLI process ran past 20 seconds, or the whole call past 25. Usually the network or the Syns server; also more than 16 CLI processes waiting on one machine. | Run the same `syns … --json` by hand in the session's folder and time it. A write that timed out may still have landed: check `syns history --limit 3`. |
| `conflict` / `checkout_dirty` | The session's folder holds unpublished edits, usually because its agent is mid-turn. The CLI refuses writes until they are pushed. | Nothing to fix: it clears when the turn's push lands. A folder left dirty by hand: `syns status` there, then publish the edits with `syns sync` or restore the files. |
| `handler_error` | Anything the plugin did not recognise: an unexpected CLI message, output that is not JSON, a host call that failed. | The log line names the exit code and the output. A CLI release that rewords a message shows up here; the plugin recognises several refusals by their English text. |
| `response_too_large` | Thread Pages refuses a result over its response bound or over 10,000 JSON values. | The page asks for less: a narrower `path`, a smaller `limit` or `headLimit`. |
| `conflict` / `bad_offset` | A picture's pieces arrived out of order, or the plugin dropped them after a minute's pause, or since the plugin reloaded; `detail.expected` is where to resume, 0 to start again. | The page resends from `expected`. Many in a row: the page is sending pieces in parallel, or pausing between them. |
| `handler_error` naming `host output … exceeds 8388608 bytes` | A plugin older than 0.2.0 reading or writing a picture past one bb host call. | Update the plugin: 0.2.0 slices it (D32). |

## Known limits, the CLI's own

- `syns.revert` checks no base and records no provenance, because the CLI's
  `revert` takes neither today. Its commits show in `syns history` with no
  integration, run or trigger.
- `syns.rm` of a path that does not exist succeeds and changes nothing, as the
  CLI does.
- Pages show pushed state only. An agent's edits reach a page after its turn's
  push.
