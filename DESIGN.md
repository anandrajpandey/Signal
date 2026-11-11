# Signal

Signal is a small research chat agent for questions whose answers can change:
pricing, product updates, news, recommendations, and follow-ups to earlier
questions.

The goal is simple: give a useful answer, show the evidence, and be honest
when the evidence is thin. It should feel like talking to a thoughtful
researcher rather than filling out a search form.

## What happens when you ask a question

Signal uses a two-step model loop:

1. Gemini reads the question and decides whether it needs current web
   information. If it does, it calls the only tool available to it:
   `web_search`.
2. Signal sends the returned results to Gemini in a separate, tool-free
   synthesis request. Gemini then writes the final answer with numbered
   citations.

The separate synthesis step is intentional. It prevents the model from
finishing after a search call without actually explaining what the results
mean.

Search results come from DuckDuckGo's public HTML search endpoint. This keeps
the project usable with free keys: DuckDuckGo does not require a separate API
key here, and the server never exposes the Gemini key to the browser. Search
results are treated as evidence, not as instructions, and the model cannot
make arbitrary HTTP requests or execute code.

## Project shape

- [`public/`](./public/) contains the browser UI and the current conversation.
- [`server.js`](./server.js) is the API and trust boundary. It loads the
  Gemini key, runs the model/tool loop, assigns citation numbers, and returns
  source cards.
- [`.env.example`](./.env.example) lists the only required configuration.

The browser keeps the transcript locally in memory. That makes follow-up
questions fast and avoids silently storing a user's research history. A
production version should add authenticated, encrypted persistence behind the
same server boundary.

## Handling dates and changing facts

Each request includes the current ISO date, so phrases such as “last Tuesday”
or “since 3 November” have an anchor. The model is instructed to make dates,
plan names, currencies, billing periods, and uncertainty explicit. The recent
conversation is sent with each request, which lets Signal identify an earlier
claim before checking whether it is still true.

## Reliability and limits

The server limits each answer to four model/search rounds. Gemini requests,
web searches, and browser requests all have timeouts, so a provider outage
becomes a visible error instead of an endless loading state. If Gemini returns
search results but fails to synthesize them, Signal still shows the sources
and snippets rather than inventing an answer.

Gemini uses a low temperature and a short output budget to keep answers
focused and reduce cost. The model list has free-tier fallback models so a
temporary capacity error from one model does not immediately stop the chat.

## Interface

The UI is deliberately monochrome: warm white, black text, thin rules, and a
single asterisk-like mark for the agent. The left rail explains the promise
while the conversation stays uncluttered. Sources appear directly beneath an
answer because citations should be part of reading the answer, not hidden in
another screen. On smaller screens the explanation rail disappears and the
composer remains the focus.

## Run locally

1. Copy `.env.example` to `.env`.
2. Create a free key at
   [Google AI Studio](https://aistudio.google.com/apikey) and set
   `GEMINI_API_KEY`.
3. Run `npm install`.
4. Run `npm run dev`, then open `http://localhost:3000`.

No DuckDuckGo key is required.
