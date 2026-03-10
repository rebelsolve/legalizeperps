// netlify/functions/agent.js
// ─────────────────────────────────────────────────────────────────────────────
// FULLY AUTONOMOUS POSTING AGENT
// Runs every 30 minutes via Netlify cron schedule
// Finds signals → scores them → drafts genuinely helpful replies → posts
//
// IMPORTANT: Use DEDICATED accounts — not your main @solvemaxwell
//   Twitter:  @legalizeperps (or similar throwaway)
//   Reddit:   u/legalizeperps
//   Telegram: your existing bot posts directly
//
// REQUIRED ENV VARS IN NETLIFY:
//   ANTHROPIC_API_KEY
//
//   TWITTER_BEARER_TOKEN        ← read-only, for searching
//   TWITTER_API_KEY             ← dedicated posting account (OAuth 1.0a)
//   TWITTER_API_SECRET
//   TWITTER_ACCESS_TOKEN        ← for @legalizeperps account
//   TWITTER_ACCESS_SECRET
//
//   REDDIT_CLIENT_ID            ← script app
//   REDDIT_CLIENT_SECRET
//   REDDIT_USERNAME             ← u/legalizeperps
//   REDDIT_PASSWORD
//
//   TELEGRAM_BOT_TOKEN          ← bot posts to chats it's a member of
//
//   AGENT_LOG_SECRET            ← protects /api/agent-log endpoint (make up any string)
// ─────────────────────────────────────────────────────────────────────────────

import { getStore } from "@netlify/blobs";
import crypto from "crypto";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const KEYWORDS = [
  "legalize perps", "hyperliquid merch", "rHYPURR", "on-chain perps",
  "hyperliquid", "HL degen", "HYPE token", "perps trader", "HL community",
  "hyperliquid ecosystem", "HL shirt"
];

const SHIRT_URL = "legalizeperps.com";
const SHIRT_PRICE = "$25";

// THE CORE THESIS — injected into every Claude prompt
// This is what makes replies genuinely interesting, not just ads
const MISSION = `
"Legalize Perps" is a community shirt at ${SHIRT_URL} for ${SHIRT_PRICE}.
Here's what makes it different and genuinely worth telling people about:
100% of shirt proceeds are used to buy HYPE on Hyperliquid — creating real, ongoing buy pressure.
Every shirt sold = more HYPE purchased. It's ecosystem alignment through merch.
If someone owns HYPE, buying this shirt literally adds buy pressure to their own bag.
The shirt itself: black 100% ring-spun cotton, soft and quality, ships fast.
This is NOT just merch. It's a coordinated community buy pressure mechanism.
`.trim();

