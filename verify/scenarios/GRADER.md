# The scenario grader: what it reads and writes

The calling agent of `verify/run-scenarios` starts one fresh subagent per packet, briefed with this file and the
packet's path and nothing else, and limited to read, glob and write tools (no shell, no messages), so a grade does not depend on who dispatched it.
Grades are comparable only for the same product version and contract hash; the record says both.

## The brief

Grade one scenario run from its packet folder, following this file: read the rubric, the chat, the actions, the page
and its renders, then judge each rubric item on the evidence alone. What the packet does not show is not met. Write
only `grade.md` in the packet, in the form below. Carry your recommendation: when a must fails, say what the contract
text would need to say. Never message the agent or its session and never change what it left.

## The packet
- `rubric.md`: the scenario file (brief, must, should, red flags).
- `chat.md`: what the agent said in chat, in order. `actions.md`: the commands it ran and the files it wrote.
- `page/`: the page as the agent saved it. `renders/`: the page at a wide and a narrow width, light and dark.
- `meta.json`: scenario, session, product version, contract hash.

## How to judge
- Every rubric item, plus the should every scenario carries: the page's shape fits its task (structure, look and
  interaction follow from this task, not from a template or a habitual layout).
- Met or not, with the evidence that decides it: a quote, a file and line, or a render. An item the packet cannot
  decide is not met; say what was missing. Never infer that the agent did something you cannot see.
- A must that is not met fails the scenario. Name a red flag only when the packet shows it.
- When `meta.json` shows an installed plugin version other than the version under test, say so in the first line
  after the item lines: the agent read another contract, so the grade says nothing about this release.

## `grade.md`, exactly
```
scenario  : <id>
must      : <met>/<total>
should    : <met>/<total>
red flags : <comma-separated short names, or none>
verdict   : pass | fail
```
Then one line per item: `- [x]` or `- [ ]`, the item's first words, `—`, the evidence. End with at most three lines
on what the standing instruction or the guide would need to say, when the agent missed something it should have
been told: that is your recommendation, and it is what the round acts on.
