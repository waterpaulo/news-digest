/**
 * Daily News Digest — Automated
 * Fetches headlines via FREE RSS feeds (no token cost),
 * summarizes with Claude (minimal tokens),
 * sends via Gmail OAuth2.
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
};

// ─── RSS Feed Sources ─────────────────────────────────────────────────────────
const RSS_FEEDS = [
  // France
  { url: "https://www.lemonde.fr/rss/une.xml",          topic: "General news",     geo: "france", source: "Le Monde" },
  { url: "https://www.lefigaro.fr/rss/figaro_actualites.xml", topic: "General news", geo: "france", source: "Le Figaro" },
  { url: "https://www.france24.com/fr/rss",             topic: "Politics",         geo: "france", source: "France 24" },
  { url: "https://www.lesechos.fr/rss/rss_une.xml",     topic: "Business",         geo: "france", source: "Les Echos" },
  // World
  { url: "https://feeds.bbci.co.uk/news/rss.xml",       topic: "General news",     geo: "world",  source: "BBC News" },
  { url: "https://feeds.reuters.com/reuters/topNews",   topic: "General news",     geo: "world",  source: "Reuters" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", topic: "Politics", geo: "world", source: "NY Times" },
  { url: "https://feeds.feedburner.com/TechCrunch",     topic: "Tech & Science",   geo: "world",  source: "TechCrunch" },
  { url: "https://www.wired.com/feed/rss",              topic: "Tech & Science",   geo: "world",  source: "Wired" },
  { url: "https://feeds.bloomberg.com/markets/news.rss",topic: "Business",         geo: "world",  source: "Bloomberg" },
];

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

// ─── Step 1: Fetch RSS headlines ──────────────────────────────────────────────
async function fetchRSSHeadlines(pastTitles) {
  const allItems = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // last 48 hours

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigest/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      const xml = await res.text();

      // Simple XML item parser
      const items = [];
      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      for (const match of itemMatches) {
        const block = match[1];
        const title = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/)?.[1] || block.match(/<title[^>]*>(.*?)<\/title>/)?.[1] || "";
        const desc = block.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>|<description[^>]*>(.*?)<\/description>/)?.[1] || "";
        const link = block.match(/<link>(.*?)<\/link>|<link[^>]*href="([^"]+)"/)?.[1] || "";
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";

        const cleanTitle = title.replace(/<[^>]+>/g, "").trim();
        const cleanDesc = desc.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim().slice(0, 300);

        if (!cleanTitle) continue;
        if (pastTitles.some((t) => t.toLowerCase().includes(cleanTitle.toLowerCase().slice(0, 20)))) continue;

        const pub = pubDate ? new Date(pubDate).getTime() : Date.now();
        if (pubDate && pub < cutoff) continue;

        items.push({ title: cleanTitle, description: cleanDesc, link, topic: feed.topic, geo: feed.geo, source: feed.source });
        if (items.length >= 3) break;
      }

      allItems.push(...items);
      console.log(`  RSS ${feed.source}: ${items.length} items`);
    } catch (e) {
      console.log(`  RSS ${feed.source}: failed (${e.message})`);
    }
  }

  return allItems;
}

// ─── Step 2: Summarize with Claude (minimal tokens) ──────────────────────────
async function summarizeWithClaude(headlines) {
  // Group by topic
  const byTopic = {};
  for (const item of headlines) {
    if (!byTopic[item.topic]) byTopic[item.topic] = [];
    if (byTopic[item.topic].length < 3) byTopic[item.topic].push(item);
  }

  const topics = Object.keys(byTopic);
  const inputText = topics.map((topic) =>
    `TOPIC: ${topic}\n` + byTopic[topic].map((i, n) =>
      `${n + 1}. [${i.geo}] ${i.source}: ${i.title}. ${i.description}`
    ).join("\n")
  ).join("\n\n");

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CONFIG.timezone,
  });

  const prompt = `Summarize these news headlines into a daily digest. For each item write a clear 2-sentence summary in English.

${inputText}

Return ONLY valid JSON:
{
  "date": "${today}",
  "sections": [
    {
      "topic": "Topic name",
      "items": [
        {"title": "headline", "summary": "2 sentence summary.", "geo": "france or world", "source": "source name", "url": ""}
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
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  let jsonText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log("  Claude response length:", jsonText.length);

  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in Claude response: " + jsonText.slice(0, 200));

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

  const memory = loadMemory();
  const pastTitles = memory.map((e) => e.title);
  console.log(`  Loaded ${pastTitles.length} past headlines to avoid`);

  console.log("  Fetching RSS headlines...");
  const headlines = await fetchRSSHeadlines(pastTitles);
  console.log(`  Got ${headlines.length} total headlines from RSS`);

  if (headlines.length === 0) throw new Error("No RSS headlines fetched");

  console.log("  Summarizing with Claude (no web search)...");
  const digest = await summarizeWithClaude(headlines);
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