// Rate limits — prevents detection, keeps the account healthy
const MAX_POSTS_PER_RUN   = 3;    // max replies per 30-min run
const MAX_POSTS_PER_DAY   = 10;   // hard daily cap
const MIN_SCORE_TO_POST   = 74;   // only reply to genuinely high-relevance signals
const COOLDOWN_HOURS      = 8;    // never reply to same user twice within 8 hours
const MIN_ACCOUNT_AGE_HRS = 0;    // set to 72+ if account is brand new (warmup period)

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async (req, context) => {
  const store = getStore("perps-agent");
  const log = [];
  let postsThisRun = 0;

  const addLog = (msg, data = null) => {
    const entry = { ts: new Date().toISOString(), msg, ...(data ? { data } : {}) };
    log.push(entry);
    console.log(JSON.stringify(entry));
  };

  addLog("Agent run started");

  // ── DAILY POST COUNT CHECK ────────────────────────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  const dailyKey = `daily-count-${today}`;
  let dailyCount = 0;
  try {
    const raw = await store.get(dailyKey);
    dailyCount = raw ? parseInt(raw) : 0;
  } catch {}

  if (dailyCount >= MAX_POSTS_PER_DAY) {
    addLog(`Daily cap reached (${dailyCount}/${MAX_POSTS_PER_DAY}). Exiting.`);
    await saveLog(store, log);
    return new Response(JSON.stringify({ skipped: "daily_cap", dailyCount }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ── FETCH SIGNALS FROM ALL PLATFORMS ─────────────────────────────────────
  const [twitterSignals, redditSignals, telegramSignals] = await Promise.all([
    fetchTwitter(addLog),
    fetchReddit(addLog),
    fetchTelegram(addLog),
  ]);

  const allSignals = [...twitterSignals, ...redditSignals, ...telegramSignals];
  addLog(`Signals found: ${allSignals.length} total (Twitter: ${twitterSignals.length}, Reddit: ${redditSignals.length}, Telegram: ${telegramSignals.length})`);

  // ── SCORE + FILTER + DEDUP ────────────────────────────────────────────────
  const scored = allSignals
    .map(s => ({ ...s, score: scoreSignal(s) }))
    .filter(s => s.score >= MIN_SCORE_TO_POST)
    .sort((a, b) => b.score - a.score);

  addLog(`Signals above threshold (${MIN_SCORE_TO_POST}): ${scored.length}`);

  for (const signal of scored) {
    if (postsThisRun >= MAX_POSTS_PER_RUN) break;
    if (dailyCount + postsThisRun >= MAX_POSTS_PER_DAY) break;

    // Dedup check
    const seen = await isDuplicate(store, signal.id);
    if (seen) { addLog(`Skipping duplicate: ${signal.id}`); continue; }

    // Cooldown check — don't reply to same user twice in 8 hours
    const cooledDown = await isOnCooldown(store, signal.user, signal.platform);
    if (cooledDown) { addLog(`User on cooldown: ${signal.user}`); continue; }

    // Draft reply
    addLog(`Drafting reply for: ${signal.id} (score: ${signal.score})`);
    const draft = await draftReply(signal, addLog);
    if (!draft) { addLog(`Draft failed for ${signal.id}`); continue; }

    // Post
    addLog(`Posting to ${signal.platform}: ${signal.id}`, { draft: draft.slice(0, 80) + "..." });
    const posted = await post(signal, draft, addLog);

    if (posted) {
      postsThisRun++;
      await markSeen(store, signal.id);
      await setCooldown(store, signal.user, signal.platform);
      addLog(`✓ Posted successfully to ${signal.platform}`);

      // Save to history for dashboard review
      await saveToHistory(store, { ...signal, draft, postedAt: new Date().toISOString() });
    }
  }

  // Update daily count
  await store.set(dailyKey, String(dailyCount + postsThisRun));
  addLog(`Run complete. Posted: ${postsThisRun}. Daily total: ${dailyCount + postsThisRun}/${MAX_POSTS_PER_DAY}`);
  await saveLog(store, log);

  return new Response(JSON.stringify({
    posted: postsThisRun,
    dailyTotal: dailyCount + postsThisRun,
    signalsFound: allSignals.length,
    signalsScored: scored.length,
  }), { headers: { "Content-Type": "application/json" } });
};

// ── SCORE SIGNAL ──────────────────────────────────────────────────────────────
function scoreSignal(signal) {
  let score = 35;
  const text = (signal.text || "").toLowerCase();

  // High-value keyword matches
  if (text.includes("legalize perps"))      score += 35;
  if (text.includes("hyperliquid merch"))   score += 30;
  if (text.includes("rhypurr"))             score += 25;
  if (text.includes("on-chain perps"))      score += 18;
  if (text.includes("hl degen"))            score += 15;
  if (text.includes("perps trader"))        score += 15;
  if (text.includes("hype token"))          score += 12;
  if (text.includes("hyperliquid"))         score += 10;

  // Intent signals — someone actively looking for something
  if (text.includes("where") || text.includes("anyone know"))  score += 12;
  if (text.includes("merch") || text.includes("shirt"))        score += 18;
  if (text.includes("wear") || text.includes("starter pack"))  score += 15;
  if (text.includes("buy") || text.includes("support"))        score += 8;

  // Engagement weight
  if (signal.engagement > 1000) score += 20;
  else if (signal.engagement > 200) score += 12;
  else if (signal.engagement > 50)  score += 6;
  else if (signal.engagement > 10)  score += 3;

  // Follower weight (Twitter)
  if (signal.followers > 20000) score += 18;
  else if (signal.followers > 5000)  score += 10;
  else if (signal.followers > 1000)  score += 5;

  return Math.min(score, 99);
}

// ── DRAFT REPLY VIA CLAUDE ────────────────────────────────────────────────────
async function draftReply(signal, addLog) {
  const platformRules = {
    twitter: `Twitter/X reply. MUST be under 240 characters. Punchy, genuine, no hashtags unless natural. Single sentence or two short ones.`,
    reddit:  `Reddit comment. 2-4 sentences. Helpful tone that fits the subreddit. Can explain the HYPE buy pressure angle briefly since there's more space.`,
    telegram:`Telegram message. 1-3 sentences. Casual, direct, community tone.`,
  };

  const prompt = `You are a genuine, helpful member of the Hyperliquid crypto community.
You are NOT a bot (even though you are) — your replies must sound like a real person who actually cares about the ecosystem.

Here is what you're sharing when relevant:
${MISSION}

A real person just posted this on ${signal.platform}:
"${signal.text}"

Posted by: ${signal.user}${signal.followers > 0 ? ` (${signal.followers.toLocaleString()} followers)` : ""}
Engagement: ${signal.engagement}

Write a reply following these rules:
1. ${platformRules[signal.platform] || platformRules.twitter}
2. Lead with something genuinely useful or resonant — acknowledge what they said first
3. The shirt/URL should feel like a natural recommendation, not an ad
4. If there's room, mention that proceeds buy HYPE — this is the most compelling part for this audience
5. NEVER say "I made this" or "I'm selling" — position it as something you discovered or are part of
6. NEVER use marketing language like "check out", "amazing", "limited", "don't miss"
7. Sound like a person texting, not a press release
8. Include ${SHIRT_URL} naturally — don't bold it or make it feel like a CTA

Reply text only. No preamble, no explanation, no quotation marks around the reply.`;

  try {
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
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    const draft = data.content?.[0]?.text?.trim();
    if (!draft) { addLog("Claude returned empty draft"); return null; }

    // Safety check — if Claude somehow produced something weird, skip it
    const lower = draft.toLowerCase();
    if (lower.includes("i cannot") || lower.includes("i'm an ai") || lower.includes("as an ai")) {
      addLog("Draft rejected — Claude broke character");
      return null;
    }
    // Twitter length guard
    if (signal.platform === "twitter" && draft.length > 280) {
      addLog(`Draft too long for Twitter (${draft.length} chars) — skipping`);
      return null;
    }
    return draft;
  } catch (e) {
    addLog("Claude API error: " + e.message);
    return null;
  }
}

// ── TWITTER FETCH (read) ──────────────────────────────────────────────────────
async function fetchTwitter(addLog) {
  const token = Netlify.env.get("TWITTER_BEARER_TOKEN");
  if (!token) { addLog("Twitter: TWITTER_BEARER_TOKEN not set"); return []; }

  const query = encodeURIComponent(
    '(hyperliquid OR "legalize perps" OR "on-chain perps" OR rHYPURR OR "HL degen" OR "hyperliquid merch") -is:retweet lang:en'
  );
  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=public_metrics,author_id,created_at,conversation_id&expansions=author_id&user.fields=public_metrics,username`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.errors || !data.data) { addLog("Twitter API issue", data.errors || data); return []; }
    const users = {};
    (data.includes?.users || []).forEach(u => { users[u.id] = u; });
    return data.data.map(tweet => {
      const user = users[tweet.author_id] || {};
      return {
        id: "tw-" + tweet.id,
        platform: "twitter",
        user: "@" + (user.username || "unknown"),
        followers: user.public_metrics?.followers_count || 0,
        text: tweet.text,
        engagement: (tweet.public_metrics?.like_count || 0) + (tweet.public_metrics?.retweet_count || 0),
        tweetId: tweet.id,
        conversationId: tweet.conversation_id,
      };
    });
  } catch (e) {
    addLog("Twitter fetch error: " + e.message);
    return [];
  }
}

// ── TWITTER POST (write — dedicated account) ──────────────────────────────────
async function postToTwitter(signal, draft, addLog) {
  const apiKey    = Netlify.env.get("TWITTER_API_KEY");
  const apiSecret = Netlify.env.get("TWITTER_API_SECRET");
  const accToken  = Netlify.env.get("TWITTER_ACCESS_TOKEN");
  const accSecret = Netlify.env.get("TWITTER_ACCESS_SECRET");
  if (!apiKey || !apiSecret || !accToken || !accSecret) {
    addLog("Twitter post: missing OAuth credentials"); return false;
  }

  const url = "https://api.twitter.com/2/tweets";
  const body = JSON.stringify({
    text: draft,
    reply: { in_reply_to_tweet_id: signal.tweetId }
  });

  // OAuth 1.0a signature
  const authHeader = buildOAuth1Header("POST", url, {}, apiKey, apiSecret, accToken, accSecret);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body
    });
    const data = await res.json();
    if (data.data?.id) { addLog("Twitter posted: " + data.data.id); return true; }
    addLog("Twitter post failed", data);
    return false;
  } catch (e) {
    addLog("Twitter post error: " + e.message);
    return false;
  }
}

// ── REDDIT FETCH ──────────────────────────────────────────────────────────────
async function fetchReddit(addLog) {
  const clientId     = Netlify.env.get("REDDIT_CLIENT_ID");
  const clientSecret = Netlify.env.get("REDDIT_CLIENT_SECRET");
  const username     = Netlify.env.get("REDDIT_USERNAME");
  const password     = Netlify.env.get("REDDIT_PASSWORD");
  if (!clientId || !clientSecret) { addLog("Reddit: credentials not set"); return []; }

  try {
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
        "User-Agent": "LegalizePerpsBot/1.0 by " + (username || "legalizeperps")
      },
      body: username && password
        ? `grant_type=password&username=${username}&password=${password}`
        : "grant_type=client_credentials"
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;
    if (!token) { addLog("Reddit token failed", tokenData); return []; }

    const subreddits = ["hyperliquid", "CryptoCurrency", "defi", "ethfinance"];
    const signals = [];

    for (const sub of subreddits) {
      try {
        const res = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=25`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "LegalizePerpsBot/1.0 by " + (username || "legalizeperps")
          }
        });
        const data = await res.json();
        for (const post of (data?.data?.children || [])) {
          const p = post.data;
          const fullText = (p.title + " " + (p.selftext || "")).toLowerCase();
          if (KEYWORDS.some(kw => fullText.includes(kw.toLowerCase()))) {
            signals.push({
              id: "rd-" + p.id,
              platform: "reddit",
              user: "u/" + p.author,
              followers: 0,
              text: p.title + (p.selftext ? ": " + p.selftext.slice(0, 300) : ""),
              engagement: p.score || 0,
              subreddit: sub,
              postId: p.name, // fullname like t3_xxxxx
              _token: token,  // reuse for posting
              _username: username,
            });
          }
        }
      } catch (e) { addLog(`Reddit r/${sub} error: ` + e.message); }
    }
    return signals;
  } catch (e) {
    addLog("Reddit fetch error: " + e.message);
    return [];
  }
}

