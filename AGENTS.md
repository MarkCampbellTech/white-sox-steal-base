# AGENTS.md

Guidance for AI agents working in this repository.

## Project overview

Google Apps Script (GAS) project that monitors Chicago White Sox **home** games via the public MLB Stats API and sends Gmail alerts for the Gas N Wash **Steal a Wash** promo. Runtime is entirely on Google’s platform — there is no local web server or database.

| File | Purpose |
|------|---------|
| `white-sox-steal.gs` | Main script (~1.6k lines) |
| `appsscript.json` | GAS manifest (V8, `America/Chicago`) |

## Local development

This repo has no application server to run locally. Use:

```bash
npm install
npm run smoke-test   # validates manifest + live MLB API (no Google auth)
```

Optional clasp workflow (requires Google account + Apps Script API enabled):

```bash
npx clasp login
npx clasp clone <scriptId>   # or clasp create
npx clasp push
```

Full E2E behavior (triggers, Gmail, Script Properties) runs only in the [Apps Script editor](https://script.google.com). Test helpers (`testStealEmail`, etc.) send **real emails**.

## External dependencies

- **MLB Stats API** — `https://statsapi.mlb.com/api/v1` (schedule, boxscores) and `/api/v1.1` (play-by-play). No API key.
- **Gmail** — via `GmailApp` in production (OAuth on first run).

## Cursor Cloud specific instructions

- **No long-running local services.** Nothing listens on a port; skip `docker compose` / dev-server startup.
- **Smoke test is the local “hello world”.** `npm run smoke-test` confirms `appsscript.json`, script entry points, and live MLB schedule data — the same API the deployed script uses.
- **clasp is installed as a devDependency** (`npx clasp`). Do not expect `.clasp.json` in git (it is gitignored); link a Google project locally before `clasp push`.
- **Lint/tests:** There is no ESLint or unit test suite. `npm run validate` is an alias for the smoke test. Production tests are manual functions in the Apps Script editor (see README).
- **Secrets:** `NOTIFY_EMAIL` and latch keys live in Google Script Properties, not in this repo.
