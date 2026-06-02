/**
 * Daily News Digest — Automated
 * 2 focused web searches (France + World) via Claude Sonnet,
 * summarized by Claude Haiku (cheap), sent via Gmail OAuth2.
 * Cost: ~$0.03/day (~$1/month)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Step 1: 2 web searches — France news + World news ───────────────────────
async function fetchRawNews(pastTitles, today) {
  const exclusion = pastTitles.length > 0
    ? `Avoid these recent stories: ${pastTitles.slice(0, 8).join("; ")}.`
    : "";

  const searches = [
    {
      label: "France",
      prompt: `Search for today's top 6 news headlines from France (${today}) covering politics, economy, general news, culture. ${exclusion} List them clearly with title, source, and a one sentence description.`
    },
    {
      label: "World",
      prompt: `Search for today's top 6 world news headlines (${today}) covering tech, science, business, international politics, culture. ${exclusion} List them clearly with title, source, and a one sentence description.`
    }
  ];

  const allItems = [];

  for (const search of searches) {
    console.log(`  Searching: ${search.label} news...`);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: search.prompt }],
        }),
      });

      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const data = await res.json();

      // Get the raw text response
      const rawText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      console.log(`  Raw ${search.label} (first 150):`, rawText.slice(0, 150));

      // Second call to Haiku to convert the text into JSON (cheap, no web search)
      const convertRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Convert this news list into a JSON array. Return ONLY the JSON array, nothing else, no markdown, no backticks.

Format: [{"title":"...","description":"one sentence","source":"...","url":"...","topic":"one of: General news, Politics, Tech & Science, Business, Culture & Sports"}]

News list:
${rawText}`
          }],
        }),
      });
      const convertData = await convertRes.json();
      let jsonText = convertData.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      jsonText = jsonText.replace(/\`\`\`json|\`\`\`/g, "").trim();
      const arrStart = jsonText.indexOf("[");
      const arrEnd = jsonText.lastIndexOf("]");
      if (arrStart === -1 || arrEnd === -1) throw new Error("Haiku could not convert to JSON");

      const items = JSON.parse(jsonText.slice(arrStart, arrEnd + 1));
      const geo = search.label === "France" ? "france" : "world";
      allItems.push(...items.map((i) => ({ ...i, geo })));
      console.log(`  ✓ ${search.label}: ${items.length} headlines`);
    } catch (e) {
      console.log(`  ✗ ${search.label}: ${e.message}`);
    }

    // Wait 20s between searches
    if (search.label !== searches[searches.length - 1].label) {
      console.log("  Waiting 20s...");
      await sleep(30000);
    }
  }

  console.log(`  All searches complete. Total headlines: ${allItems.length}`);
  return allItems;
}

// ─── Step 2: Summarize with Haiku (cheapest model) ───────────────────────────
async function summarizeWithHaiku(rawItems, today) {
  // Group by topic
  const byTopic = {};
  for (const item of rawItems) {
    const topic = item.topic || "General news";
    if (!byTopic[topic]) byTopic[topic] = [];
    if (byTopic[topic].length < 3) byTopic[topic].push(item);
  }

  // Fill missing topics with items from General news
  for (const topic of CONFIG.topics) {
    if (!byTopic[topic] || byTopic[topic].length === 0) {
      byTopic[topic] = (byTopic["General news"] || []).slice(0, 2);
    }
  }

  const inputText = CONFIG.topics
    .filter((t) => byTopic[t]?.length > 0)
    .map((topic) =>
      `TOPIC: ${topic}\n` +
      byTopic[topic].map((i, n) =>
        `${n + 1}. [${i.geo}] ${i.source}: ${i.title}. ${i.description || ""}`
      ).join("\n")
    ).join("\n\n");

  const prompt = `Write a 2-3 sentence news summary for each item below. Be factual, clear, and informative.

${inputText}

Return ONLY valid JSON:
{
  "date": "${today}",
  "sections": [
    {
      "topic": "Topic name",
      "items": [
        {
          "title": "original headline",
          "summary": "2-3 sentence summary with key facts and why it matters.",
          "geo": "france or world",
          "source": "source name",
          "url": "url or empty string"
        }
      ]
    }
  ]
}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Haiku API error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  let jsonText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log("  Haiku response length:", jsonText.length);
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON from Haiku: " + jsonText.slice(0, 200));

  return JSON.parse(jsonText.slice(start, end + 1));
}

// ─── Step 3: Build HTML email ─────────────────────────────────────────────────
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

// ─── Step 4: Send via Gmail OAuth2 ───────────────────────────────────────────
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

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const memory = loadMemory();
  const pastTitles = memory.map((e) => e.title);
  console.log(`  Loaded ${pastTitles.length} past headlines to avoid`);

  // Step 1: 2 web searches (Sonnet with web search)
  console.log("  Step 1: Fetching headlines via web search...");
  const rawItems = await fetchRawNews(pastTitles, today);
  console.log(`  Got ${rawItems.length} raw headlines`);
  if (rawItems.length === 0) throw new Error("No headlines fetched");

  // Check we have both France and world news
  const hasFrance = rawItems.some((i) => i.geo === "france");
  const hasWorld = rawItems.some((i) => i.geo === "world");
  if (!hasFrance) console.log("  ⚠ Warning: No France headlines fetched");
  if (!hasWorld) console.log("  ⚠ Warning: No World headlines fetched");
  if (!hasFrance && !hasWorld) throw new Error("Neither France nor World headlines fetched - aborting");

  // Step 2: Summarize (Haiku, no web search = cheap)
  console.log("  Step 2: Summarizing with Haiku...");
  const digest = await summarizeWithHaiku(rawItems, today);
  console.log(`  Got ${digest.sections.length} sections`);

  const newTitles = digest.sections.flatMap((s) => s.items.map((i) => i.title));
  saveMemory(memory, newTitles);

  // Step 3: Send
  console.log("  Step 3: Building & sending email...");
  const html = buildEmail(digest);
  await sendViaGmail(`📰 Daily Digest — ${digest.date}`, html);

  console.log(`  Done! Sent to ${CONFIG.recipientEmail}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
