/**
 * Checks canopy runs in its own process, over files it reads through
 * readSeed: nothing a seed holds (a bunfig preload, a .env, a node_modules)
 * is loaded or run. A workflow names one as `check: @<name>`. Every other
 * check line is shell, which for a seed runs in the stages container.
 */
import type { CheckResult } from "./flow";
import { parseAdvice } from "./retro";
import { readSeed } from "./seed";
import { parsePick, parseQuestions, pickRefusal } from "./sprout";

/** any line starting with @ is a built-in; an unknown name is refused, never run as shell */
export const isBuiltinCheck = (command: string): boolean => command.startsWith("@");

const fail = (output: string): CheckResult => ({ exit: 1, output });

async function pickCheck(seed: string): Promise<CheckResult> {
  const text = await readSeed(seed, ".canopy/pick.json");
  if (text === null) return fail(".canopy/pick.json is missing: research ends by writing it");
  const parsed = parsePick(text);
  if (!parsed.ok) return fail(`.canopy/pick.json: ${parsed.error}`);
  const refused = pickRefusal(parsed.pick);
  if (refused) return fail(`.canopy/pick.json: ${refused}`);
  if ((await readSeed(seed, ".canopy/research.md")) === null) return fail(".canopy/research.md is missing: research writes it before the pick");
  return { exit: 0, output: `pick ok: ${parsed.pick.kind} on ${parsed.pick.host}` };
}

async function questionsCheck(seed: string): Promise<CheckResult> {
  const text = await readSeed(seed, ".canopy/questions.json");
  if (text === null) return { exit: 0, output: "no questions" };
  const parsed = parseQuestions(text);
  return parsed.ok ? { exit: 0, output: `${parsed.questions.length} questions` } : fail(`.canopy/questions.json: ${parsed.error}`);
}

/** the retro wrote its account, and advice canopy can read; nothing in it is applied */
async function adviceCheck(seed: string): Promise<CheckResult> {
  if ((await readSeed(seed, ".canopy/retro.md")) === null) return fail(".canopy/retro.md is missing: the retro writes it before its advice");
  const text = await readSeed(seed, ".canopy/advice.json");
  if (text === null) return fail(".canopy/advice.json is missing: write [] when there is no advice");
  const parsed = parseAdvice(text);
  if (!parsed.ok) return fail(`.canopy/advice.json: ${parsed.error}`);
  const n = parsed.advice.length;
  return { exit: 0, output: n === 0 ? "no advice" : `${n} ${n === 1 ? "piece" : "pieces"} of advice` };
}

const BUILTINS: Readonly<Record<string, (seed: string) => Promise<CheckResult>>> = {
  "pick-check": pickCheck,
  questions: questionsCheck,
  advice: adviceCheck,
};

export async function builtinCheck(command: string, seedPath: string): Promise<CheckResult> {
  const name = command.slice(1);
  const run = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
  if (!run) return { exit: 2, output: `no built-in check ${command}` };
  // an agent wrote these files: a symlink, a fifo or a huge file fails the check, never throws
  try {
    return await run(seedPath);
  } catch (e) {
    return fail(`${command}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
