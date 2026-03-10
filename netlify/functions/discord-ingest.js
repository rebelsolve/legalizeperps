// netlify/functions/discord-ingest.js
// POST /api/discord-ingest
// Your Discord bot POSTs keyword matches here
// Signals are stored in blob store for the agent to pick up

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secret = Netlify.env.get("DISCORD_INGEST_SECRET");
  const authHeader = req.headers.get("x-ingest-secret");
  if (secret && authHeader !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json();
    const store = getStore("perps-queue");
    const raw = await store.get("discord-inbox");
    const inbox = raw ? JSON.parse(raw) : [];
    inbox.push({
      id: "dc-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      platform: "discord",
      user: body.username || "Discord user",
      followers: 0,
      text: body.content || "",
      engagement: body.reactions || 0,
      age: new Date().toISOString(),
      url: body.messageUrl || null,
      serverName: body.serverName || "",
      channelName: body.channelName || ""
    });
    await store.set("discord-inbox", JSON.stringify(inbox));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = { path: "/api/discord-ingest" };
