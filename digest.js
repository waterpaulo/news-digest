/**
 * Daily News Digest — Automated
 * Fetches French & world news via Claude AI (with web search),
 * formats a rich HTML email, and sends it via Gmail OAuth2.
 */

require("dotenv").config();
const cron = require("node-cron");
const { google } = require("googleapis");

// ─── Config (loaded from .env) ───────────────────────────────────────────────
const CONFIG = {
  recipientEmail: process.env.RECIPIENT_EMAIL,
  sendTime: process.env.SEND_TIME || "07:00",       // HH:MM in local TZ
  timezone: process.env.TIMEZONE || "Europe/Paris",
  language: process.env.LANGUAGE || "fr",           // fr | en | both
  summaryLength: process.env.SUMMARY_LENGTH || "concise", // concise | detailed
  topics: (process.env.TOPICS || "General news,Politics,Tech & Science,Business,Culture & Sports").split(","),
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  // Gmail OAuth2
  gmailClientId: process.env.GMAIL_CLIENT_ID,
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: process.env.GMAIL_REFRESH_TOKEN,
  senderEmail: process.env.SENDER_EMAIL,
};

// ─── Cron schedule from SEND_TIME ────────────────────────────────────────────
function buildCron(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return `${m} ${h} * * *`;
}

// ─── Step 1: Fetch news via Claude + web search ───────────────────────────────
async function fetchDigest() {
  const langLabel =
    CONFIG.language === "fr" ? "French"
    : CONFIG.language === "en" ? "English"
    : "French and English";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const prompt = `You are a professional news editor creating a ${CONFIG.summaryLength} daily digest for ${today}.

Search the web for today's top news from France and worldwide covering these topics: ${CONFIG.topics.join(", ")}.

Return ONLY valid JSON — no markdown, no preamble, no backticks — in exactly this structure:
{
  "date": "${today}",
  "sections": [
    {
      "topic": "Topic name",
      "items": [
        {
          "title": "Headline",
          "summary": "1-2 sentence factual summary.",
          "geo": "france",
          "source": "Source name",
          "url": "https://..."
        }
      ]
    }
  ]
}

Rules:
- Include 3-5 items per topic section
- geo must be exactly "france" or "world"
- Use ${langLabel} for all titles and summaries
- Keep summaries neutral and factual
- Include real source names and URLs when available`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
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

  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in response");

  return JSON.parse(jsonText.slice(start, end + 1));
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
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f0;padding:32px 16px;">
    <tr><td>
      <table width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#3C3489;border-radius:12px 12px 0 0;padding:28px 32px;">
          <div style="font-size:22px;font-weight:700;color:#fff;">📰 Digest quotidien</div>
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
            Digest automatique · Topics: ${CONFIG.topics.join(" · ")}<br>
            Envoyé à ${CONFIG.sendTime} (${CONFIG.timezone})
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

// ─── Main job ─────────────────────────────────────────────────────────────────
async function runDigest() {
  const now = new Date().toLocaleString("fr-FR", { timeZone: CONFIG.timezone });
  console.log(`\n[${now}] 🚀 Starting news digest...`);

  try {
    console.log("  ① Fetching news via Claude + web search...");
    const digest = await fetchDigest();
    console.log(`  ✓ Got ${digest.sections.length} sections`);

    console.log("  ② Building HTML email...");
    const html = buildEmail(digest);

    const subject = `📰 Digest — ${digest.date}`;
    console.log("  ③ Sending via Gmail...");
    await sendViaGmail(subject, html);

    console.log(`  ✓ Digest sent to ${CONFIG.recipientEmail}`);
  } catch (err) {
    console.error("  ✗ Error:", err.message);
    process.exit(1);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (process.env.RUN_NOW === "true") {
  // Run immediately (for testing)
  runDigest();
} else {
  // Schedule daily
  const cronExpr = buildCron(CONFIG.sendTime);
  console.log(`📅 Digest scheduled at ${CONFIG.sendTime} (${CONFIG.timezone})`);
  console.log(`   Cron: ${cronExpr}`);
  console.log(`   Recipient: ${CONFIG.recipientEmail}`);
  console.log(`   Topics: ${CONFIG.topics.join(", ")}`);
  console.log(`\n   Set RUN_NOW=true to test immediately.\n`);

  cron.schedule(cronExpr, runDigest, { timezone: CONFIG.timezone });
}
