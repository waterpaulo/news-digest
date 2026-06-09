/**
 * Daily News Digest — Automated
 * Fetches headlines from free RSS feeds (zero API tokens),
 * summarizes with Claude Haiku (cheap, fast, low token usage),
 * sends via Resend (never expires).
 */

require("dotenv").config();
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  recipientEmail: process.env.RECIPIENT_EMAIL,
  senderEmail: process.env.SENDER_EMAIL,
  timezone: process.env.TIMEZONE || "America/New_York",
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  resendKey: process.env.RESEND_API_KEY,
  topics: (process.env.TOPICS || "General news,Politics,Tech & Science,Business,Culture & Sports").split(","),
};

// ─── RSS Sources ──────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://www.lemonde.fr/rss/une.xml",                          geo: "france", topic: "General news",   source: "Le Monde" },
  { url: "https://www.lefigaro.fr/rss/figaro_actualites.xml",           geo: "france", topic: "Politics",       source: "Le Figaro" },
  { url: "https://www.lesechos.fr/rss/rss_une.xml",                     geo: "france", topic: "Business",       source: "Les Echos" },
  { url: "https://www.france24.com/fr/rss",                             geo: "france", topic: "General news",   source: "France 24" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml",                 geo: "world",  topic: "General news",   source: "BBC News" },
  { url: "https://feeds.bbci.co.uk/news/technology/rss.xml",            geo: "world",  topic: "Tech & Science", source: "BBC Tech" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml",              geo: "world",  topic: "Business",       source: "BBC Business" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",      geo: "world",  topic: "Politics",       source: "NY Times" },
  { url: "https://feeds.feedburner.com/TechCrunch",                     geo: "world",  topic: "Tech & Science", source: "TechCrunch" },
  { url: "https://www.wired.com/feed/rss",                              geo: "world",  topic: "Tech & Science", source: "Wired" },
  { url: "https://feeds.bloomberg.com/markets/news.rss",                geo: "world",  topic: "Business",       source: "Bloomberg" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml",       geo: "world",  topic: "Culture & Sports", source: "NY Times Arts" },
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

// ─── Step 1: Fetch RSS headlines (zero token cost) ────────────────────────────
async function fetchRSSHeadlines(pastTitles) {
  const headlines = [];
  const seen = new Set(pastTitles.map(t => t.toLowerCase().slice(0, 30)));

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigest/1.0)" },
        signal: AbortSignal.timeout(6000),
      });
      const xml = await res.text();

      let count = 0;
      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      for (const match of itemMatches) {
        if (count >= 2) break;
        const block = match[1];
        const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
        const descMatch = block.match(/<description[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/s);
        // Try multiple URL patterns in RSS
        const linkMatch = block.match(/<link>(?:<!\[CDATA\[)?(https?:\/\/[^\]<\s]+)/) ||
                          block.match(/<link[^>]+href="(https?:\/\/[^"]+)"/) ||
                          block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/);

        const title = (titleMatch?.[1] || "").replace(/<[^>]+>/g, "").trim();
        const desc = (descMatch?.[1] || "").replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').trim().slice(0, 200);
        const url = (linkMatch?.[1] || linkMatch?.[2] || "").trim();

        if (!title || seen.has(title.toLowerCase().slice(0, 30))) continue;
        seen.add(title.toLowerCase().slice(0, 30));

        headlines.push({ title, description: desc, url, geo: feed.geo, topic: feed.topic, source: feed.source });
        count++;
      }
      console.log(`  RSS ${feed.source}: ${count} items`);
    } catch (e) {
      console.log(`  RSS ${feed.source}: failed`);
    }
  }

  return headlines;
}

