/**
 * Daily News Digest — Automated
 * Fetches French & world news via Claude AI (with web search),
 * formats a rich HTML email, and sends it via Gmail OAuth2.
 * Includes 7-day memory to avoid repeating headlines.
 */

require("dotenv").config();
const cron = require("node-cron");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ─── Config (loaded from .env) ───────────────────────────────────────────────
const CONFIG = {
  recipientEmail: process.env.RECIPIENT_EMAIL,
  sendTime: process.env.SEND_TIME || "08:30",
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
      // Only keep last MEMORY_DAYS days
      const cutoff = Date.now() - MEMORY_DAYS * 24 * 60 * 60 * 1000;
      return data.filter((entry) => entry.timestamp > cutoff);
    }
  } catch (e) {
    console.log("  ⚠ Could not load memory, starting fresh.");
  }
  return [];
}

function saveMemory(memory, newTitles) {
  const now = Date.now();
  const newEntries = newTitles.map((title) => ({ title, timestamp: now }));
  const updated = [...memory, ...newEntries];
  // Keep only last MEMORY_DAYS days
  const cutoff = now - MEMORY_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = updated.filter((e) => e.timestamp > cutoff);
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(trimmed, null, 2));
    console.log(`  ✓ Memory updated (${trimmed.length} headlines stored)`);
  } catch (e) {
    console.log("  ⚠ Could not save memory:", e.message);
  }
}

// ─── Cron schedule from SEND_TIME ────────────────────────────────────────────
function buildCron(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return `${m} ${h} * * *`;
}

// ─── Step 1: Fetch news via Claude + web search ───────────────────────────────
async function fetchDigest(pastHeadlines) {
  const langLabel =
    CONFIG.language === "fr" ? "French"
    : CONFIG.language === "en" ? "English"
    : "French and English";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const exclusionBlock = pastHeadlines.length > 0
    ? `\nIMPORTANT — Do NOT include any story that is the same or very similar to these headlines from the past ${MEMORY_DAYS} days:\n${pastHeadlines.map((t) => `- ${t}`).join("\n")}\nPrioritize fresh, new developments only.\n`
    : "";

  const prompt = `You are a news editor. Search the web for today's top news (${today}) from France and worldwide.

Topics to cover: ${CONFIG.topics.join(", ")}.
${exclusionBlock}
CRITICAL: Respond with ONLY a JSON object. No text before or after. No markdown. No backticks.

The JSON must follow this exact format:
{
  "date": "${today}",
  "sections": [
    {
      "topic": "General news",
      "items": [
        {
          "title": "News headline here",
          "summary": "Two sentence summary of the story with key context.",
          "geo": "france",
          "source": "Le Monde",
          "url": "https://example.com"
        },
        {
          "title": "Another headline",
          "summary": "Two sentence summary here.",
          "geo": "world",
          "source": "Reuters",
          "url": "https://example.com"
        }
      ]
    }
  ]
}

Important rules:
- geo must be exactly the string "france" or the string "world", nothing else
- Include exactly 3 items per topic section
- Write all text in ${langLabel}
- Only include real news from today
- The entire response must be valid JSON only`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
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

  // Log raw response for debugging
  console.log("  📋 Raw response length:", jsonText.length);
  console.log("  📋 First 300 chars:", jsonText.slice(0, 300));

  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.log("  📋 Full response:", jsonText.slice(0, 500));
    throw new Error("No JSON found in response");
  }

  const jsonSlice = jsonText.slice(start, end + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch(parseErr) {
    console.log("  📋 JSON parse error at:", parseErr.message);
    console.log("  📋 JSON around error:", jsonSlice.slice(Math.max(0, parseInt(parseErr.message.match(/position (\d+)/)?.[1] || 0) - 50), parseInt(parseErr.message.match(/position (\d+)/)?.[1] || 0) + 50));
    throw parseErr;
  }
}

