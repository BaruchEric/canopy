// Pure, so scenario.ts and the UI can import it without pulling in node.

/** A gate or scenario name: letters, digits, dots, dashes and underscores, at most 40 characters. */
export const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
