// Earshot MCP server: lets a user's OWN Claude (Claude Code, Claude Desktop,
// or the device task agent spawned by an "agent" action) query their Earshot
// data — past sessions, transcripts, and the live board — and, since 2026-08-11,
// EDIT the live notes (see boardedit.js: the read tools describe the board, the
// write tools are how "✦ Ask Claude" actually changes it). Served at POST /mcp
// on the hub (Streamable HTTP, stateless: a fresh server per request, no
// session ids). Auth happens in index.js before this is called; every tool
// here is already scoped to one tenant.
//
// The x-earshot-thread header (written into each task's mcp.json by capture)
// says which "Ask Claude" conversation is calling, so an edit lands on the right
// board — the live one, or the archived session that chat was opened from — and
// shows up as a "✎ …" line inside that chat.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { listSessions, getSession, searchTranscripts } from "./db.js";
import { speakerLabel } from "./export.js";
import { boardSnapshot, EDIT_DOC } from "./boardedit.js";

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "List the user's recent Earshot recording sessions (most recent first): id, title, summary, when, participants. Pass query to keep only sessions whose report OR transcript mentions something.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "max sessions to return (default 20)" },
        query: { type: "string", description: "optional text filter (searches reports and transcripts)" },
      },
    },
  },
  {
    name: "get_session",
    description:
      "Full detail for one session by id: the closeout report (summary, participants, decisions, open items) and its concept bubbles with their actions. Use get_transcript for the verbatim conversation.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "session id from list_sessions" } },
      required: ["id"],
    },
  },
  {
    name: "get_transcript",
    description:
      "Verbatim transcript of one session, speaker-labeled. Long sessions are paged: pass offset to continue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "session id from list_sessions" },
        offset: { type: "number", description: "line offset to start from (default 0)" },
        limit: { type: "number", description: "max lines (default 400)" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_transcripts",
    description:
      "Search every conversation the user has ever recorded for a word or phrase (case-insensitive). Returns matching lines with their session ids — follow up with get_session / get_transcript.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "text to search for" },
        limit: { type: "number", description: "max matching lines (default 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_live_board",
    description:
      "The user's CURRENT dashboard: the live concept cards from the conversation happening right now (or the last one) WITH THEIR IDS, speaker names, the notes the user has pinned, and whether a recording is running. Call this before editing so you use real ids, and after editing to confirm.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "number", description: "also return this many most recent transcript lines (max 200)" } },
    },
  },
  // ---- write side: the user's own edits to their notes ----
  {
    name: "edit_notes",
    description:
      "Edit the user's Earshot notes — the concept cards on their dashboard. Changes appear on their screen within a second and are AUTHORITATIVE: the automatic distiller is told never to revert them. Use it whenever the user asks for a correction, a re-title, a re-classification, a split/merge, extra context, or a card removed. Only touch what they asked about, and keep cards glanceable (3-6 word title, 1-2 sentence summary, a few bullets).\n" +
      EDIT_DOC,
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "the edit operations, applied in order",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "update", "remove"] },
              id: { type: "string", description: "concept id (update/remove) — exactly as get_live_board reports it" },
              bubble: {
                type: "object",
                description: "fields to set (add/update). Only kind, title, summary, details, actions are writable.",
                properties: {
                  kind: { type: "string" },
                  title: { type: "string" },
                  summary: { type: "string" },
                  details: { type: "array", items: { type: "string" } },
                },
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
  },
  {
    name: "name_speakers",
    description:
      "Put a name to a voice. The transcript labels voices them-1, them-2, … until someone identifies them; this maps a tag to a real name everywhere (ticker, exports, later distills) and PINS it, so no later automatic pass renames that person. Never maps 'me' — that is the device owner.",
    inputSchema: {
      type: "object",
      properties: {
        map: {
          type: "object",
          description: 'voice tag -> name, e.g. {"them-2": "Dave Ramirez"}',
          additionalProperties: { type: "string" },
        },
      },
      required: ["map"],
    },
  },
  {
    name: "add_note",
    description:
      "Pin a standing correction or piece of context to this conversation. Unlike a card edit, it shapes EVERY later automatic pass (and the closeout report): use it when the fix belongs to the whole conversation rather than one card — \"Dave is the vendor, not staff\", \"we decided against the Q4 launch\", \"the numbers Sarah read out were last quarter's\".",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "the correction/context, one or two sentences" } },
      required: ["text"],
    },
  },
  {
    name: "remove_note",
    description: "Drop one of the user's pinned notes by its index (as listed in get_live_board's yourNotes).",
    inputSchema: {
      type: "object",
      properties: { index: { type: "number", description: "index from get_live_board" } },
      required: ["index"],
    },
  },
];

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] };
}

