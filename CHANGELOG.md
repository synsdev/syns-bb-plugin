# Changelog

## 0.6.0 (candidate, not released)

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
  the session's folder becomes `.`, a home folder `~`, anything else
  absolute `<path>`. The plugin's log keeps them.
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
