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

function liveInstruction(): string | null {
  if (process.env.SYNS_SKIP_BB === "1") return null;
  try {
    const out = execFileSync("bb", ["thread-page", "status"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    const start = out.indexOf("## Instruction a new eligible session receives now\n\n");
    if (start < 0) return null;
    const body = out.slice(start).split("\n\n").slice(1).join("\n\n");
    const end = body.indexOf("\n\n## This session");
    return end < 0 ? body : body.slice(0, end);
  } catch {
    return null;
  }
}

const instruction = liveInstruction();

describe.skipIf(instruction === null || instruction.startsWith("(none"))("the fragment against this machine's Thread Pages instruction (D35, S4.6)", () => {
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
