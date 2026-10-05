import { REASONS } from "./errors.js";
import { reasonsOf, type Method, type Schema } from "./method.js";
import { FRAGMENT } from "./text/fragment.js";
import { buildGuide } from "./text/guide.js";

/** The plugin's version, as declared to the host. A test holds it equal to package.json's. */
export const VERSION = "0.5.0-spike.6";

export interface DeclaredMethod {
  name: string;
  description: string;
  effect: "read" | "contributed-write";
  params: Schema;
  result: Schema;
  maxRequestBytes: number;
  maxResponseBytes: number;
  reasons: Record<string, { description: string; detail?: Schema }>;
}

export interface Declaration {
  version: string;
  methods: DeclaredMethod[];
  instruction?: string;
  guide: string;
}

/** threadPagesContributions, generated from the table. With `agentInstructions` off no fragment is declared (S4.5). */
export function buildDeclaration(table: readonly Method[], settings: { agentInstructions: boolean }): Declaration {
  return {
    version: VERSION,
    methods: table.map((method) => ({
      name: method.name,
      description: method.description,
      effect: method.effect,
      params: method.params,
      result: method.result,
      maxRequestBytes: method.maxRequestBytes,
      maxResponseBytes: method.maxResponseBytes,
      reasons: Object.fromEntries(
        reasonsOf(method).map((reason) => {
          const entry: { meaning: string; detail?: Schema } = REASONS[reason];
          return [reason, { description: entry.meaning, ...(entry.detail ? { detail: entry.detail } : {}) }];
        }),
      ),
    })),
    ...(settings.agentInstructions ? { instruction: FRAGMENT.trim() } : {}),
    guide: buildGuide(table),
  };
}
