import { LIMITS } from "../../src/core/secretwire";

/** why "make a key" cannot go ahead yet, or null when it can; the server holds the same floor */
export function newKeyProblem(pass: string, again: string): string | null {
  if (pass.length < LIMITS.passphrase) return `the passphrase has ${pass.length} characters; it needs ${LIMITS.passphrase} or more`;
  if (pass !== again) return "the two passphrases differ";
  return null;
}