// ── REDDIT POST ───────────────────────────────────────────────────────────────
async function postToReddit(signal, draft, addLog) {
  const token    = signal._token;
  const username = signal._username || Netlify.env.get("REDDIT_USERNAME");
  const clientId = Netlify.env.get("REDDIT_CLIENT_ID");
  const clientSecret = Netlify.env.get("REDDIT_CLIENT_SECRET");

  if (!token || !username) { addLog("Reddit post: no token or username"); return false; }

  try {
    const res = await fetch("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
        "User-Agent": "LegalizePerpsBot/1.0 by " + username,
      },
      body: new URLSearchParams({
        api_type: "json",
        thing_id: signal.postId,
        text: draft,
      }).toString()
    });
    const data = await res.json();
    if (data.json?.data?.things?.length > 0) {
      addLog("Reddit posted: " + data.json.data.things[0].data.name);
      return true;
    }
    addLog("Reddit post failed", data.json?.errors);
    return false;
  } catch (e) {
    addLog("Reddit post error: " + e.message);
    return false;
  }
}

// ── TELEGRAM FETCH ────────────────────────────────────────────────────────────
async function fetchTelegram(addLog) {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) { addLog("Telegram: no bot token"); return []; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50&timeout=0`);
    const data = await res.json();
    if (!data.ok || !data.result?.length) return [];

    const signals = [];
    for (const update of data.result) {
      const msg = update.message || update.channel_post;
      if (!msg?.text) continue;
      const text = msg.text.toLowerCase();
      if (KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
        signals.push({
          id: "tg-" + update.update_id,
          platform: "telegram",
          user: msg.from?.username ? "@" + msg.from.username : (msg.chat?.title || "Telegram"),
          followers: 0,
          text: msg.text,
          engagement: 0,
          chatId: msg.chat.id,
          messageId: msg.message_id,
        });
      }
    }

    // Advance offset to not reprocess
    if (data.result.length > 0) {
      const lastId = data.result[data.result.length - 1].update_id;
      await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastId + 1}&limit=1`);
    }
    return signals;
  } catch (e) {
    addLog("Telegram fetch error: " + e.message);
    return [];
  }
}

