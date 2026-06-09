/**
 * Daily News Digest — Automated
 * Fetches news via Claude Sonnet + web search,
 * summarized by Haiku, sent via Resend (no OAuth, never expires).
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

// ─── API call with auto-retry on rate limit ───────────────────────────────────
async function callAnthropic(body, attempt = 1) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  // Rate limit — wait and retry automatically
  if (res.status === 429) {
    if (attempt > 5) throw new Error("Rate limit: too many retries");
    const waitSec = attempt * 30; // 30s, 60s, 90s, 120s, 150s
    console.log(`  Rate limit hit. Waiting ${waitSec}s (attempt ${attempt}/5)...`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return callAnthropic(body, attempt + 1);
  }

  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.content || !Array.isArray(data.content)) {
    throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

// ─── Step 1: Fetch news via web search ───────────────────────────────────────
async function fetchRawNews(pastTitles, today) {
  const exclusion = pastTitles.length > 0
    ? `Avoid these recent stories: ${pastTitles.slice(0, 8).join("; ")}.`
    : "";

  const prompt = `Search the web for today's top news headlines (${today}). Find 6 headlines from France and 6 international headlines covering politics, economy, tech, business, culture, and sports. ${exclusion} List them with title, source, and one sentence description.`;

  console.log("  Searching: France & World news...");
  const data = await callAnthropic({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const rawText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`  Raw response (first 100):`, rawText.slice(0, 100));

  // Convert to structured JSON via Haiku
  const convertData = await callAnthropic({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: `Convert this news list to a JSON array. French stories: geo="france", international: geo="world". Return ONLY the JSON array, no markdown.
Format: [{"title":"...","description":"...","source":"...","url":"...","geo":"france or world","topic":"General news or Politics or Tech & Science or Business or Culture & Sports"}]
News: ${rawText.slice(0, 2000)}`
    }],
  });

  let jsonText = convertData.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const s = jsonText.indexOf("["), e = jsonText.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("Could not parse headlines JSON");

  const items = JSON.parse(jsonText.slice(s, e + 1));
  console.log(`  Got ${items.length} headlines (France: ${items.some(i => i.geo === "france")}, World: ${items.some(i => i.geo === "world")})`);
  return items;
}

// ─── Step 2: Summarize with Haiku ────────────────────────────────────────────
async function summarize(rawItems, today) {
  const byTopic = {};
  for (const item of rawItems) {
    const topic = item.topic || "General news";
    if (!byTopic[topic]) byTopic[topic] = [];
    if (byTopic[topic].length < 3) byTopic[topic].push(item);
  }
  for (const topic of CONFIG.topics) {
    if (!byTopic[topic]?.length) byTopic[topic] = (byTopic["General news"] || []).slice(0, 2);
  }

  const inputText = CONFIG.topics
    .filter((t) => byTopic[t]?.length > 0)
    .map((t) => `TOPIC: ${t}\n` + byTopic[t].map((i, n) => `${n+1}. [${i.geo}] ${i.source}: ${i.title}. ${i.description || ""}`).join("\n"))
    .join("\n\n");

  const data = await callAnthropic({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    messages: [{
      role: "user",
      content: `Write a 2-3 sentence summary for each news item. Return ONLY valid JSON:
{"date":"${today}","sections":[{"topic":"...","items":[{"title":"...","summary":"...","geo":"france or world","source":"...","url":"..."}]}]}

News items:
${inputText}`
    }],
  });

  let jsonText = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log("  Haiku response length:", jsonText.length);
  jsonText = jsonText.replace(/```json|```/g, "").trim();
  const s = jsonText.indexOf("{"), e = jsonText.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON from Haiku");
  return JSON.parse(jsonText.slice(s, e + 1));
}

// ─── Step 3: Build HTML email ─────────────────────────────────────────────────
function buildEmail(digest) {
  const icons = { "General news":"📰","Politics":"🏛️","Tech & Science":"🔬","Business":"📈","Culture & Sports":"🎭" };
  const sectionHtml = digest.sections.map((section) => {
    const itemsHtml = section.items.map((item) => {
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
async function sendEmail(subject, htmlBody, date) {
  const resend = new Resend(CONFIG.resendKey);
  const recipients = CONFIG.recipientEmail.split(",").map(e => e.trim());

  const { error } = await resend.emails.send({
    from: `News Digest <${CONFIG.senderEmail}>`,
    to: recipients,
    subject,
    html: htmlBody,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  console.log(`  Email sent to ${recipients.join(", ")}`);
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

  console.log("  Step 1: Fetching headlines...");
  const rawItems = await fetchRawNews(pastTitles, today);
  if (!rawItems.length) throw new Error("No headlines fetched");

  console.log("  Step 2: Summarizing...");
  const digest = await summarize(rawItems, today);
  console.log(`  Got ${digest.sections.length} sections`);

  saveMemory(memory, digest.sections.flatMap((s) => s.items.map((i) => i.title)));

  console.log("  Step 3: Sending via Resend...");
  const html = buildEmail(digest);
  await sendEmail(`📰 Daily Digest — ${digest.date}`, html, digest.date);

  console.log("  Done!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
