# verify

Answers "does it work?" against the real plugin, through the real Thread Pages bridge, in a real browser, and
carries a release of the plugin to bb and Claude Code. Python 3 (standard library only); run each tool with `python3`
from the root of a clone of this repository. Each tool's docstring says what it does, when it pays and its exit codes.
None of this is part of the plugin: bb builds `server.ts` and `host.ts`, and Claude Code installs `hosts/claude`.

The tools write nothing beside themselves: a record they keep (the VERIFY table, the scenario log) is a file you
name.

## The environment matrix

| Cell | What covers it |
| --- | --- |
| E1 the fixture over loopback | `run --fixtures`: `fixture.html` in a fresh session of a scratch repository, read in bb's headless browser; on Claude Code, `claude-code-inhost` |
| E2 a page read over bb Connect | `run --connect` → `connect-probe` |
| E3 WebKit, iPhone Safari | the owner's device check, when a round changes a page surface |
| E4 host limits, fresh session | `run --limits` → `fragment-check` |
| E5 host and CLI versions | `run --versions` |
| E6 permission modes | `run --modes`: the fixture with its session in auto mode |
| E7 a fresh agent on the contract | `run-scenarios`, graded per packet by a fresh subagent briefed with `scenarios/GRADER.md`; `run --scenarios --spec <spec> --log <log>` reads the result |
| E8 install over the previous release | `run --upgrade`: the path; run only on a bb made for it |

`python3 verify/run --all --code . --spec <spec folder> --log <scenario log> --write <VERIFY.md>` runs every cell it
can. Scratch repositories are `scratch.py`'s (`scratch-sbp-…`, private, deleted when their run ends, also when it
fails); `python3 verify/scratch.py list` shows any an interrupted run left, and `delete` removes one.

## Scenarios

`scenarios/NN-*.md` are briefs with their rubric (must, should, red flags), run on fresh agents in a neutral scratch
project: `run-scenarios start <run-id> --code . --spec <spec folder>` makes the repository and project, starts one
session per brief in a fresh checkout (the brief verbatim, nothing added) and packs each session; one fresh grader
subagent per packet, briefed with `scenarios/GRADER.md` and the packet's path only, writes `grade.md`;
`run-scenarios log <out> --log <scenario log>` appends the counts with the plugin version and the contract hash (the
spec's `*.md`, `src/text/fragment.ts`, `src/text/guide.ts`); `run-scenarios cleanup <out>` deletes the scratch. Run
them whenever a contract file changes. Nothing messages a scenario session: a coached session proves nothing.

## A release

| Step | Tool |
| --- | --- |
| before the tag | `release-guard --version <v> --code .`: refuses a version `origin/main` ever carried with another Claude Code bundle |
| after the tag is pushed | `marketplace-pin --version <v> --code .` (first with `--dry-run`): pins syns-pages in `synsdev/syns-claude-plugins` to the release commit |
| after `bb plugin update syns` | `served-check --code .`: the page script bb serves is the release's |
| on Claude Code | `claude-code-check --version <v> --code .`: installed, running and freshly installed bundles are the release's; then `claude-code-inhost --version <v> --code .`: the fixture and a scoped-diff probe in the owner's own pinned tab (`start` makes its session once) |
| on bb | `run --fixtures --limits --code .` |

## By hand

`tool.html` (a loader with a scope from the URL), `sharing.html`, `round6.html` and `round61.html` are live checks
of the sharing, people and visibility methods, every step a button: each file's first comment says how to place it,
always in a throwaway repository. The dirty-checkout rows of `fixture.html` (A29) need an unpublished edit made
from outside the page: append a line to a file, press *Run the dirty-checkout rows*, then restore the file.

## Tests

`test-verify`, `test-release-tools` and `test-claude-code-inhost` are offline: stand-in `syns` and `bb`, synthetic
git repositories on local paths, a page reporter run in node. `syspath.py` hides the system's real `syns`, `bb`,
`claude`, `gh`, `docker` and network programs from the tools under test. The `ci` workflow runs them, after the
plugin's own typecheck and tests, on every push and pull request.

```sh
for t in verify/test-*; do python3 -B "$t" || exit 1; done
```