function sessionLabel(s) {
  return {
    id: String(s._id),
    title: s.report?.title || "(untitled)",
    summary: s.report?.summary || "",
    participants: s.report?.participants || [],
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    conversationId: s.conversationId || undefined,
  };
}

function lineLabel(l, speakerNames = {}) {
  return `[${speakerLabel(l, speakerNames)}] ${l.text}`;
}

// every write tool funnels through the tenant, which decides whether this
// conversation is editing the live board or an archived session
async function edit(tenant, threadId, ops) {
  const res = await tenant.applyUserEdit(ops, threadId);
  const lines = [];
  if (res.summary.length) lines.push(`Done — ${res.summary.join("; ")}. The user can see it now.`);
  else lines.push("Nothing changed.");
  if (res.errors.length) lines.push(`Problems: ${res.errors.join("; ")}`);
  return text(`${lines.join("\n")}\n\nBoard now:\n${JSON.stringify(res.board || {}, null, 1)}`);
}

async function callTool(tenant, name, args = {}, threadId = "") {
  const userId = tenant.userId;
  switch (name) {
    case "list_sessions": {
      const rows = await listSessions(userId, {
        q: String(args.query || ""),
        limit: Math.min(Number(args.limit) || 20, 100),
      });
      return text(
        rows.map((s) => ({
          ...sessionLabel(s),
          lineCount: s.lineCount,
          // why this session matched a query, when it matched on transcript text
          matchedLine: s.snippet || undefined,
          matches: s.matches || undefined,
        }))
      );
    }
    case "get_session": {
      const data = await getSession(userId, String(args.id)).catch(() => null);
      if (!data) return text("No session with that id.");
      const { session, bubbles } = data;
      return text({
        ...sessionLabel(session),
        report: session.report || null,
        lineCount: data.transcript.length,
        bubbles: bubbles.map((b) => ({
          title: b.title,
          kind: b.kind,
          summary: b.summary,
          details: b.details || [],
          removed: b.removed || false,
          actions: (b.actions || []).map((a) => ({ type: a.type, label: a.label, status: a.status })),
        })),
      });
    }
    case "get_transcript": {
      const data = await getSession(userId, String(args.id)).catch(() => null);
      if (!data) return text("No session with that id.");
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(Number(args.limit) || 400, 1000);
      const names = data.session.speakerNames || {};
      const lines = data.transcript.slice(offset, offset + limit).map((l) => lineLabel(l, names));
      const remaining = Math.max(0, data.transcript.length - offset - limit);
      return text(lines.join("\n") + (remaining ? `\n\n(${remaining} more lines — call again with offset=${offset + limit})` : ""));
    }
    case "search_transcripts": {
      const query = String(args.query || "").trim();
      if (!query) return text("Empty query.");
      const rows = await searchTranscripts(userId, query, Math.min(Number(args.limit) || 30, 100));
      if (!rows.length) return text("No matches.");
      return text(rows.map((l) => ({ sessionId: String(l.sessionId), at: l.at, line: lineLabel(l) })));
    }
    case "get_live_board": {
      const want = Math.min(Math.max(Number(args.lines) || 0, 0), 200);
      const names = tenant.state.speakers || {};
      return text({
        recording: tenant.recording,
        ...boardSnapshot(tenant.state),
        ...(want
          ? { recentTranscript: tenant.transcript.slice(-want).map((l) => lineLabel(l, names)) }
          : {}),
      });
    }
    case "edit_notes":
      return edit(tenant, threadId, args.ops);
    case "name_speakers":
      return edit(tenant, threadId, [{ op: "speakers", map: args.map }]);
    case "add_note":
      return edit(tenant, threadId, [{ op: "note", text: args.text }]);
    case "remove_note":
      return edit(tenant, threadId, [{ op: "unnote", index: args.index }]);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function buildServer(tenant, threadId = "") {
  const server = new Server(
    { name: "earshot", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(tenant, req.params.name, req.params.arguments, threadId);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });
  return server;
}

export async function handleMcp(req, res, tenant) {
  if (req.method !== "POST") {
    // stateless mode: no SSE stream to GET, no session to DELETE
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
  }
  const threadId = String(req.headers["x-earshot-thread"] || "").slice(0, 64);
  const server = buildServer(tenant, threadId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}
