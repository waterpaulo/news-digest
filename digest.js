/**
 * Daily News Digest — Automated
 * One focused web search per topic (accurate, rate-limit safe),
 * summarized by Claude Sonnet, sent via Gmail OAuth2.
 */

require("dotenv").config();
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  recipientEmail: process.env.RECIPIENT_EMAIL,
  timezone: process.env.TIMEZONE || "America/New_York",
  language: process.env.LANGUAGE || "en",
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  gmailClientId: process.env.GMAIL_CLIENT_ID,
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN,
  senderEmail: process.env.SENDER_EMAIL,
  topics: (process.env.TOPICS || "General news,Politics,Tech & Science,Business,Culture & Sports").split(","),
};

// ─── Memory ───────────────────────────────────────────────────────────────────
const MEMORY_FILE = path.join("/tmp", "digest_memory.json");
const MEMORY_DAYS = 7;

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
      const cutoff = Date.now() - MEMORY_DAYS * 24 * 60 * 60 * 1000;
      return data.filter((e) => e.timestamp > cutoff);
    }
  } catch (e) {}
  return [];
}

function saveMemory(memory, newTitles) {
  const now = Date.now();
  const updated = [...memory, ...newTitles.map((t) => ({ title: t, timestamp: now }))];
  const cutoff = now - MEMORY_DAYS * 24 * 60 * 60 * 1000;
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(updated.filter((e) => e.timestamp > cutoff), null, 2));
  } catch (e) {}
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fetch one topic via Claude + web search ──────────────────────────────────
async function fetchTopic(topic, pastTitles, today) {
  const exclusion = pastTitles.length > 0
    ? `Avoid these recent stories: ${pastTitles.slice(0, 10).join("; ")}.`
    : "";

  const isfrench = topic === "General news" ? "Include both French and world news." : "";
  const geoHint = ["Politics", "General news"].includes(topic)
    ? "Include at least one story from France."
    : "";

  const prompt = `Search the web for today's top 3 news stories about "${topic}" (${today}).
${isfrench} ${geoHint} ${exclusion}

Return ONLY valid JSON, no markdown, no explanation:
{
  "items": [
    {
      "title": "Headline",
      "summary": "2-3 sentence summary with key facts and context.",
      "geo": "france",
      "source": "Source name",
      "url": "https://..."
    }
  ]
}

Rules: geo must be "france" or "world". 3 items. Real news from today or yesterday. JSON only.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  let jsonText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON for topic: " + topic);

  const parsed = JSON.parse(jsonText.slice(start, end + 1));
  return parsed.items || [];
}

// ─── Fetch all topics sequentially (rate-limit safe) ─────────────────────────
async function fetchAllTopics(pastTitles) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const sections = [];

  for (const topic of CONFIG.topics) {
    console.log(`  Fetching: ${topic}...`);
    try {
      const items = await fetchTopic(topic, pastTitles, today);
      if (items.length > 0) {
        sections.push({ topic, items });
        console.log(`  ✓ ${topic}: ${items.length} stories`);
      }
    } catch (e) {
      console.log(`  ✗ ${topic}: ${e.message}`);
    }
    // Wait 25s between topics to stay well under rate limits
    if (CONFIG.topics.indexOf(topic) < CONFIG.topics.length - 1) {
      console.log(`  Waiting 25s before next topic...`);
      await sleep(25000);
    }
  }

  return {
    date: today,
    sections,
  };
}

// ─── Build HTML email ─────────────────────────────────────────────────────────
function buildEmail(digest) {
  const topicIcons = {
    "General news": "📰", "Politics": "🏛️",
    "Tech & Science": "🔬", "Business": "📈", "Culture & Sports": "🎭",
  };

  const sectionHtml = digest.sections.map((section) => {
    const icon = topicIcons[section.topic] || "📌";
    const itemsHtml = section.items.map((item) => {
      const geoLabel = item.geo === "france" ? "🇫🇷 France" : "🌍 World";
      const titleHtml = item.url
        ? `<a href="${item.url}" style="color:#3C3489;text-decoration:none;">${item.title}</a>`
        : item.title;
      return `
        <tr><td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
          <div style="margin-bottom:4px;">
            <span style="font-size:11px;background:${item.geo === "france" ? "#E6F1FB" : "#EAF3DE"};color:${item.geo === "france" ? "#0C447C" : "#27500A"};padding:2px 8px;border-radius:10px;font-weight:500;">${geoLabel}</span>
            <span style="font-size:11px;color:#888;margin-left:6px;">${item.source || ""}</span>
          </div>
          <div style="font-weight:600;font-size:15px;color:#1a1a1a;margin-bottom:4px;">${titleHtml}</div>
          <div style="font-size:14px;color:#555;line-height:1.6;">${item.summary}</div>
        </td></tr>`;
    }).join("");
    return `
      <tr><td style="padding:24px 0 8px;">
        <h2 style="margin:0;font-size:17px;color:#1a1a1a;font-weight:600;">${icon} ${section.topic}</h2>
      </td></tr>
      <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">${itemsHtml}</table></td></tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f0;padding:32px 16px;">
    <tr><td><table width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;width:100%;">
      <tr><td style="background:#3C3489;border-radius:12px 12px 0 0;padding:28px 32px;">
        <div style="font-size:22px;font-weight:700;color:#fff;">📰 Daily Digest</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.75);margin-top:4px;">${digest.date}</div>
      </td></tr>
      <tr><td style="background:#fff;padding:8px 32px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${sectionHtml}</table>
      </td></tr>
      <tr><td style="background:#f0eff8;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#888;">Automated digest · Sent daily at 8:30am EST</p>
      </td></tr>
    </table></td></tr>
  </table>
</body></html>`;
}

// ─── Send via Gmail OAuth2 ────────────────────────────────────────────────────
async function sendViaGmail(subject, htmlBody) {
  const oauth2Client = new google.auth.OAuth2(
    CONFIG.gmailClientId, CONFIG.gmailClientSecret,
    "https://developers.google.com/oauthplayground"
  );
  oauth2Client.setCredentials({ refresh_token: CONFIG.gmailRefreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const message = [
    `From: "News Digest" <${CONFIG.senderEmail}>`,
    `To: ${CONFIG.recipientEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(htmlBody).toString("base64"),
  ].join("\r\n");

  const encoded = Buffer.from(message).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toLocaleString("en-US", { timeZone: CONFIG.timezone });
  console.log(`[${now}] Starting news digest...`);

  const memory = loadMemory();
  const pastTitles = memory.map((e) => e.title);
  console.log(`  Loaded ${pastTitles.length} past headlines to avoid`);

  console.log(`  Fetching ${CONFIG.topics.length} topics (15s apart to avoid rate limits)...`);
  const digest = await fetchAllTopics(pastTitles);
  console.log(`  Got ${digest.sections.length} sections`);

  if (digest.sections.length === 0) throw new Error("No sections fetched");

  const newTitles = digest.sections.flatMap((s) => s.items.map((i) => i.title));
  saveMemory(memory, newTitles);

  console.log("  Building HTML email...");
  const html = buildEmail(digest);

  console.log("  Sending via Gmail...");
  await sendViaGmail(`📰 Daily Digest — ${digest.date}`, html);

  console.log(`  Done! Sent to ${CONFIG.recipientEmail}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
