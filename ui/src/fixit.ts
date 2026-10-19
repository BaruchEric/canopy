/** The moves an agent can carry through when one fails, each with the
 *  words for it in the prompt. Moves left out are not an agent's to fix:
 *  opening an app, a commit message the agent CLI could not write, seeding
 *  secrets, starring or archiving a card. */
const DOING = {
  pull: "pull",
  push: "push",
  commit: "commit",
  "commit+push": "commit and push",
  stage: "stage a file",
  "peer sync": "peer sync",
  take: "take a peer's uncommitted work",
  track: "track a peer's branch",
  "spec sync": "spec sync (canopy spec sync)",
} as const;

export type FixMove = keyof typeof DOING;

/** a move whose failure goes to the agent, or null when it is not one */
export const fixMove = (label: string): FixMove | null => (Object.hasOwn(DOING, label) ? (label as FixMove) : null);

/** how much of git's answer the prompt quotes, from its end */
const FIX_LINES = 40;

/** What "fix with the agent" says to the repo's chat: the move pressed,
 *  what came back, and the go-ahead to finish it. Pressing push was the
 *  go-ahead to push; a plain commit's says nothing about pushing. Work in
 *  the way is kept unless the user says otherwise. */
export function fixPrompt(move: FixMove, output: string): string {
  const doing = DOING[move];
  const tail = output.trim().split("\n").slice(-FIX_LINES).join("\n");
  return [
    `I pressed ${doing} in canopy and it failed:`,
    "",
    tail,
    "",
    `Find the cause, fix it, then finish the ${doing}.${move === "commit" ? " Do not push." : ""}`,
    "Keep my commits and changes. A commit whose change is already upstream needs no copy: say so and let it go. Ask before anything else that throws work away (reset --hard, a force push, dropping a stash).",
  ].join("\n");
}
