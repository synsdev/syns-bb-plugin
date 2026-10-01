---
name: syns-tools
description: "Before writing a Thread Page of your own for a task a Syns app could serve (a brainstorm, plan, deck, document, sheet, board, site, tracker), find a Syns app template, place it as a folder, and make its app the page. Use at the start of such a task."
---

# A tool first

Given a task, the person gets a tool for it: a Syns app template placed as a
folder, with its app as the page. The page code is copied byte for byte and
never edited. Ask the person nothing before the tool is up. There is no install
and no merge step. If `bb thread-page init` says SKIP, this session is a helper:
none of this applies.

## 1. Find a template

```sh
syns explore -t syns-app -q "<two or three words of the task>" --json
```

The CLI ignores `-t` and `-q` until the fix for Syns issue 207 is released. If
the answer holds rows without the `syns-app` tag, list them all and filter
yourself:

```sh
syns explore --json --limit 100 | jq -r '.data[] | select(.owner == "bartsoj" and (.tags | index("syns-app"))) | "\(.owner)/\(.name)\t\(.description)"'
```

Use only `bartsoj/` templates for now.

## 2. Pick one

Take the template whose description fits the task best. If none fits, stop
here and write the page as the Thread Pages guide says.

## 3. Place it

Run `syns repo --json` in the session's folder.

- **It answers** (the folder is a Syns repository, or a folder placed in one, which has a `holder`):

  ```sh
  syns place <owner/name> <folder>
  ```

  Run it in the session's folder. `<folder>` is a new folder, counted from
  there, named for the task and standing where the work belongs, such as
  `clients/vela/q3-board`. Placing publishes one version and writes the files
  to disk.

- **It answers `cannot determine repo identity`** (not a Syns repository): fork
  the template into a new private repository instead:

  ```sh
  tmp="$(mktemp -d)" && (cd "$tmp" && syns fork <owner/name> --name <name>); rm -rf "$tmp"
  syns pull <you>/<name> ~/.syns/<name>
  cd ~/.syns/<name> && syns repo --visibility private
  ```

  `<you>` is `syns whoami --json`'s `username`. If the fork's `.syns.yaml`
  does not name `<you>/<name>`, correct it, then
  `syns push -m "Name the fork in .syns.yaml"`. The folder is `~/.syns/<name>`.

## 4. Open it

Run `bb thread-page init`.

- **No page yet** (`NEW`): this session becomes the tool.
  1. Make the template's loader the page, byte for byte:
     `cp <folder>/.page/loader.html <the page path init printed>`.
  2. Read `<folder>/AGENTS.md`. From here on it governs this session, ahead of
     the Thread Pages instruction to design a page of your own.
  3. Move the session into the folder: bb's `update_environment_directory`
     tool, with the folder's absolute path. Then end the turn with the page's
     link alone.
- **The session already has its own page**: leave that page alone, and start a
  new top-level session in the folder:

  ```sh
  bb thread spawn --project "$BB_PROJECT_ID" --environment <absolute folder> --title "<the task>" --prompt "Open this folder's app, following AGENTS.md."
  ```

  For a fork, first `bb project create --name <name> --root ~/.syns/<name>`
  and pass that project's id. Give no parent: a child session gets no page.
  `bb thread wait <id>`, then link the new session from your own page as
  `@thread:<id>`.

## 5. Follow the folder's AGENTS.md

Every later turn in the folder follows `AGENTS.md`. The page sees only the
folder, with paths counted from it, and saves only under it.