// ─── Step 2: Build HTML email ─────────────────────────────────────────────────
function buildEmail(digest) {
  const topicIcons = {
    "General news": "📰",
    "Politics": "🏛️",
    "Tech & Science": "🔬",
    "Business": "📈",
    "Culture & Sports": "🎭",
  };

  const sectionHtml = digest.sections.map((section) => {
    const icon = topicIcons[section.topic] || "📌";
    const itemsHtml = section.items.map((item) => {
      const geoLabel = item.geo === "france" ? "🇫🇷 France" : "🌍 World";
      const titleHtml = item.url
        ? `<a href="${item.url}" style="color:#3C3489;text-decoration:none;">${item.title}</a>`
        : item.title;
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-size:11px;background:${item.geo === "france" ? "#E6F1FB" : "#EAF3DE"};color:${item.geo === "france" ? "#0C447C" : "#27500A"};padding:2px 8px;border-radius:10px;font-weight:500;">${geoLabel}</span>
              <span style="font-size:11px;color:#888;">${item.source || ""}</span>
            </div>
            <div style="font-weight:600;font-size:15px;color:#1a1a1a;margin-bottom:4px;">${titleHtml}</div>
            <div style="font-size:14px;color:#555;line-height:1.6;">${item.summary}</div>
          </td>
        </tr>`;
    }).join("");

    return `
      <tr><td style="padding:24px 0 8px;">
        <h2 style="margin:0;font-size:17px;color:#1a1a1a;font-weight:600;">${icon} ${section.topic}</h2>
      </td></tr>
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${itemsHtml}
        </table>
      </td></tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f0;padding:32px 16px;">
    <tr><td>
      <table width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#3C3489;border-radius:12px 12px 0 0;padding:28px 32px;">
          <div style="font-size:22px;font-weight:700;color:#fff;">📰 Daily Digest</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.75);margin-top:4px;">${digest.date}</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#fff;padding:8px 32px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${sectionHtml}
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f0eff8;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#888;">
            Automated digest · Topics: ${CONFIG.topics.join(" · ")}<br>
            Sent daily at ${CONFIG.sendTime} (${CONFIG.timezone})
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Step 3: Send via Gmail OAuth2 ───────────────────────────────────────────
async function sendViaGmail(subject, htmlBody) {
  const oauth2Client = new google.auth.OAuth2(
    CONFIG.gmailClientId,
    CONFIG.gmailClientSecret,
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

  const encoded = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
}

// ─── Retry helper ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delayMs = 60000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`  ⚠ Attempt ${attempt} failed: ${err.message}`);
      console.log(`  ↻ Retrying in ${delayMs / 1000}s... (${attempt}/${retries})`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

// ─── Main job ─────────────────────────────────────────────────────────────────
async function runDigest() {
  const now = new Date().toLocaleString("en-US", { timeZone: CONFIG.timezone });
  console.log(`\n[${now}] 🚀 Starting news digest...`);

  try {
    // Load memory of past headlines
    const memory = loadMemory();
    const pastHeadlines = memory.map((e) => e.title);
    console.log(`  ✓ Loaded ${pastHeadlines.length} past headlines to avoid`);

    console.log("  ① Fetching news via Claude + web search...");
    const digest = await withRetry(() => fetchDigest(pastHeadlines));
    console.log(`  ✓ Got ${digest.sections.length} sections`);

    // Extract new titles and save to memory
    const newTitles = digest.sections.flatMap((s) => s.items.map((i) => i.title));
    saveMemory(memory, newTitles);

    console.log("  ② Building HTML email...");
    const html = buildEmail(digest);

    const subject = `📰 Daily Digest — ${digest.date}`;
    console.log("  ③ Sending via Gmail...");
    await withRetry(() => sendViaGmail(subject, html));

    console.log(`  ✓ Digest sent to ${CONFIG.recipientEmail}`);
  } catch (err) {
    // Log error but do NOT exit — keep the scheduler alive for tomorrow
    console.error(`  ✗ Failed after all retries: ${err.message}`);
    console.error("  ℹ Scheduler still running — will retry tomorrow.");
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (process.env.RUN_NOW === "true") {
  // Run once then switch to normal daily schedule so Railway doesn't restart loop
  runDigest().then(() => {
    console.log("\n✓ Test run complete. Switching to daily schedule...");
    const cronExpr = buildCron(CONFIG.sendTime);
    console.log(`📅 Digest scheduled at ${CONFIG.sendTime} (${CONFIG.timezone})`);
    console.log(`   Next send: tomorrow at ${CONFIG.sendTime}\n`);
    cron.schedule(cronExpr, runDigest, { timezone: CONFIG.timezone });
  });
} else {
  const cronExpr = buildCron(CONFIG.sendTime);
  console.log(`📅 Digest scheduled at ${CONFIG.sendTime} (${CONFIG.timezone})`);
  console.log(`   Cron: ${cronExpr}`);
  console.log(`   Recipient: ${CONFIG.recipientEmail}`);
  console.log(`   Topics: ${CONFIG.topics.join(", ")}`);
  console.log(`   Memory: last ${MEMORY_DAYS} days of headlines tracked\n`);

  cron.schedule(cronExpr, runDigest, { timezone: CONFIG.timezone });
}
