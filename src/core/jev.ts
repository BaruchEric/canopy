/** The Jev classifier through the Vercel AI Gateway, asked the verdict
 *  questions. Ported from ~/dev/ai-tools/jev-lab. Bun-only. */

import { createGateway } from "@ai-sdk/gateway";
import { APICallError, experimental_evaluate as evaluate } from "ai";
import { JUDGE_QUESTIONS, VERDICT_QUESTIONS } from "./verdict";
import type { JudgeAnswers, JudgeFit, VerdictAnswers, VerdictOutcome } from "./types";

export const JEV_MODEL = "typesafe-ai/jev";
/** Jev answers in a few hundred ms; the gateway occasionally hangs, so each
 *  attempt is short and retried. */
const ATTEMPT_TIMEOUT_MS = 6000;
const ATTEMPTS = 3;

export type Evaluator = (state: string) => Promise<VerdictAnswers>;

/** An empty or blank value is the same as no key at all: it would only buy a
 *  doomed call, where an absent one parks the gate as ask. */
function gatewayApiKey(): string | undefined {
  for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

export function hasGatewayKey(): boolean {
  return gatewayApiKey() !== undefined;
}

const isOutcome = (v: unknown): v is VerdictOutcome => v === "done" || v === "partial" || v === "blocked";

function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}

/** One short attempt at a time, retried while the error says it may help. */
async function withRetries<T>(attemptOnce: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce(AbortSignal.timeout(ATTEMPT_TIMEOUT_MS));
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
    }
  }
}

export const jev: Evaluator = (state) =>
  withRetries(async (abortSignal) => {
    const gateway = createGateway({ apiKey: gatewayApiKey() });
    const result = await evaluate({
      model: gateway.evaluationModel(JEV_MODEL),
      state,
      questions: VERDICT_QUESTIONS,
      maxRetries: 0,
      abortSignal,
    });
    const a = result.answers;
    const choice = a.outcome.choice;
    if (!isOutcome(choice)) throw new Error(`unexpected outcome: ${String(choice)}`);
    return {
      outcome: { choice, probabilities: a.outcome.probabilities },
      needsYou: { probability: a.needsYou.probability },
      offScope: { probability: a.offScope.probability },
    };
  });

export type JudgeEvaluator = (state: string) => Promise<JudgeAnswers>;

const isFit = (v: unknown): v is JudgeFit => v === "meets" || v === "partly" || v === "misses";

/** The same classifier asked the judge's questions. */
export const jevJudge: JudgeEvaluator = (state) =>
  withRetries(async (abortSignal) => {
    const gateway = createGateway({ apiKey: gatewayApiKey() });
    const result = await evaluate({
      model: gateway.evaluationModel(JEV_MODEL),
      state,
      questions: JUDGE_QUESTIONS,
      maxRetries: 0,
      abortSignal,
    });
    const a = result.answers;
    const choice = a.fit.choice;
    if (!isFit(choice)) throw new Error(`unexpected fit: ${String(choice)}`);
    return {
      fit: { choice, probabilities: a.fit.probabilities },
      evidence: { probability: a.evidence.probability },
      rules: { probability: a.rules.probability },
    };
  });
