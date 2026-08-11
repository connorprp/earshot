// Injects a fake conversation into the hub so the distill loop and dashboard
// can be tested without live audio. Run the server first, then: npm run inject
import WebSocket from "ws";

// [source, text, speaker?] — source is the CHANNEL ("me" = mic, "them" =
// loopback), speaker is the VOICE tag capture's clustering assigns. Note
// them-2: a third person arriving on the MIC, the way a coworker in the room or
// a phone call on speakerphone does — mic audio is not automatically the user.
const LINES = [
  ["them", "Hey, so a couple things today. First, the homepage redesign.", "them-1"],
  ["me", "Yeah, I think the hero section is too cluttered, we should drop the carousel.", "me"],
  ["them", "Agreed. And the pricing table needs a third column for the enterprise tier, 199 a month.", "them-1"],
  ["me", "I've got Ollie here with me, he's been in that template all week.", "me"],
  ["me", "The enterprise column is easy, but the mobile breakpoint is going to fight us.", "them-2"],
  ["me", "Okay, I can have Claude take a pass at that this week.", "me"],
  ["them", "Second thing, when are you free next week to review the membership numbers?", "them-1"],
  ["me", "When are you free?", "me"],
  ["them", "Thursday or Friday, before 3.", "them-1"],
  ["me", "Thursday's better for me, I'm on site Friday.", "them-2"],
  ["me", "Let's do Thursday at 2pm then.", "me"],
  ["them", "Great, works for me.", "them-1"],
  ["me", "Can you give me the regional membership counts real quick?", "me"],
  ["them", "Sure. Northeast is 412, Southeast 388, Midwest 291, and West is 502.", "them-1"],
  ["me", "Got it, thanks. I'll put that in a sheet.", "me"],
];

const HUB = "http://127.0.0.1:7071";

// the hub drops ingest lines unless a recording session is open
try {
  await fetch(`${HUB}/record/start`, { method: "POST" });
  console.log("recording started");
} catch (e) {
  console.error("connect failed (is the server running?):", e.message);
  process.exit(1);
}

// stable fake voice profile so back-to-back inject runs voice-match as the
// same person during the closeout relatedness check
const SPEAKERS = [
  { id: "me", centroid: [0, 0, 1, 0, 0, 0, 0, 0], seconds: 40 },
  { id: "them-1", centroid: [0.6, 0.8, 0, 0, 0, 0, 0, 0], seconds: 30 },
  { id: "them-2", centroid: [0, 0.6, 0, 0.8, 0, 0, 0, 0], seconds: 12 },
];

const ws = new WebSocket("ws://127.0.0.1:7071/ingest");
ws.on("open", async () => {
  console.log("connected, injecting lines every 2s ...");
  ws.send(JSON.stringify({ type: "speakers", speakers: SPEAKERS }));
  for (const [source, text, speaker] of LINES) {
    ws.send(JSON.stringify({ type: "transcript", source, text, ts: Date.now() / 1000, ...(speaker && { speaker }) }));
    console.log(`  [${speaker || source}] ${text}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("done — watch the dashboard / GET /state (session left recording; press Stop in the dashboard to close it)");
  ws.close();
});
ws.on("error", (e) => console.error("connect failed (is the server running?):", e.message));