// ─── Step 2: Summarize with Haiku (tiny token usage) ─────────────────────────
async function summarize(headlines, today) {
  // Group by topic, max 3 per topic
  const byTopic = {};
  for (const item of headlines) {
    if (!byTopic[item.topic]) byTopic[item.topic] = [];
    if (byTopic[item.topic].length < 3) byTopic[item.topic].push(item);
  }
  // Fill missing topics
  for (const topic of CONFIG.topics) {
    if (!byTopic[topic]?.length) {
      const fallback = Object.values(byTopic).flat().filter(i => !Object.values(byTopic).flat().includes(i));
      byTopic[topic] = fallback.slice(0, 2);
    }
  }

  // Minimal input to keep Haiku fast
  const inputText = CONFIG.topics
    .filter(t => byTopic[t]?.length > 0)
    .map(t => `TOPIC: ${t}\n` + byTopic[t].slice(0,2).map((i,n) =>
      `${n+1}. [${i.geo}][${i.source}][url:${i.url}] ${i.title}. ${i.description}`
    ).join("\n"))
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      messages: [{
        role: "user",
        content: `Write a 3-4 sentence detailed summary for each news item. Include key facts, context, and why it matters. IMPORTANT: preserve the exact [url:...] value for each item in the url field. Return ONLY valid JSON, no markdown:
{"date":"${today}","sections":[{"topic":"General news","items":[{"title":"exact original headline","summary":"3-4 detailed sentences with full context.","geo":"france","source":"source name","url":"exact url from [url:...] tag"}]}]}

News items:
${inputText}`
      }],
    }),
  });

  if (!res.ok) throw new Error(`Haiku error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  let jsonText = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  console.log("  Haiku response:", jsonText.length, "chars");
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const s = jsonText.indexOf("{"), e = jsonText.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON from Haiku: " + jsonText.slice(0, 200));
  return JSON.parse(jsonText.slice(s, e + 1));
}

// ─── Step 3: Build HTML email ─────────────────────────────────────────────────
function buildEmail(digest) {
  const icons = {"General news":"📰","Politics":"🏛️","Tech & Science":"🔬","Business":"📈","Culture & Sports":"🎭"};
  const sectionHtml = digest.sections.map(section => {
    const itemsHtml = section.items.map(item => {
      const geo = item.geo === "france" ? "🇫🇷 France" : "🌍 World";
      const titleHtml = item.url ? `<a href="${item.url}" style="color:#3C3489;text-decoration:none;">${item.title}</a>` : item.title;
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
        <div style="margin-bottom:4px;">
          <span style="font-size:11px;background:${item.geo==="france"?"#E6F1FB":"#EAF3DE"};color:${item.geo==="france"?"#0C447C":"#27500A"};padding:2px 8px;border-radius:10px;font-weight:500;">${geo}</span>
          <span style="font-size:11px;color:#888;margin-left:6px;">${item.source||""}</span>
        </div>
        <div style="font-weight:600;font-size:15px;color:#1a1a1a;margin-bottom:4px;">${titleHtml}</div>
        <div style="font-size:14px;color:#555;line-height:1.6;">${item.summary}</div>
      </td></tr>`;
    }).join("");
    return `<tr><td style="padding:24px 0 8px;"><h2 style="margin:0;font-size:17px;color:#1a1a1a;">${icons[section.topic]||"📌"} ${section.topic}</h2></td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">${itemsHtml}</table></td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
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
</table></td></tr></table></body></html>`;
}

// ─── Step 4: Send via Resend ──────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const resend = new Resend(CONFIG.resendKey);
  const recipients = CONFIG.recipientEmail.split(",").map(e => e.trim());
  const { error } = await resend.emails.send({
    from: `News Digest <${CONFIG.senderEmail}>`,
    to: recipients,
    subject,
    html,
  });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  console.log(`  Sent to ${recipients.join(", ")}`);
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
  const pastTitles = memory.map(e => e.title);
  console.log(`  Loaded ${pastTitles.length} past headlines to avoid`);

  console.log("  Step 1: Fetching RSS headlines...");
  const headlines = await fetchRSSHeadlines(pastTitles);
  console.log(`  Got ${headlines.length} headlines total`);
  if (!headlines.length) throw new Error("No headlines fetched from RSS");

  console.log("  Step 2: Summarizing with Haiku...");
  const digest = await summarize(headlines, today);
  console.log(`  Got ${digest.sections.length} sections`);

  saveMemory(memory, digest.sections.flatMap(s => s.items.map(i => i.title)));

  console.log("  Step 3: Sending via Resend...");
  await sendEmail(`📰 Daily Digest — ${digest.date}`, buildEmail(digest));

  console.log("  Done!");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