// ── TELEGRAM POST ─────────────────────────────────────────────────────────────
async function postToTelegram(signal, draft, addLog) {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) { addLog("Telegram: no bot token for posting"); return false; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: signal.chatId,
        text: draft,
        reply_to_message_id: signal.messageId,
      })
    });
    const data = await res.json();
    if (data.ok) { addLog("Telegram posted: " + data.result.message_id); return true; }
    addLog("Telegram post failed", data);
    return false;
  } catch (e) {
    addLog("Telegram post error: " + e.message);
    return false;
  }
}

// ── POST ROUTER ───────────────────────────────────────────────────────────────
async function post(signal, draft, addLog) {
  switch (signal.platform) {
    case "twitter":  return postToTwitter(signal, draft, addLog);
    case "reddit":   return postToReddit(signal, draft, addLog);
    case "telegram": return postToTelegram(signal, draft, addLog);
    default: addLog("Unknown platform: " + signal.platform); return false;
  }
}

// ── DEDUP / COOLDOWN HELPERS ──────────────────────────────────────────────────
async function isDuplicate(store, id) {
  try {
    const raw = await store.get("seen-ids");
    const seen = raw ? JSON.parse(raw) : [];
    return seen.includes(id);
  } catch { return false; }
}

async function markSeen(store, id) {
  try {
    const raw = await store.get("seen-ids");
    const seen = raw ? JSON.parse(raw) : [];
    seen.push(id);
    await store.set("seen-ids", JSON.stringify(seen.slice(-1000)));
  } catch {}
}

