/** The Jev classifier through the Vercel AI Gateway, asked the verdict
 *  questions. Ported from ~/dev/ai-tools/jev-lab. Bun-only. */

import { createGateway } from "@ai-sdk/gateway";
import { APICallError, experimental_evaluate as evaluate } from "ai";
import { VERDICT_QUESTIONS } from "./verdict";
import type { VerdictAnswers, VerdictOutcome } from "./types";

export const JEV_MODEL = "typesafe-ai/jev";
/** Jev answers in a few hundred ms; the gateway occasionally hangs, so each
 *  attempt is short and retried. */
const ATTEMPT_TIMEOUT_MS = 6000;
const ATTEMPTS = 3;

export type Evaluator = (state: string) => Promise<VerdictAnswers>;

function gatewayApiKey(): string | undefined {
  return process.env["AI_GATEWAY_API_KEY"] ?? process.env["VERCEL_AI_GATEWAY_API_KEY"];
}

export function hasGatewayKey(): boolean {
  return gatewayApiKey() !== undefined;
}

const isOutcome = (v: unknown): v is VerdictOutcome => v === "done" || v === "partial" || v === "blocked";

function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}

export const jev: Evaluator = async (state) => {
  const gateway = createGateway({ apiKey: gatewayApiKey() });
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await evaluate({
        model: gateway.evaluationModel(JEV_MODEL),
        state,
        questions: VERDICT_QUESTIONS,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      const a = result.answers;
      const choice = a.outcome.choice;
      if (!isOutcome(choice)) throw new Error(`unexpected outcome: ${String(choice)}`);
      return {
        outcome: { choice, probabilities: a.outcome.probabilities },
        needsYou: { probability: a.needsYou.probability },
        offScope: { probability: a.offScope.probability },
      };
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
    }
  }
};
