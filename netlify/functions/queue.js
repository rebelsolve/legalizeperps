// netlify/functions/queue.js
// GET  /api/queue          → returns pending queue
// POST /api/queue          → approve or dismiss a signal
// DELETE /api/queue        → clear entire queue

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("perps-queue");

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // GET — return the queue
  if (req.method === "GET") {
    try {
      const raw = await store.get("queue");
      const queue = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify(queue), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // POST — approve or dismiss
  if (req.method === "POST") {
    try {
      const { action, id, editedDraft } = await req.json();
      const raw = await store.get("queue");
      let queue = raw ? JSON.parse(raw) : [];

      if (action === "approve") {
        queue = queue.map(item =>
          item.id === id
            ? { ...item, status: "approved", approvedAt: new Date().toISOString(), draft: editedDraft || item.draft }
            : item
        );
      } else if (action === "dismiss") {
        queue = queue.map(item =>
          item.id === id ? { ...item, status: "dismissed" } : item
        );
      } else if (action === "redraft") {
        // Trigger a new Claude draft for this item
        const item = queue.find(i => i.id === id);
        if (item) {
          const newDraft = await redraftReply(item);
          queue = queue.map(i => i.id === id ? { ...i, draft: newDraft } : i);
        }
      }

      await store.set("queue", JSON.stringify(queue));
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  // DELETE — clear queue
  if (req.method === "DELETE") {
    try {
      await store.set("queue", JSON.stringify([]));
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response("Method not allowed", { status: 405, headers });
};

async function redraftReply(signal) {
  const toneMap = {
    twitter: "casual and genuine, under 240 chars",
    reddit: "helpful, 1-3 sentences",
    discord: "casual and short",
    telegram: "direct, 1-2 sentences"
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Netlify.env.get("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `You are a genuine Hyperliquid community member. You made "Legalize Perps" shirt at legalizeperps.com — $25, black cotton tee for HL degens.

Someone posted: "${signal.text}"
User: ${signal.user} on ${signal.platform}

Write a fresh, different reply that is ${toneMap[signal.platform] || "casual"}. Reply text only.`
      }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || signal.draft;
}

export const config = { path: "/api/queue" };
