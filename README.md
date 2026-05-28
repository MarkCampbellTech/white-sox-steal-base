# White Sox home steal alerts

A personal [Google Apps Script](https://script.google.com) notifier for the [Gas N Wash **Steal a Wash**](https://www.gasnwash.net/steal-a-wash/) promo: when the Chicago White Sox steal a base during a **home** game, you get an email reminder to redeem a free car wash through the Gas N Wash app.

Uses the public [MLB Stats API](https://statsapi.mlb.com) — no API keys required.

## About the promo

[Steal a Wash](https://www.gasnwash.net/steal-a-wash/) is an official White Sox partner promotion. After a home stolen base:

1. Tap **Steal A Wash** in the [Gas N Wash app](https://www.gasnwash.net/steal-a-wash/)
2. Visit any participating Chicagoland location
3. Redeem at the pay station — codes are valid on **game day and the following day**

This project does not redeem washes for you; it only watches the schedule and play-by-play so you do not miss a steal.

## What this sends

- **Steal alert** — HTML email with steal details, next home game, and links to the promo and app stores
- **Homestand preview** — First home game of a homestand: schedule table plus promo reminder
- **Homestand finale** — Last home game before a road trip; messaging reflects the end of the block
- **No-steal recap** — Homestand ends with zero steals: summary plus the next homestand schedule

Polling runs only when it matters: on game days and when a home game is starting soon.

## Setup

### Option A — Apps Script editor (simplest)

1. Open [script.google.com](https://script.google.com) and create a new project.
2. Add a script file and paste in the contents of `white-sox-steal.gs`.
3. Under **Project settings → Script properties**, optionally set:
   - `NOTIFY_EMAIL` — where alerts are sent (defaults to the account running the script).
4. Run once and authorize when prompted:
   - `installCheckTrigger(5)` — poll for steals every 5 minutes on relevant days.
   - `installHomestandPreviewTrigger()` — daily homestand preview at 9:00 AM Chicago time.
5. Edit promo copy and URLs in the `CONFIG` object at the top of the script if needed.

### Option B — clasp (edit locally, push to Google)

```bash
npm install -g @google/clasp
clasp login
```

Enable the [Apps Script API](https://script.google.com/home/usersettings), link your project (`clasp clone <scriptId>` or `clasp create`), keep a local `appsscript.json`, then:

```bash
clasp push
```

## Triggers

| Function | Schedule |
|----------|----------|
| `checkSoxHomeStealsToday` | Every 5 minutes (via `installCheckTrigger`) |
| `checkHomestandStartToday` | Daily at 9:00 AM `America/Chicago` |

Remove with `removeCheckTriggers()` and `removeHomestandPreviewTriggers()`.

## Script properties

| Property | Purpose |
|----------|---------|
| `NOTIFY_EMAIL` | Override alert recipient |
| `SOX_HOME_STEAL_NOTIFY_DATE` | Latch: date a steal alert was sent |
| `SOX_HOMESTAND_PREVIEW_START` | Latch: homestand preview already sent |
| `SOX_HOMESTAND_END_NOTIFIED` | Latch: “ended, no steal” recap sent |

For testing, reset latches with `resetNotifyLatch()`, `resetHomestandPreviewLatch()`, and `resetHomestandEndLatch()`.

## Testing

Test helpers send **real emails** using live schedule data. Run from the Apps Script editor:

- `testStealEmail(gamePk)` — sample steal alert
- `testHomestandPreview()` — homestand preview email
- `testHomestandEndNoSteal()` — end-of-homestand recap

## Disclaimer

Unofficial fan project. Not affiliated with, endorsed by, or sponsored by **Gas N Wash**, **MLB**, or the **Chicago White Sox**. Promo rules and eligibility are defined by Gas N Wash; always confirm details on the [official Steal a Wash page](https://www.gasnwash.net/steal-a-wash/).

## License

[MIT](LICENSE)
