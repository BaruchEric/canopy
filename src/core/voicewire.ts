/**
 * The voice conversation's shared half, browser-safe: what the page and the
 * server must agree on. The server mints a client secret with these tools
 * and these instructions; the page opens the socket, speaks the realtime
 * events below and runs each tool by name. Pure; the UI imports it.
 */

export const VOICE_MODELS = ["eleven_realtime_v1_mini", "eleven_realtime_v1_max"] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];

/** where the page connects, with the minted secret as a WebSocket subprotocol */
export const VOICE_SOCKET = "wss://api.elevenlabs.io/v1/convai/realtime";
/** the audio both ways: 16-bit little-endian mono PCM at this rate */
export const VOICE_RATE = 24_000;

/** GET /api/voice: the Eleven model a conversation would use, null when
 *  this backend has no key; the GPT-Live model, null with no
 *  `CANOPY_LIVE_KEY`; and whether it turns speech into text for a field
 *  (`CANOPY_TRANSCRIBE_URL` set) */
export interface VoiceInfo {
  model: VoiceModel | null;
  live: string | null;
  dictate: boolean;
}

/** POST /api/voice/live: the page's WebRTC offer, which the backend takes
 *  to OpenAI with its key, since GPT-Live has no client secret a page could
 *  open a session with */
export interface LiveOffer {
  sdp: string;
}

/** the answer to set as the peer connection's remote description */
export interface LiveAnswer {
  id: string;
  sdp: string;
}

/** an offer past this is refused (413); a real one is a few KB */
export const LIVE_OFFER_MAX = 64 * 1024;

/** POST /api/voice/dictate: what was said in the clip the page recorded */
export interface Dictation {
  text: string;
}

/** a dictated clip past this is refused (413); OpenAI-style servers take 25 MB */
export const DICTATE_MAX = 25 * 1024 * 1024;

/** the file name a clip goes to the speech model under: Whisper-style
 *  servers read the format off the extension, not the type */
export function dictationName(type: string): string {
  const t = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };
  return `dictation.${ext[t] ?? "webm"}`;
}

/** POST /api/voice/session: the model and the secret to open it with */
export interface VoiceSession {
  socket: string;
  model: VoiceModel;
  secret: string;
  /** unix seconds; past this the secret no longer opens a session */
  expiresAt: number;
}

export interface VoiceTool {
  type: "function";
  name: VoiceToolName;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

/** the views a spoken "open" may land on, as App.tsx names them */
export const VOICE_VIEWS = ["git", "agents", "incubator", "library", "ports", "triggers", "kit", "health", "secrets"] as const;
export type VoiceView = (typeof VOICE_VIEWS)[number];

export const VOICE_TOOL_NAMES = ["overview", "list_repos", "needs_me", "list_runs", "open_repo", "open_view", "end_conversation"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

export const isVoiceTool = (name: string): name is VoiceToolName => (VOICE_TOOL_NAMES as readonly string[]).includes(name);

const none = { type: "object", properties: {} } as const;

/** Read and navigate only: nothing said aloud commits, pushes, answers an
 *  ask or starts a run. A misheard word must not change anything. */
export const VOICE_TOOLS: VoiceTool[] = [
  {
    type: "function",
    name: "overview",
    description: "Counts across every repo canopy watches: how many have uncommitted changes, are ahead or behind, how many asks and runs wait on the user, how many runs are working. Call this first for a general question.",
    parameters: { ...none },
  },
  {
    type: "function",
    name: "list_repos",
    description: "Repos with their branch, changed file count, and commits ahead and behind upstream. At most 15 come back, the busiest first.",
    parameters: {
      type: "object",
      properties: {
        only: { type: "string", enum: ["changed", "ahead", "behind", "all"], description: "which repos; default changed" },
        name: { type: "string", description: "part of a repo name to filter on" },
      },
    },
  },
  {
    type: "function",
    name: "needs_me",
    description: "What is waiting on the user: open permission asks and questions from agents, and runs paused waiting for an answer.",
    parameters: { ...none },
  },
  {
    type: "function",
    name: "list_runs",
    description: "Agent runs and background jobs: which are working, and which finished, failed or stopped most recently.",
    parameters: {
      type: "object",
      properties: { active_only: { type: "boolean", description: "only what is still working or waiting; default true" } },
    },
  },
  {
    type: "function",
    name: "open_repo",
    description: "Open a repo's panel on the user's screen. Pass the repo name as the user said it; the answer says which repo opened, or the closest names when none matched.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    type: "function",
    name: "open_view",
    description: "Switch the user's screen to one of canopy's views.",
    parameters: { type: "object", properties: { view: { type: "string", enum: [...VOICE_VIEWS] } }, required: ["view"] },
  },
  {
    type: "function",
    name: "end_conversation",
    description: "Hang up, when the user says goodbye or that they are done. Say a short goodbye first.",
    parameters: { ...none },
  },
];

export const VOICE_INSTRUCTIONS = [
  "You are the voice of canopy, a cockpit for one developer's git repos and the Claude agents working in them.",
  "You are heard, not read: answer in one to three short spoken sentences, with no lists, markdown, paths or ids.",
  "Round numbers and name repos the way a person would say them.",
  "Use the tools for anything about repos, runs or what is waiting; never guess state you have not looked up.",
  "You can look things up and open repos and views on the screen. You cannot commit, push, answer an ask or start or stop a run;",
  "when asked to, say that it has to be done in canopy by hand, and offer to open the right place.",
].join(" ");

// GPT-Live splits the work: the live model talks and hands anything that
// needs a lookup to a backend model, which holds the tools. Each gets its
// half of the rules above.

export const LIVE_INSTRUCTIONS = [
  "You are the voice of canopy, a cockpit for one developer's git repos and the Claude agents working in them.",
  "Answer in one to three short spoken sentences, with no lists, paths or ids. Round numbers and name repos the way a person would say them.",
  "You know nothing about the repos, runs or asks yourself: delegate every question about them, every request to open a repo or a view, and the goodbye when the user is done.",
  "While the backend works, say a few words at most. Never guess what it will find.",
].join(" ");

export const LIVE_BACKEND_INSTRUCTIONS = [
  "You answer for canopy's voice, which speaks your result aloud, so return one to three plain sentences with no lists, markdown, paths or ids.",
  "Use the tools for anything about repos, runs or what is waiting; never guess state you have not looked up.",
  "You can look things up and open repos and views on the screen. You cannot commit, push, answer an ask or start or stop a run;",
  "when asked to, say that it has to be done in canopy by hand, and offer to open the right place.",
  "When the user says goodbye or that they are done, call end_conversation and return a short goodbye.",
].join(" ");
