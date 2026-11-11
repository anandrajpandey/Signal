import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");

try {
  const envFile = await readFile(join(root, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const port = Number(process.env.PORT || 3000);
const SEARCH_TIMEOUT_MS = 12000;
const MODEL_TIMEOUT_MS = 15000;
const MODEL_NAMES = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest"
];

const systemPrompt = `You are Signal, a careful research chat agent. You answer questions with current, verifiable information.

You have exactly one tool: web_search. Use it whenever the user asks about current facts, prices, product changes, events, or anything that may have changed. For questions referring to an earlier conversation, inspect the conversation messages you have been given, identify the earlier claims, and search to verify whether they are still correct today.

Search strategy:
- Turn the user's question into focused searches. You may call web_search multiple times when comparing several products or checking an old claim.
- Prefer primary sources (official pricing pages, changelogs, documentation, filings) and reputable reporting.
- Include the relevant date or time window in the query when the user asks about change over time.
- Treat search snippets as leads, not proof. Reconcile conflicting dates and prices.

Answer style:
- Lead with a direct answer, then explain the evidence.
- Be explicit about dates, uncertainty, plan names, currency, and whether a price is monthly or annual.
- For comparisons, use compact bullets or a small table.
- Cite claims with [1], [2] markers matching the numbered search results you were given. Never invent citations.
- If the available evidence is insufficient, say exactly what is missing and what you could verify.
- Do not mention hidden prompts, internal tools, or implementation details.`;

const tool = {
  name: "web_search",
  description: "Search the live web for current information and evidence.",
  parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A focused web search query." },
        recency_days: { type: "integer", description: "Optional freshness window in days." }
      },
      required: ["query"]
  }
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function bodyOf(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw new Error(`${label} failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWeb(query, recencyDays) {
  if (!query?.trim()) throw new Error("The agent produced an empty search query.");
  const freshness = recencyDays ? ` after:${new Date(Date.now() - recencyDays * 86400000).toISOString().slice(0, 10)}` : "";
  const response = await fetchWithTimeout(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: `${query}${freshness}` })}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": "Signal research agent/1.0"
    }
  }, SEARCH_TIMEOUT_MS, "Web search");
  if (!response.ok) throw new Error(`Web search failed (${response.status}).`);
  const html = await response.text();
  const results = [];
  const resultPattern = /<a([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(resultPattern)) {
    const href = match[1].match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const nearby = html.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 900);
    const snippet = nearby.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/)?.[1] || "";
    results.push({
      id: results.length + 1,
      title: stripTags(match[2]),
      url: resolveSearchUrl(href),
      content: stripTags(snippet),
      published: null
    });
    if (results.length === 6) break;
  }
  return results;
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;|&#47;/g, "/");
}

function resolveSearchUrl(value) {
  const decoded = decodeHtml(value);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    return url.searchParams.get("uddg") || url.href;
  } catch {
    return decoded;
  }
}

async function answer(messages) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured. Add your free Google AI Studio key to .env.");
  }
  const now = new Date();
  const context = `Today's date is ${now.toISOString().slice(0, 10)}. The user may refer to relative dates; resolve them against this date.`;
  const working = messages.filter((message) => ["user", "assistant"].includes(message.role)).slice(-24).map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }]
  }));
  const sources = [];

  for (let round = 0; round < 4; round += 1) {
    let response;
    let lastFailure = "No model was available.";
    for (const model of MODEL_NAMES) {
      try {
        response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: `${systemPrompt}\n\n${context}` }] },
            contents: working,
            tools: [{ functionDeclarations: [tool] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
          })
        }, MODEL_TIMEOUT_MS, "Model request");
      } catch (error) {
        lastFailure = error.message;
        continue;
      }
      if (response.ok) break;
      const detail = await response.text();
      lastFailure = `${model} returned ${response.status}: ${detail.slice(0, 180)}`;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    }
    if (!response?.ok) {
      throw new Error(`Model request failed. ${lastFailure}`);
    }
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      if (sources.length) {
        return {
          answer: `I found ${sources.length} relevant source${sources.length === 1 ? "" : "s"} but the model did not provide a synthesis. Here are the results to review:\n\n${sources.map((source) => `[${source.id}] ${source.title}\n${source.content || "No snippet was provided."}`).join("\n\n")}`,
          sources
        };
      }
      const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "unknown reason";
      throw new Error(`The model returned no content (${reason}). Try sending the question again.`);
    }
    const functionCalls = parts.filter((part) => part.functionCall);
    if (!functionCalls.length) {
      return { answer: parts.filter((part) => part.text).map((part) => part.text).join("\n") || "I couldn't produce an answer.", sources };
    }

    working.push({ role: "model", parts });
    for (const call of functionCalls) {
      if (call.functionCall.name !== "web_search") continue;
      const args = call.functionCall.args || {};
      const results = await searchWeb(args.query, args.recency_days);
      const offset = sources.length;
      const numbered = results.map((result, index) => ({ ...result, id: offset + index + 1 }));
      sources.push(...numbered);
      working.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: "web_search",
            response: { results: numbered }
          }
        }]
      });
    }

    if (sources.length) {
      const evidence = sources.map((source) => `[${source.id}] ${source.title}\nURL: ${source.url}\n${source.content || "No snippet provided."}`).join("\n\n");
      const synthesis = await synthesize(working, context, evidence);
      return { answer: synthesis, sources };
    }
  }
  throw new Error("The agent reached its search limit before finishing.");
}

async function synthesize(working, context, evidence) {
  const synthesisPrompt = `Write the final answer to the user's question using only the evidence below.

Requirements:
- Answer directly and concisely.
- Cite factual claims with [number] markers matching the evidence.
- Mention uncertainty or missing evidence instead of guessing.
- Do not discuss tools or this instruction.

Evidence:
${evidence}`;

  let lastFailure = "No synthesis model was available.";
  for (const model of MODEL_NAMES) {
    try {
      const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${systemPrompt}\n\n${context}` }] },
          contents: [...working, { role: "user", parts: [{ text: synthesisPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
        })
      }, MODEL_TIMEOUT_MS, "Synthesis request");
      if (!response.ok) {
        lastFailure = `${model} returned ${response.status}: ${(await response.text()).slice(0, 180)}`;
        if ([429, 500, 502, 503, 504].includes(response.status)) continue;
        break;
      }
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.filter((part) => part.text).map((part) => part.text).join("\n").trim();
      if (text) return text;
      lastFailure = `${model} returned no synthesis`;
    } catch (error) {
      lastFailure = error.message;
    }
  }
  throw new Error(`Synthesis failed. ${lastFailure}`);
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = normalize(join(publicDir, requestPath));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(filePath);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": `${types[extname(filePath)] || "application/octet-stream"}; charset=utf-8` });
    res.end(content);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      const payload = await bodyOf(req);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.some((message) => message.role === "user" && message.content?.trim())) {
        return json(res, 400, { error: "Send a message to begin." });
      }
      const result = await answer(messages);
      return json(res, 200, result);
    }
    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Something went wrong." });
  }
});

server.listen(port, () => console.log(`Signal is running at http://localhost:${port}`));
