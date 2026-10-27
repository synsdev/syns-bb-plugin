# Changelog

## 0.10.2

The page script and the guide's *Apps in the workspace* changed; no method, result, reason or fragment changed.

- **The agent's page inside the workspace.** When the workspace shows the agent's own page, every call the page makes
  reaches the host as it does when the page is shown as written: `session.usage`, `sessions.*`, `pages.answer`, the
  sharing and people methods, `syns.place`, `syns.explore`, `syns.users` and `syns.enableChecks` no longer answer
  `unavailable`. Its stored values (`storage.*`) use the same keys in both views, so a value saved in one is found in
  the other; values the page saved inside the workspace under 0.10.0 or 0.10.1 are no longer found. Apps keep their
  own storage.
- **An app calls what a Thread Page calls.** Every call an app makes reaches the host as on a Thread Page, which
  confirms or grants each as it does there: `sessions.send`, `sessions.stop`, `sessions.archive`, `session.usage`,
  `pages.answer`, voice, `workspaces.create` and any method another plugin adds no longer answer `unavailable`. An
  app's `syns.*` still count from its folder; of the methods acting on the whole repository it may call
  `syns.explore` and `syns.users`, which now take a scope and ignore it, and the others answer `bad_scope`.

## 0.10.1

The fragment is a new text; no method, result, reason, guide text or page script changed.

- **The page every turn.** The fragment says the page the agent writes every turn opens inside the workspace, and
  that the page reports and asks while the app does the work. It no longer says there is nothing to add to the page.
- **Signing in when a push asks for it.** When `syns push` asks for `syns login`, the agent runs it in the
  background, gives the person the link it prints, and pushes again once it says `Login successful`.
- **The guide's section by name.** Apps point at the guide's *Apps in the workspace*, where they pointed at its
  *syns* section.
- **The look.** The design and layout of the agent's page and every app fit their content and the workspace's design.

## 0.10.0

The page opens inside the repository's workspace, with nothing for the agent to add; an app's folder is a hard
boundary; files and folders move and copy as one version; `syns.diff`, `syns.history` and `syns.revert` follow the
Syns CLI 0.3.25 (the design tree's D84 to D89). Needs Thread Pages 1.11.0 or Unife Pages 0.3.0, and the Syns CLI
0.3.25.

- **A page script.** The declaration says `pageScript: true`, and the plugin answers each served page
  (`threadPagesPageScript` on bb, `kind: "pageScript"` on Claude Code): the page host, at the plugin's version, when
  one `syns repo --json` in the session's folder succeeds (a repository, or a folder placed in one); none otherwise, or
  when the check takes over 1.5 s. The host gets only the version when it already holds that script. The page host is
  `bartsoj/syns-workspace-light-template`'s `.page/pagehost.js` (version 3), now the plugin's, without the two strings
  an inline script cannot carry.
- **The page as written when there is no workspace.** In a Syns repository with no `.page/index.html`, or a folder
  that is no repository yet, the bootstrap puts the page back and runs its scripts, where it said "no app to load".
  It leaves the kernel's and every contributor's page script alone, and strips them from a page it shows in a frame.
  The `data-app` attribute is gone: the workspace is always `.page/index.html`.
- **Saving the page no longer reboots the workspace** (B-0065). Once the workspace is shown, the bootstrap takes a
  saved page through `threadPage.onPageUpdate` where the host offers it (Thread Pages 1.11.0, Unife Pages 0.3.0):
  `SynsPages.page` becomes the new page and only the frames showing it reload, typed text and scroll kept; the
  workspace, its tree and an open app stay. `SynsPages.showPage(page)` does the same for any app around the page.
- **The fragment** is the Syns workspace text: when the page opens in the workspace, the two commands before a first
  page, and that an app is a folder holding an `index.html`. The *Tool first* line and its `bartsoj/syns-templates`
  pointer are gone, and so are the folder, pushed-state, `base`, loading and sharing rules and the setup pointer: the
  guide holds the rules.
- **The guide says what an app is** (B-0067): a new section *Apps in the workspace* (a folder holding an
  `index.html`, its sandboxed frame and own `threadPage`, paths from its folder, its own storage, forms, reloads on
  another's change, what it may call), and *Loading a wiki* is *Loading files*.
- **An app's folder is a hard boundary** (B-0068, the design tree's D85). Every `syns.*` method takes `scope`, a folder
  of the repository: the call's paths count from it, its answer names nothing outside it (a commit of
  `syns.history` that touched no file there is dropped, with its author and message), and the host half refuses to
  start the CLI unless the folder resolves inside the session's, symlinks followed; no `.syns.yaml` is needed. The
  methods acting on the whole repository, its people or Syns (`syns.place`, `syns.explore`, sharing and people)
  answer `bad_scope` to any. The page host passes an app's folder as `scope` and no longer rewrites its paths.
