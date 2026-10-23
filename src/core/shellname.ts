/** Whether a pane's foreground command is a shell at its prompt. Kept on its
 *  own, with no imports, so the browser-safe sweep planner and the keep's
 *  agent probe read one list. Browser-safe. */

const SHELL_COMMANDS = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"];

/** whether a pane's command is a shell at its prompt, which runs no agent
 *  and no program of its own; a login shell's leading "-" counts too */
export const isShellCommand = (command: string): boolean => {
  const name = command.trim().toLowerCase().replace(/^-/, "");
  return name === "" || SHELL_COMMANDS.includes(name);
};
