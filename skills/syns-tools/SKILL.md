---
name: syns-tools
description: "When the person asks for a piece of work they will go on working in (a board, deck, document, sheet, plan, brainstorm), find a Syns app template, place it as a folder, and make its app the page. Not when a page only reports on other work, and not in a review, helper or coding session given another job."
---

# A tool first

When the person asks for a piece of work whose result they will go on working
in, such as a board, a deck, a document, a sheet, a plan or a brainstorm, they
get a tool for it: a Syns app template placed as a folder, with its app as the
page. The page code is copied byte for byte and never edited. Ask the person
nothing before the tool is up. There is no install and no merge step.

**This does not apply** when the page is where you report on other work, or in
a review, helper or coding session that was given a different job. It does not
apply either when `bb thread-page init` says SKIP. Write the page as the
Thread Pages guide says.

**`syns` runs outside the sandbox.** Every `syns` command talks to syns.dev
itself and does not go through a sandbox's network proxy. Inside a command
sandbox it answers `could not reach server` even with the domain allowed. Run
each `syns` command outside the sandbox, and say why: the person asked for this
tool, and it lives in their Syns account.

## 1. Find a template

With `syns --version` at 0.3.6 or later:

```sh
syns explore -t syns-app -q "<two or three words of the task>" --json
```

An older CLI ignores `-t` and `-q` (Syns issue 207). There, list every row,
page by page, and filter them yourself. Raise `--offset` by 100 until it
reaches the answer's `total`:

```sh
syns explore --json --limit 100 --offset 0 | jq -r '.total, (.data[] | select(.owner == "bartsoj" and (.tags | index("syns-app"))) | "\(.owner)/\(.name)\t\(.description)")'
```

Use only `bartsoj/` templates for now.

## 2. Pick one

Take the template whose description fits the task best. If none fits, stop
here and write the page as the Thread Pages guide says.

## 3. Place it

Run `syns repo --json` in the session's folder.

- **It answers a repository** (the folder is a Syns repository, or a folder
  placed in one, which has a `holder`):

  First, `syns place --help`. If the CLI answers `unrecognized subcommand
  'place'`, the CLI is too old. Say so in one line on the page and write the
  page as today. Never copy a template's files by hand: its `.syns.yaml` would
  take over the folder. Otherwise:

  ```sh
  syns place <owner/name> <folder>
  ```

  Run it in the session's folder, or inside a placed folder, where it places
  relative to that folder. `<folder>` is a new folder, counted from there,
  named for the task and standing where the work belongs, such as
  `clients/vela/q3-board`. Placing publishes one version and writes the files
  to disk.

  If it refuses:
  - **`… already holds …`**: the folder is taken. Choose another name.
  - **`not_found: … is no repository you can read`**: pick another template.
  - **A template holding a `.syns.yaml` below its root**: pick another
    template.
  - **`folder_write_unsupported`**: the Syns server is too old for this. Say
    so in one line, and write the page as today.

  **Turn on the template's checks.** Placing records the checks the template
  declares under `template:` in the folder's `.syns.yaml`, where they are off.
  With `--json`, its `checks` lists them, and `enableChecks` is the one command
  that turns them on (`null` when there are none):

  ```sh
  syns enable-checks <folder>
  ```

  For a `bartsoj/` template, run it without asking. For any other template,
  show the person the checks and that command, and run it only after they say
  yes. Until then the checks stay off.

- **It answers `cannot determine repo identity`** (not a Syns repository):
  fork the template into a new private repository. This needs no
  `syns place`, so it works with any CLI. Do every step in this order:

  1. Fork from an empty folder:
     `tmp="$(mktemp -d)" && (cd "$tmp" && syns fork <owner/name> --name <name> --json); rm -rf "$tmp"`.
     `<you>` is the `owner` of the fork it answers.
  2. Pull it into a folder that does not exist yet:
     `syns pull <you>/<name> ~/.syns/<name>`. That is outside this session's
     folder, on purpose: the person's Syns repositories live under `~/.syns/`.
  3. **Check its identity before any other `syns` command there.** A checkout
     of a fork receives the template's `.syns.yaml` (Syns issue 161), so every
     command would address the template. Read `~/.syns/<name>/.syns.yaml`. If
     `owner` and `name` are not `<you>` and `<name>`, correct those two lines.
     Then run `cd ~/.syns/<name> && syns status`. It must name `<you>/<name>`.
     If it names anything else, stop and say so on the page. If you corrected
     the file, publish it: `syns push -m "Name the fork in .syns.yaml"`.
  4. Only then make it private: `syns repo --visibility private`.

  The folder is `~/.syns/<name>`.

- **It answers anything else**: do not place and do not fork. Say in one
  line what the CLI answered, and write the page as today. Such answers
  include:
  - `not_found` (404), from a `.syns.yaml` naming a repository you cannot
    reach;
  - `authentication required`: you are logged out, and `syns login` is needed;
  - `folder out of place`: a placed folder that moved away from the path its
    `.syns.yaml` records. Moving it back is the person's call.

**`holder root required`** answers any command that changes the holding
repository (`fork`, `forks`, `repo --visibility` and the like) run inside a
placed folder. Never run those from inside a folder. If one is needed, it
belongs at the root of the holder's checkout.

## 4. Open it

A tool's session lives **in the holding repository's own bb project, with its
environment set to the tool's folder**. That keeps it under the repository in
bb's sidebar, and lets a page find it again. Find that project first:

1. The holder's checkout root. In a placed folder, `syns repo --json` there
   answers `path`, the folder's path from the holder's root: the root is the
   folder's absolute path with that `path` taken off its end. For a fork, the
   root is the fork's folder, `~/.syns/<name>`.
2. Its bb project on this machine: the project with a source at that root.

   ```sh
   bb project list --json | jq -r --arg root "<holder root>" '.[] | select(any(.sources[]; .path == $root)) | .id'
   ```

   Only when there is none, create one: `bb project create --name <name> --root
   <absolute folder> --json`, and use its id. A fork, a new repository, always
   gets one this way.

Then:

- **This session moves into the folder** only when all of these hold:
  - it was started for this piece of work, so its first task is this one and
    `bb thread-page init` says `NEW`;
  - its folder is a Syns repository;
  - `$BB_PROJECT_ID` is the holder's project.

  To move it:
  1. Make the template's loader the page, byte for byte:
     `cp <folder>/.page/loader.html <the page path init printed>`.
  2. Read `<folder>/AGENTS.md`. From here on it governs this session, ahead of
     the Thread Pages instruction to design a page of your own.
  3. Move the session into the folder: bb's `update_environment_directory`
     tool, with the folder's absolute path. It stays in its project. Then end
     the turn with the page's link alone.
- **In every other case, start a new top-level session** in the holder's
  project, in the folder. That means a session started for something else, one
  that already has a page, one in another project, and **every fork**: outside a
  Syns repository, never move the session. The person asked for this tool, and
  that is what lets you start a session for it.

  ```sh
  bb thread spawn --project <the holder's project> --environment <absolute folder> --title "<the task>" --prompt "Open this folder's app, following AGENTS.md."
  ```

  Give no parent: a child session gets no page. `bb thread wait <id>`, then
  link the new session from your own page as `@thread:<id>`.

## 5. Follow the folder's AGENTS.md

Every later turn in the folder follows `AGENTS.md`. The page sees only the
folder, with paths counted from it, and saves only under it.
