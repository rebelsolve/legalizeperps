// netlify/functions/agent-log.js
// GET /api/agent-log?type=history   → post history (what was actually posted)
// GET /api/agent-log?type=runs      → agent run logs
// Protected by AGENT_LOG_SECRET env var

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const secret = Netlify.env.get("AGENT_LOG_SECRET");
  const authHeader = req.headers.get("x-log-secret");
  if (secret && authHeader !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "history";
  const store = getStore("perps-agent");

  try {
    if (type === "history") {
      const raw = await store.get("post-history");
      const history = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify(history), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    if (type === "runs") {
      const raw = await store.get("agent-logs");
      const runs = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify(runs), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    if (type === "stats") {
      const today = new Date().toISOString().split("T")[0];
      const [histRaw, dailyRaw] = await Promise.all([
        store.get("post-history"),
        store.get(`daily-count-${today}`)
      ]);
      const history = histRaw ? JSON.parse(histRaw) : [];
      return new Response(JSON.stringify({
        totalPosted: history.length,
        todayPosted: dailyRaw ? parseInt(dailyRaw) : 0,
        byPlatform: {
          twitter: history.filter(h => h.platform === "twitter").length,
          reddit: history.filter(h => h.platform === "reddit").length,
          telegram: history.filter(h => h.platform === "telegram").length,
        }
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = { path: "/api/agent-log" };
