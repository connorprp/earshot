// Cloud ASR via Groq (thin capture mode): the capture agent ships audio
// segments up the /ingest websocket and the hub transcribes them here, so a
// coworker's first run needs no whisper download and no local inference.
// Same dormancy pattern as google.js: no GROQ_API_KEY = feature off, the
// Settings UI hides the cloud option, agents stay in local mode.
// Billing note: Groq bills a 10s minimum per request; Earshot segments are
// short, so a chatty hour (~300 segments) is ~3000 billed seconds ≈ $0.03
// on whisper-large-v3-turbo ($0.04/audio-hr). Not worth batching.

const API_KEY = process.env.GROQ_API_KEY || "";
const BASE_URL = process.env.EARSHOT_GROQ_URL || "https://api.groq.com/openai/v1";
const MODEL = process.env.EARSHOT_GROQ_MODEL || "whisper-large-v3-turbo";

export const groqConfigured = Boolean(API_KEY);

// local-mode whisper models a user may pick in Settings; whitelisted because
// the name reaches WhisperModel(name) on the capture machine
export const ASR_MODELS = ["large-v3-turbo", "small.en", "base.en", "medium.en", "small"];

// unset user pref resolves by server capability: hosted hub with a Groq key
// gives new users the zero-download path; local dev keeps today's behavior
export function defaultAsrMode() {
  return groqConfigured ? "groq" : "local";
}

export async function transcribeSegment(wavBuffer, { language = "en" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "segment.wav");
  form.append("model", MODEL);
  form.append("language", language);
  form.append("response_format", "json");
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = new Error(`groq asr ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json.text || "").trim();
}
