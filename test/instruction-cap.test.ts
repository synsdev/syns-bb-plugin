import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FRAGMENT, FRAGMENT_MAX } from "../src/text/fragment.js";

/**
 * bb cuts a plugin's agent instructions at 4,096 characters, and Thread Pages
 * sends the fragments inside its own instruction (HOST_FACTS §13, D35). The
 * space left for this fragment is whatever stands before it, which another
 * plugin can change: the standing instruction, a setting, another
 * contributor's block. So it is read from the bb on this machine, where there
 * is one: `bb thread-page status` prints the instruction a new session gets.
 * Without a bb (or with SYNS_SKIP_BB=1) the test is skipped, and the live
 * check's L0 stands in for it.
 */
const CAP = 4096;
const HEADING = "## From syns\n\n";
/** Room the fragment must keep below the cut, so that a small edit before it is noticed here first. */
const MARGIN = 50;

/** The instruction a new session gets, or null when there is no bb to ask. Output from a bb that does not parse is a failure, not a skip. */
function liveInstruction(): string | null {
  if (process.env.SYNS_SKIP_BB === "1") return null;
  let out: string;
  try {
    out = execFileSync("bb", ["thread-page", "status"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // no bb, or no Thread Pages on it
  }
  const marker = "## Instruction a new eligible session receives now\n\n";
  const start = out.indexOf(marker);
  const end = out.indexOf("\n\n## This session", start);
  if (start < 0 || end < 0) return UNPARSED;
  return out.slice(start + marker.length, end);
}

const UNPARSED = "\u0000unparsed";

const instruction = liveInstruction();

it.skipIf(instruction === null)("bb's thread-page status, where there is a bb, prints the instruction where this test looks for it", () => {
  expect(instruction, "bb thread-page status no longer prints '## Instruction a new eligible session receives now' followed by '## This session'").not.toBe(UNPARSED);
});

describe.skipIf(instruction === null || instruction === UNPARSED || instruction.startsWith("(none"))("the fragment against this machine's Thread Pages instruction (D35, S4.6)", () => {
  it("fits whole below bb's cut, with room to spare, after everything that stands before it", () => {
    const text = instruction!;
    const ours = text.indexOf(HEADING);
    // With our block present, the fragment starts after its heading; without it, it would be appended.
    const before = ours >= 0 ? ours + HEADING.length : text.length + 2 + HEADING.length;
    const space = CAP - before;
    expect(FRAGMENT.trim().length + MARGIN, `${space} characters are left for the fragment`).toBeLessThanOrEqual(space);
    expect(FRAGMENT_MAX, `FRAGMENT_MAX should be at most what is left (${space})`).toBeLessThanOrEqual(space);
  });
});
