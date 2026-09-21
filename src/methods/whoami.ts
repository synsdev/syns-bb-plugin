import { buildArgs } from "../cli.js";
import { K64, nullable, object, type SimpleMethod } from "../method.js";

/** Every field the CLI's whoami reports, the e-mail address included (D14). */
const OPTIONAL = ["name", "email", "image", "bio", "company", "location", "pronouns", "timeZone", "createdAt", "updatedAt"] as const;

export const whoami: SimpleMethod = {
  name: "syns.whoami",
  description: "The Syns account logged in on this session's machine, every field the CLI reports. Any but id and username may be null.",
  effect: "read",
  params: object({}),
  result: {
    type: "object",
    properties: {
      id: { type: "string" },
      username: { type: "string" },
      emailVerified: nullable("boolean"),
      ...Object.fromEntries(OPTIONAL.map((key) => [key, nullable("string")])),
    },
    required: ["id", "username", "emailVerified", ...OPTIONAL],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  reasons: ["not_logged_in"],
  command: () => ({ args: buildArgs("whoami") }),
  shape: (out) => ({
    id: out.id,
    username: out.username,
    emailVerified: out.emailVerified ?? null,
    ...Object.fromEntries(OPTIONAL.map((key) => [key, out[key] ?? null])),
  }),
};
