import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/declaration.js";
import { FRAGMENT } from "../src/text/fragment.js";

/**
 * On bb the fragments ride in their own instruction slot (`contributeInstructions`), which bb cuts at its cap
 * (4,096 characters today), each fragment under `## <id> <version>`, joined in registration order (07 R6.29, U35).
 * What is left for this fragment is the cap less what other contributors' fragments take before it. `bb pages
 * status` prints each fragment's placement; this test reads it from the bb on this machine, where there is one with
 * bb-pages, and measures this code's fragment against it. The protocol's own 2,048-byte cap is held in
 * declaration.test.ts on every machine. Without a bb (or with SYNS_SKIP_BB=1) this test is skipped.
 */
/** Room the fragment must keep below the cut, so that a small edit before it is noticed here first. */
const MARGIN = 50;
const HEADING = `## syns ${VERSION}\n\n`;
const PLACEMENT = /^fragment (\S+)(?: \S+)? → slot "([^"]+)": (\d+) characters of (\d+), /;

interface Placement { id: string; slot: string; chars: number; cap: number }

/** The fragment placements a new session gets, or null when there is no bb-pages to ask. */
function livePlacements(): Placement[] | null {
  if (process.env.SYNS_SKIP_BB === "1") return null;
  let out: string;
  try {
    out = execFileSync("bb", ["pages", "status"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // no bb, or no bb-pages on it
  }
  return out.split("\n").flatMap((line) => {
    const m = PLACEMENT.exec(line);
    return m ? [{ id: m[1]!, slot: m[2]!, chars: Number(m[3]), cap: Number(m[4]) }] : [];
  });
}

const placements = livePlacements();

describe.skipIf(placements === null)("the fragment against this machine's bb-pages slot (U35, S4.6)", () => {
  it("bb pages status prints the syns fragment's placement where this test looks for it", () => {
    expect(placements!.some((p) => p.id === "syns"), "no line 'fragment syns … → slot …: N characters of CAP' in bb pages status").toBe(true);
  });

  it("fits whole below bb's cut, with room to spare, after the fragments placed before it in its slot", () => {
    const at = placements!.findIndex((p) => p.id === "syns");
    if (at < 0) return;
    const ours = placements![at]!;
    // Fragments in one slot are joined with a blank line between them.
    const before = placements!.slice(0, at).filter((p) => p.slot === ours.slot).reduce((sum, p) => sum + p.chars + 2, 0);
    const space = ours.cap - before;
    expect(HEADING.length + FRAGMENT.trim().length + MARGIN, `${space} characters are left for the fragment and its heading`).toBeLessThanOrEqual(space);
  });
});
