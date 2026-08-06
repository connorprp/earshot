// Earshot MCP server: lets a user's OWN Claude (Claude Code, Claude Desktop,
// or the device task agent spawned by an "agent" action) query their Earshot
// data — past sessions, transcripts, and the live board. Served at POST /mcp
// on the hub (Streamable HTTP, stateless: a fresh server per request, no
// session ids). Auth happens in index.js before this is called; every tool
// here is already scoped to one tenant.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { listSessions, getSession, searchTranscripts } from "./db.js";

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
      "The user's CURRENT dashboard: live concept bubbles from the conversation happening right now (or the last one), speaker names, and whether a recording is running.",
    inputSchema: { type: "object", properties: {} },
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
  const who = l.source === "me" ? "Me" : speakerNames[l.speaker] || l.speaker || "Them";
  return `[${who}] ${l.text}`;
}

async function callTool(tenant, name, args = {}) {
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
      return text({
        recording: tenant.recording,
        speakers: tenant.state.speakers || {},
        bubbles: tenant.state.bubbles.map((b) => ({
          title: b.title,
          kind: b.kind,
          summary: b.summary,
          details: b.details || [],
        })),
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function buildServer(tenant) {
  const server = new Server(
    { name: "earshot", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(tenant, req.params.name, req.params.arguments);
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
  const server = buildServer(tenant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}