- **`syns.move` and `syns.copy`** (B-0062, the design tree's D86): a file or folder moved or copied as one version
  against `base`, adapting `syns mv` and `syns cp` (Syns roadmap 228): one CLI run, paths only on the wire, whatever
  the folder's size; a move keeps the file's history. They answer `{ version, number, from, to, files }` and refuse
  with `stale_head`, `checkout_dirty`, `exists` (the destination stands at `base`) and `not_found` (no source).
  **Minimum CLI 0.3.25.** In the guide a bare `base`, `number` and `message` key has its usual type, and methods
  reading alike share a line.
- **`syns.diff` names a move's old path** (B-0069, the design tree's D87): a `renamed` entry carries `oldPath`, as
  CLI 0.3.25 answers a recorded move. Under a `scope`, a move across the folder's edge reads as an addition (moved in)
  or a deletion at the old path (moved out), with no patch.
- **`syns.history` pages** (B-0070, the design tree's D88): `offset` skips that many versions, newest first, as
  CLI 0.3.25's `syns history --offset`; the next page is `offset + limit`. Under a `scope` it counts the repository's
  versions, as `total` does.
- **`syns.revert` is a write like the others** (B-0071, the design tree's D89): it takes `base`, passed as
  CLI 0.3.25's `syns revert --parent`, and publishes under the plugin's provenance, so `syns.history` names the page.
  It refuses with `stale_head` and `checkout_dirty`, restores a picture as well as a text, and sends no content. The
  guide's exceptions for it are gone.

## 0.9.1

The plugin's design moved: its specification, decisions, host facts and live verification now live in the Syns
repository `bartsoj/syns`, under `products/syns-plugins/pages/`, and the plugin is released from there (Syns roadmap
294). The README's Design section says so. No method, result, reason, fragment or guide text changed: a page or a
session sees what 0.9.0 gave it.

## 0.9.0

One CLI run per page call, on both hosts, on the latest CLI only (Syns roadmap 280; `bartsoj/syns` D-244, Q-0155;
the plugin's design tree D83). Bb and Claude Code answer every call alike; the plugin stays an adapter of the CLI.

- **Minimum CLI.** One minimum for every method: the Syns CLI, 0.3.24 or later (it carries
  Syns roadmaps 277–279). No `syns --version` is run and no method declares a minimum: `cli_too_old` is gone. An
  older CLI's refusal comes back as `handler_error` in its own words, so `syns.readMany` and every scoped call fail
  on 0.3.23 and earlier with the CLI's `error: unexpected argument …` line. Upgrade with `syns upgrade`.
- **`syns.readMany` is one run:** `syns cat --json --paths-from=- --max-bytes=<room left in the 1 MiB answer>`, at
  the given `version` or the head the CLI resolves in the same run. No `repo` run first, no run per path, and paths
  that do not fit are not fetched. Same params and result shape.
  - A first path that alone passes the answer's room is `too_large` with no `size` or `blob`, a picture included
    (0.8.7 gave `too_large` or `not_text` with both), and the paths after it are deferred. A text the CLI served
    whose escaped JSON alone passes the room is still `too_large` with both.
  - Any per-file error but a missing path fails the call as `handler_error` in the CLI's words, as before.
  - An empty repository, read without `version`, answers `handler_error` with the CLI's words (`server error (422):
    validation_error`); 0.8.7 answered `not_found`. Read `syns.repo` first: its `version` is `null` there.
- **A scoped call's check is one run:** `syns repo --json --within=<session folder>` in the scope, still held a
  minute; `within: false` is `bad_scope`. A scoped `syns.repo` answers from that run: one run.
- **`syns.ls` takes `format: "lines"`:** each entry one string, `path\tblob\tsize`, a folder's blob and size empty,
  up to 9,000 a page and inside the 1 MiB answer. Without it the answer is 0.8.7's, byte for byte, and `limit` stays
  at most 1,500.
- **The 25 s limit stops the call's run** on both hosts: the host call's signal on bb, the call's signal on Claude
  Code. A run still waiting for a slot leaves the queue.
- **`SYNS_CALLER`** names the host in every request's User-Agent: `syns/<v> (bb-plugin)` on bb, `syns/<v>
  (claude-pages)` on Claude Code.
- **bb holds its host worker** until 15 minutes after the last run, so the next call finds it warm.
- A refusal with nothing on standard output and an `error:` line on standard error (the CLI's own argument parser)
  now reaches the page in those words, redacted, rather than the generic sentence.

## 0.8.7

- `syns.grep` pages past its 400-file fan-out (Syns issue 260, D-156). It takes `offset`, the count of matching
  files to skip in path order (0 to 4,294,967,295, the CLI's bound), and answers `nextOffset`: where to continue, or
  `null` on the last window, past the end, or where `headLimit` closed the search early. Following `nextOffset` from
  0 searches every file once, at one version: an `offset` above 0 without `version` is `invalid_params`, as on
  `syns.readBinary`, so pass the first page's `version` with each later page. The description states the cap.
  `offset` above 0 needs Syns CLI 0.3.20 (`--offset`); an older CLI answers `unavailable` / `cli_too_old`. Without
  `offset` every CLI serves the call, and `nextOffset` is `null` where the CLI names none.

## 0.8.6

- Signed out of Syns, every method answers `unavailable` / `not_logged_in`, not `no_access`, so a page can tell the
  reader to run `syns login`. The CLI prints the same 404 for a signed-out machine as for a repository out of reach;
  when the plugin's check of the repository fails too, it now asks `whoami` once to tell them apart. Only on that
  failure: a successful call runs no extra process. `syns.repo` no longer runs `repo` twice on a 404.
- A scoped call on a signed-out machine answers `not_logged_in` instead of `bad_scope`.

## 0.8.5

- The instruction says one rule on `base`, as the guide does: the `version` last read, which `syns.repo`, `syns.ls`
  and `syns.readMany` each answer, and each write answers the next. It said "from `syns.repo`", narrower than what
  is true; a `base` taken from `syns.readMany` was always guarded.

## 0.8.4

- The guide text is 14,930 bytes, 942 under its 15,872 limit (was 6): room for about three more methods. Each method
  is one line, its params → its result, and the error reasons are grouped under their code. Nothing it said is gone.
- Claude Code: registering with the Unife Pages daemon no longer fails with EPIPE at some declaration sizes (about
  one size in four on Node 26.7, macOS; 0.8.4's guide made the declaration one). Each control request now says
  keep-alive and closes its own connection once the answer is read.

## 0.8.3

- The instruction's first line also covers "open this Syns template": the agent follows TOOLS.md, so the
  person gets their own copy with the app as the page, instead of a pull of the template itself.

- Docs: on bb the host is Thread Pages 1.10.0 or later (the Unife Pages host under its bb name); on Claude Code the
  Syns marketplace installs everything in one command. PLUGIN_OVERVIEW.md updated for the BB Community listing.

## 0.8.2

- Claude Code: `syns-pages` declares its dependency on `unife-pages`, so installing it (or the `syns` bundle from
  the Syns marketplace) brings Unife Pages along.

## 0.8.1

- Claude Code: the process no longer re-registers every 10–15 seconds. It
  polled the daemon over a reused keep-alive connection whose idle timer
  fired as the next poll began; each request now opens its own connection.

## 0.8.0

Claude Code, and one call shape on both hosts.

- **Claude Code.** `hosts/claude` is a Claude Code plugin, `syns-pages`.
  Its `unife-pages.json` names `bin/syns-pages.js`, a self-contained bundle
  of the same table and dispatch. The Unife Pages daemon starts it and
  supervises it (unife-pages U45). The CLI runs on this machine.
- **The session's folder comes with the call** (`caller.workspace`,
  unife-pages U44), on both hosts. The plugin no longer asks bb's SDK for
  it; it needs a host that sends it (bb-pages and claude-pages with U44).
- **Provenance is host-neutral:** a page's write records `by.integration`
  `syns-pages` and `by.trigger` `page`. Before, they were `syns-bb-plugin`
  and `thread-page`; a page that reads them changes with this release.

## 0.7.0

The same declaration on every Unife Pages host (07 R-X1). No method changed.

- The fragment names no host's command: "Every method: the page guide
  (its command is in your page instruction's *More*), section
  *Capabilities from contributors*." The guide says "the session whose
  page made it" and names `threadPage.setScope` where it explains a scope.
- The fragment is held to the protocol's 2,048 bytes; the 1,200-character
  cap of the one-slot era is gone. The live check reads the fragment's slot
  from `bb pages status`.
- The tests run the declaration through the protocol's own validator and
  bb-pages' discovery, and diff it against a frozen copy.
- `src/syns-process.ts` holds finding and running the CLI, apart from bb's
  host entry, so another host's runner can use it.

## 0.6.1

Text and one error message, for Syns CLI 0.3.14 (D-124), which lets a shared
placed folder manage its own people. No method changed.

- From a placed folder's page, `syns.collaborators`, `syns.collaboratorAdd`,
  `syns.collaboratorRole` and `syns.collaboratorRemove` act on the folder's
  own people, on CLI 0.3.14 and later, once the folder is shared.
- In a placed folder not yet shared, they answer `bad_scope` with the sentence
  "This folder is not shared yet: share it first, then add people to it. If
  it was just shared, try again after the next sync." On
  older CLIs they answer `bad_scope` there, as before.
- The guide, the README and the methods' descriptions say so, and that people
  added at a repository's root reach the whole repository.

## 0.6.0

The page surface as a whole: a page acts on its own scope, its placed folder or
its repository, and on that repository's people. Each new method is one Syns
CLI command run in the page's scope, with the CLI's answer and its refusals
passed on.

- **Sharing a placed folder:** `syns.shareInfo`, `syns.share { name? }`,
  `syns.unshare` (CLI 0.3.11), and `syns.folderVisibility { visibility, name? }`
  (CLI 0.3.12).
- **A repository's visibility, from its root:** `syns.repoVisibility
  { visibility }`.
- **The repository's people:** `syns.collaborators { limit?, offset? }`,
  `syns.collaboratorAdd { user, role }`, `syns.collaboratorRole { id, role }`,
  `syns.collaboratorRemove { id }`. Roles are the CLI's: `admin`, `write`,
  `read`.
- **`syns.enableChecks`** turns on a placed folder's recorded checks, with the
  page's provenance (CLI 0.3.6).
- **`syns.explore`** and **`syns.users`** search public repositories and people.
- `syns.repo` passes on `sharedFolder`.
- Where the CLI does not act in a scope (a folder's command at a root, a
  holder's in a placed folder), the answer is `bad_scope`.
- A refusal the plugin has no reason for now carries the CLI's own words as its
  `message`.
- New reasons: `bad_name`, `name_taken`, `not_permitted`, `no_such_user`,
  `already_collaborator`.
- Local paths in the CLI's own words are redacted before a page sees them:
  the session's folder becomes `.`, and every other absolute path `<path>`,
  POSIX or Windows (drive letters, `\\?\`, UNC), `file://` URLs and quoted
  paths with spaces included. The plugin's log keeps them.
- `syns.collaboratorRole` and `syns.collaboratorRemove` refuse an `id` of `.`
  or `..`, or one holding `/` or `\`: the CLI's HTTP client would collapse it
  onto the repository's own route.
- `syns.explore` needs CLI 0.3.6; older ones ignore its filters.
- A 403 is reported neutrally (a role too low, or a server limit), and a
  `not_found` from the new methods names no path or version.
- The guide no longer repeats the effect, bounds and reasons the host prints
  for each method. It gains *Sharing and people*: shares only from an explicit
  control, saying who gets what, with public labelled apart.

## 0.5.0

Needs Thread Pages 1.8.0 for a document's scope. Everything else works as
before on older Thread Pages.

- **A document's scope.** A Thread Pages document can scope its calls with
  `threadPage.setScope(folder)`. Every `syns.*` call from it then runs in that
  folder and answers for it alone, as if it were the repository, with paths
  counted from it.
  - The folder must be a placed folder of the session's own repository: it
    holds its own `.syns.yaml`, and that file names the session's repository as
    its holder.
  - It must resolve, symlinks followed, inside the session's folder.
  - Anything else is `invalid_params` / `bad_scope`: a plain folder, a folder
    below a placed one, another repository's checkout, a symlink out, a scope
    of an unexpected type, or any scope of a session whose folder is no Syns
    repository.
  - The CLI starts in the resolved folder.
  - With no scope, nothing changes.
- **`syns.place { template, path, version? }`** places a template as a new
  folder of the session's repository. It always runs at the session's folder,
  whatever the scope.
  - It records the page's provenance (integration `syns-bb-plugin`, the
    session as run, trigger `thread-page`).
  - It answers `checkout_dirty` while the checkout holds unpublished edits,
    which the CLI's `place` does not refuse; `occupied` when the folder already
    holds files; and `no_such_template`.
  - It needs Syns CLI 0.3.6.
- **A minimum CLI per method.** An older CLI answers `unavailable` /
  `cli_too_old`, with what is needed and what is there.
- **No skills.** The plugin ships none. The instruction fragment holds the
  `syns.*` essentials, one line on looking for a template first, and where the
  setup doc is: `syns cat SETUP.md --repo bartsoj/syns-bb-plugin-setup`.
- The guide no longer repeats each method's description, which Thread Pages
  prints in its roster.

## 0.3.2

- The network rule for Syns CLI 0.3.8, which works inside bb's sandbox: `syns`
  runs inside it; a failed command is retried once after `syns upgrade`.

## 0.3.1

- The guide says what marks a page's own write: `by.integration`
  `syns-bb-plugin` together with `by.trigger` `thread-page`. `by.run` is not
  enough on its own, because agents' pushes set it too.

## 0.3.0

- A tool first: agents were told to place a Syns app template as a folder
  rather than write a page from scratch. Replaced in 0.5.0 by the fragment's
  one line and the templates' own `TOOLS.md`.
- `syns.repo` passes on `holder`, `path` and `number` (and, in 0.5.0, from the
  CLI that reports them).
- Two folder refusals became reasons: `folder_out_of_place` and
  `folder_write_unsupported`.

## 0.2.2

- `syns.repo` passes on a placed folder's `holder`, `path` and `number`.
- The instruction fragment fits whole in bb's 4,096-character instruction cut.
- The guide's wording covers placed folders.

## 0.2.1

- `syns.read` trims a window only when asked, with `fit: true`.

## 0.2.0

- Pictures: `syns.readBinary` and `syns.writeBinary`, in 720 KiB pieces, and
  bytes inside `syns.commit`.

## 0.1.1

- Fixes from the first template builds: `syns.edit` with `old` equal to `new`
  changes nothing, sizes on `readMany`'s errors, and `history` capped at 100.

## 0.1.0

- Fourteen `syns.*` capabilities for bb Thread Pages, run through the Syns CLI
  on the session's machine.