async function isOnCooldown(store, user, platform) {
  try {
    const key = `cooldown-${platform}-${user.replace(/[^a-z0-9]/gi, "")}`;
    const raw = await store.get(key);
    if (!raw) return false;
    const ts = parseInt(raw);
    return (Date.now() - ts) < (COOLDOWN_HOURS * 60 * 60 * 1000);
  } catch { return false; }
}

async function setCooldown(store, user, platform) {
  try {
    const key = `cooldown-${platform}-${user.replace(/[^a-z0-9]/gi, "")}`;
    await store.set(key, String(Date.now()));
  } catch {}
}

async function saveToHistory(store, item) {
  try {
    const raw = await store.get("post-history");
    const history = raw ? JSON.parse(raw) : [];
    history.unshift(item);
    await store.set("post-history", JSON.stringify(history.slice(0, 200)));
  } catch {}
}

async function saveLog(store, log) {
  try {
    const raw = await store.get("agent-logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift({ runAt: new Date().toISOString(), entries: log });
    await store.set("agent-logs", JSON.stringify(logs.slice(0, 50)));
  } catch {}
}

// ── OAUTH 1.0a HELPER (for Twitter write API) ─────────────────────────────────
function buildOAuth1Header(method, url, params, consumerKey, consumerSecret, token, tokenSecret) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: "1.0",
  };

  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`
  ).join("&");

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams)
  ].join("&");

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams).sort().map(k =>
    `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`
  ).join(", ");

  return `OAuth ${headerParts}`;
}

export const config = {
  schedule: "*/30 * * * *"  // every 30 minutes
};
