import type { Run } from "../../src/core/types";
import { VOICE_CONTEXT_MESSAGES, VOICE_CONTEXT_TEXT, type VoiceChat, type VoiceContext } from "../../src/core/voicewire";
import type { CanopyState } from "./store";

type Page = Pick<CanopyState, "repos" | "runs" | "sheet" | "front" | "activePanel"> & Partial<Pick<CanopyState, "activeTerm" | "terms" | "flows">>;

export function voiceChat(run: Run): VoiceChat {
  return {
    id: run.id, verb: run.verb, status: run.status, note: run.note.slice(0, VOICE_CONTEXT_TEXT),
    messages: run.steps.filter((s) => (s.kind === "user" || s.kind === "text") && s.text?.trim()).slice(-VOICE_CONTEXT_MESSAGES).map((s) => ({ who: s.kind === "user" ? "user" : "assistant", text: (s.text ?? "").slice(-VOICE_CONTEXT_TEXT) })),
  };
}

/** Sheets take precedence; panels only supply context on the git view. */
export function captureVoiceContext(s: Page, query: URLSearchParams, focusedRun: string | null = null): VoiceContext {
  const view = query.get("view") || "git";
  const global: VoiceContext = { kind: "global", view };
  const runId = s.sheet?.kind === "run" ? s.sheet.runId : !s.sheet && view === "agents" ? focusedRun : null;
  const run = runId ? s.runs[runId] : undefined;
  if (runId && !run) return global;
  const shown = s.front?.kind === "project" ? s.front.repoId : s.front?.kind === "strip" ? s.terms?.find((t) => t.id === s.activeTerm)?.repoId : s.activePanel;
  const sheetRepo = s.sheet && "repoId" in s.sheet ? s.sheet.repoId : s.sheet?.kind === "flow" ? s.flows?.[s.sheet.flowId]?.repoId : null;
  const repoId = run?.repoId ?? sheetRepo ?? query.get("repo") ?? (view === "git" && !s.sheet ? shown : null);
  const repo = s.repos.find((r) => r.id === repoId);
  if (!repo) return global;
  const target = { id: repo.id, name: repo.name, path: repo.path };
  return run ? { kind: "chat", view, repo: target, chat: voiceChat(run) } : { kind: "repo", view, repo: target };
}

/** Re-read the target before sending; never substitute another open chat. */
export async function sendVoicePrompt(context: VoiceContext, prompt: string, s: Pick<CanopyState, "repos" | "runs" | "sayRun" | "openChat">): Promise<void> {
  if (context.kind === "global") throw new Error("Choose a repository before starting work");
  if (!s.repos.some((r) => r.id === context.repo.id && !r.archived && !r.forge)) throw new Error("The invoked repository is no longer available");
  if (context.kind === "chat") {
    const run = s.runs[context.chat.id];
    if (!run || run.repoId !== context.repo.id) throw new Error("The invoked chat is no longer available");
    if (!run.chat) throw new Error("This run does not accept chat messages; open a chat on this repo");
    if (run.status === "working" || run.status === "waiting") throw new Error("The invoked chat is still working or waiting for your answer");
    if (run.status !== "idle") throw new Error("The invoked chat has ended; open a chat to continue");
    await s.sayRun(run.id, prompt);
  } else await s.openChat(context.repo.id, prompt);
}
