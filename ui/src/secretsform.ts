/** why "make a key" cannot go ahead yet, or null when it can; the server holds the same 12-character floor */
export function newKeyProblem(pass: string, again: string): string | null {
  if (pass.length < 12) return `the passphrase has ${pass.length} characters; it needs 12 or more`;
  if (pass !== again) return "the two passphrases differ";
  return null;
}
