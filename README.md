# Signal

Signal is a web research chat agent for questions about changing facts such
as pricing, product updates, news, recommendations, and follow-up questions.

It uses Gemini for reasoning and DuckDuckGo's keyless HTML search for live web
results. Search results are returned with numbered citations, and the model
performs a dedicated synthesis step before answering.

## Run locally

```bash
copy .env.example .env
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).


```env
GEMINI_API_KEY
PORT=3000
```

DuckDuckGo search requires no API key or billing account.

## Documentation

See [DESIGN.md](./DESIGN.md) for the architecture, search and synthesis flow,
date handling, reliability decisions, and UI design rationale.
