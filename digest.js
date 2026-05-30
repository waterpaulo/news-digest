/**
 * Daily News Digest — Automated
 * Fetches news via Claude AI (with web search),
 * formats a rich HTML email, and sends it via Gmail OAuth2.
 * Designed to be triggered by Railway Cron Job.
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
  summaryLength: process.env.SUMMARY_LENGTH || "detailed",
  topics: (process.env.TOPICS || "General news,Politics,Tech & Science,Business,Culture & Sports").split(","),
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  gmailClientId: process.env.GMAIL_CLIENT_ID,
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN,
  senderEmail: process.env.SENDER_EMAIL,
};

// ─── Memory: store & load past headlines (last 7 days) ───────────────────────
const MEMORY_FILE = path.join("/tmp", "digest_memory.json");
const MEMORY_DAYS = 7;

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
      const cutoff = Date.now() - MEMORY_DAYS * 24 * 60 * 60 * 1000;
      return data.filter((entry) => entry.timestamp > cutoff);
    }
  } catch (e) {
    console.log("  Could not load memory, starting fresh.");
  }
  return [];
}

function saveMemory(memory, newTitles) {
  const now = Date.now();
  const newEntries = newTitles.map((title) => ({ title, timestamp: now }));
  const updated = [...memory, ...newEntries];
  const cutoff = now - MEMORY_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = updated.filter((e) => e.timestamp > cutoff);
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(trimmed, null, 2));
    console.log(`  Memory updated (${trimmed.length} headlines stored)`);
  } catch (e) {
    console.log("  Could not save memory:", e.message);
  }
}

// ─── Fetch news via Claude + web search ──────────────────────────────────────
async function fetchDigest(pastHeadlines) {
  const langLabel = CONFIG.language === "fr" ? "French" : CONFIG.language === "en" ? "English" : "French and English";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const exclusionBlock = pastHeadlines.length > 0
    ? `Do NOT repeat these recent headlines:\n${pastHeadlines.map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const prompt = `You are a news digest assistant. Search the web for the most recent news from France and worldwide on these topics: ${CONFIG.topics.join(", ")}.

Use the most recent articles you can find from the past 48 hours.
${exclusionBlock}
You MUST respond with ONLY a valid JSON object. Do not write any explanation, apology, or text outside the JSON. Always return JSON no matter what.

Format:
{
  "date": "${today}",
  "sections": [
    {
      "topic": "General news",
      "items": [
        {
          "title": "Headline",
          "summary": "Two to three sentence summary with context and significance.",
          "geo": "france",
          "source": "Source name",
          "url": "https://example.com"
        }
      ]
    }
  ]
}

Rules:
- geo = "france" for French news, "world" for international
- 3 items per section
- All text in ${langLabel}
- Valid JSON only, no prose, no apologies, no markdown`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  let jsonText = "";
  for (const block of data.content) {
    if (block.type === "text") jsonText += block.text;
  }

  console.log("  Raw response length:", jsonText.length);
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.log("  Full response:", jsonText.slice(0, 300));
    throw new Error("No JSON found in response");
  }

  return JSON.parse(jsonText.slice(start, end + 1));
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
        <p style="margin:0;font-size:12px;color:#888;">Automated digest · ${CONFIG.topics.join(" · ")}</p>
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
  const pastHeadlines = memory.map((e) => e.title);
  console.log(`  Loaded ${pastHeadlines.length} past headlines to avoid`);

  console.log("  Fetching news via Claude + web search...");
  const digest = await fetchDigest(pastHeadlines);
  console.log(`  Got ${digest.sections.length} sections`);

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
