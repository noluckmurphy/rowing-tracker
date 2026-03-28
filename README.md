# Rowing Tracker — Back to 6:55

Kyle's 12-week Concept2 session tracker with PM5 screenshot parsing via Claude Vision.

## Quick Start

```bash
npm install
cp .env.example .env
# Add your Anthropic API key to .env
npm run dev
# → http://localhost:3000
```

## API Key Setup

The PM5 screenshot parsing uses Claude Vision. Locally, you need an Anthropic API key:

1. Get a key at https://console.anthropic.com/
2. Copy `.env.example` → `.env`
3. Set `VITE_ANTHROPIC_API_KEY=sk-ant-...`

The Vite dev proxy (in `vite.config.js`) routes `/api/anthropic` → `api.anthropic.com` and injects the key header, avoiding CORS issues in dev.

## Deploying

### Vercel / Netlify (recommended)

For production, **don't expose your API key in the client bundle.** Instead, create a serverless function to proxy the Anthropic API call:

```
/api/parse-pm5.js  ← serverless function with ANTHROPIC_API_KEY env var (server-side)
```

Then in `App.jsx`, change `API_URL` to point to your serverless function instead of the Anthropic API directly.

### Claude Code

Open this directory with Claude Code and ask it to:
- Add a Vercel/Netlify serverless proxy function
- Add charts/progress visualization
- Add export to CSV
- Add week-by-week comparison view

## Project Structure

```
rowing-tracker/
├── src/
│   ├── App.jsx          # Main app — all UI + PM5 parsing logic
│   ├── main.jsx         # React entry point
│   └── storage.js       # Storage adapter (Claude artifact → localStorage fallback)
├── plan/
│   └── training-plan.md # Full 12-week plan with zones and session prescriptions
├── index.html
├── vite.config.js       # Dev proxy for Anthropic API
├── package.json
├── .env.example
└── .gitignore
```

## Storage

- **In Claude artifact:** Uses `window.storage` (persistent cross-session KV)
- **Locally / deployed:** Falls back to `localStorage` automatically via `src/storage.js`

Sessions are seeded with the first 3 logged sessions from Week 1 on first load.

## PM5 Screenshot Parsing

Drop 1–N PM5 "View Detail" screenshots into the scan panel. The parser handles:

- Fixed distance (2000m) — 500m cumulative splits
- Fixed time (30:00) — equal-time interval splits
- Interval sessions (4×4:00) — piece-by-piece with sub-splits
- Variable pyramids (v1:00/1:00r...7) — ascending/descending with rest rows
- Multi-page sessions — synthesizes all screenshots into one session

All images sent in a single Claude Vision API call. Parsed data auto-fills the form for review before saving.

## The Program

See `plan/training-plan.md` for the full 12-week structure, training zones, and session prescriptions.

**Target:** 6:55.0 (1:43.75 /500m) — matching the Dec 11, 2020 PR.
