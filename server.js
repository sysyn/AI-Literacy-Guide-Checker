import express from "express";
import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MAX_PAGES = 8, MAX_CHARS = 60000;
if (!KEY) { console.error("Set ANTHROPIC_API_KEY before starting."); process.exit(1); }

const app = express();
app.use(express.json());
app.use(express.static("public"));

const RUBRIC = `
COMPETENCIES
- Comprehension: Understanding AI's core concepts, as well as recognizing the distinction between AI systems and non-AI technologies.
- Access & Analysis: Using AI for problem solving/analysis/evaluation.
- Communication & Use: Applying AI in new and varied contexts to solve problems, making AI-driven decisions, and effectively communicating insights derived from AI-based data.
- Ethics: Understanding the legal, social and moral implications of AI, particularly data privacy, confidentiality, misinformation, discrimination, integrity, and transparency.

SCORING (apply to each competency separately)
0 = No information available.
1 = Barely mentioned. Competency is implied but not explained; no real examples or context. Related information may exist, but learners must make the connection themselves.
2 = Basic explanation, very broad. Mostly definitions or broad claims. Learners understand the basic idea without inferring, but the explanation is introductory with limited context, examples, or detail.
3 = Discussed. Some actionable guidance (descriptive lists, visuals, fairly thorough descriptions, definitions) and some examples or scenarios, but not enough concrete scenarios or step-by-step examples for a student to apply strategies independently and consistently. Elements of the competency may be missing or not fully explained.
4 = Clear explanations, examples, and guidance. Learners could begin applying the competency with additional practice or support. May address multiple elements, but coverage can be uneven. Examples, frameworks, visuals, activities, or step-by-step guidance are present but more limited in depth than a 5. Use 4 when the guide moves beyond defining/mentioning and gives practical guidance, but lacks thorough in-depth coverage across the competency's major elements.
5 = Thorough coverage. In-depth explanations and clear framing of the competency's major elements. Generally includes explanations, examples, comparisons, activities, visuals, or other instructional materials showing how learners apply the skills, rather than just listing tools or evaluation strategies. May include screenshots, step-by-step guidance, interactive modules or activities, and coverage across multiple pages or sections.`;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function safeUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https links are supported.");
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivate(a.address))) throw new Error("That address is not allowed.");
  return url;
}

async function readPage(u) {
  const url = await safeUrl(u);
  const res = await fetch(url, { headers: { "User-Agent": "AILiteracyGuideChecker/1.0" }, signal: AbortSignal.timeout(15000) });
  await safeUrl(res.url);
  if (!res.ok) throw new Error(`The page returned status ${res.status}.`);
  const $ = cheerio.load(await res.text());

  // Collect links to the guide's other pages (tabs) before stripping navigation.
  const g = url.searchParams.get("g"), base = url.pathname.replace(/\/$/, "") + "/";
  const links = new Set();
  $("a[href]").each((_, a) => {
    try {
      const l = new URL($(a).attr("href"), url); l.hash = "";
      if (l.origin !== url.origin || l.href === url.href) return;
      if (g ? l.searchParams.get("g") === g : (url.pathname.length > 1 && l.pathname.startsWith(base))) links.add(l.href);
    } catch {}
  });

  const media = `[${$("img").length} images, ${$("video,iframe").length} videos or embeds on this page]`;
  const title = $("title").text().trim() || url.href;
  $("script,style,noscript,svg,nav,header,footer,form").remove();
  $("h1,h2,h3,h4,h5,p,li,tr,br").after("\n");
  const root = $("main").length ? $("main") : $("body");
  const text = root.text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { url: url.href, title, text: `${media}\n${text}`, links: [...links] };
}

app.post("/api/check", async (req, res) => {
  try {
    const first = await readPage(String(req.body.url || "").trim());
    const pages = [first];
    const rest = await Promise.allSettled(first.links.slice(0, MAX_PAGES - 1).map(readPage));
    rest.forEach(r => r.status === "fulfilled" && pages.push(r.value));

    let guide = pages.map(p => `### PAGE: ${p.title} (${p.url})\n${p.text}`).join("\n\n").slice(0, MAX_CHARS);
    if (guide.length < 400) return res.status(422).json({ error: "Little readable text was found. The guide may load its content with JavaScript or require a login." });

    const prompt = `You are an expert reviewer helping academic librarians and instructional designers improve AI literacy guides. Score the guide text below against this rubric. Be strict and consistent: score only what the text shows, never what the guide might contain elsewhere. Choose the score whose descriptor best fits; do not inflate. A guide that only lists tools or links without explanation or examples should not exceed 2-3. The text was extracted automatically from ${pages.length} page(s); media counts are given per page.

${RUBRIC}

For each of the four competencies (Comprehension, Access & Analysis, Communication & Use, Ethics) return: score (integer 0-5), rationale (2-4 sentences tied to the descriptors), evidence (up to 3 short verbatim quotes under 25 words each, empty if none), gaps (specific missing elements that held the score down), next_steps (concrete additions that would move it up one level).
Also return: is_ai_literacy_guide (boolean), guide_type_note (one sentence, if false), overall_summary (3-4 sentences), top_priorities (3 revision priorities).

Return ONLY JSON: {"is_ai_literacy_guide":bool,"guide_type_note":str,"overall_summary":str,"top_priorities":[str],"competencies":[{"name":str,"score":int,"rationale":str,"evidence":[str],"gaps":[str],"next_steps":[str]}]}

GUIDE TEXT:
"""
${guide}
"""`;

    const api = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });
    const d = await api.json();
    if (!api.ok) throw new Error(d.error?.message || "The review service returned an error.");
    const out = JSON.parse(d.content.map(c => c.text || "").join("").replace(/```json|```/g, "").trim());
    res.json({ result: out, pages: pages.map(p => ({ url: p.url, title: p.title })) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Something went wrong." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("AI Literacy Guide Checker running on http://localhost:" + (process.env.PORT || 3000)));
