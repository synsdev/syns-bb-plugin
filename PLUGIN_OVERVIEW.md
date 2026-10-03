# Syns

Give a bb Thread Page the Syns repository of its own session.

## What it does

[Thread Pages](https://github.com/unifedev/bb-thread-pages) gives every agent
session a web page. A page runs in a sandbox and can reach nothing on your
machine. This plugin adds twenty-nine `syns.*` capabilities to every page, so a page
built over a Syns repository — a wiki, a task board, a notebook — can list, read,
search and change that repository's files.

The page never names a repository. It sees the repository, or the placed
folder, its session's folder belongs to, with paths counted from there and
whatever access the Syns account logged in on that machine has. A placed folder
is a Syns app template copied into a repository as a tool: its page sees that
folder alone. In a folder that is no Syns repository, every call answers
`no_repo`.

The plugin also tells agents, in one line, to look for such a tool first. How
to place one is the templates' own public `TOOLS.md`, in
`bartsoj/syns-templates`; the plugin itself depends on no template structure.

## How it works

Each call becomes one run of the [Syns CLI](https://github.com/synsdev/syns-cli)
on the session's own machine, in the session's folder. The plugin opens no
repository file itself, holds no credential, and remembers nothing about a
repository between calls.

Every write carries the version the page last read. If the repository has moved,
the write is refused and the page re-reads; nothing is overwritten unseen. Every
commit a page makes records that a page made it, and which session's page.

Pages learn of changes by polling one cheap call, `syns.repo`, with Thread Pages'
`watch`.

## Getting started

Install [Thread Pages](https://github.com/unifedev/bb-thread-pages) 1.4.0 or
later, and the Syns CLI, logged in, on each machine whose sessions should reach
a repository. Then install this plugin. New sessions are told about `syns.*`
automatically; turn that off with
`bb plugin config syns set agentInstructions false`.
