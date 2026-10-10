# Changelog

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
