#!/usr/bin/env node
/**
 * Local smoke test for White Sox Steal Alerts.
 * Validates appsscript.json and live MLB Stats API connectivity (no Google credentials required).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MLB_API = "https://statsapi.mlb.com/api/v1";
const WHITE_SOX_ID = 145;
const CHICAGO_TZ = "America/Chicago";

function chicagoDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHICAGO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.json();
}

function validateAppsscriptManifest() {
  const path = resolve(ROOT, "appsscript.json");
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw);

  if (manifest.runtimeVersion !== "V8") {
    throw new Error(`Expected V8 runtime, got ${manifest.runtimeVersion}`);
  }
  if (manifest.timeZone !== CHICAGO_TZ) {
    throw new Error(`Expected timezone ${CHICAGO_TZ}, got ${manifest.timeZone}`);
  }

  console.log("✓ appsscript.json is valid (V8, America/Chicago)");
  return manifest;
}

function validateScriptFile() {
  const path = resolve(ROOT, "white-sox-steal.gs");
  const source = readFileSync(path, "utf8");

  const required = [
    "function checkSoxHomeStealsToday",
    "function checkHomestandStartToday",
    "function installCheckTrigger",
    "function testStealEmail",
  ];
  for (const name of required) {
    if (!source.includes(name)) {
      throw new Error(`Missing entry point: ${name}`);
    }
  }

  console.log(`✓ white-sox-steal.gs present (${source.split("\n").length} lines, entry points OK)`);
}

async function fetchSoxScheduleRange(startYmd, endYmd) {
  const url =
    `${MLB_API}/schedule?sportId=1&teamId=${WHITE_SOX_ID}` +
    `&startDate=${encodeURIComponent(startYmd)}&endDate=${encodeURIComponent(endYmd)}`;
  const data = await fetchJson(url);
  const games = [];

  for (const day of data.dates || []) {
    for (const g of day.games || []) {
      const homeId = g.teams?.home?.team?.id;
      games.push({
        gamePk: g.gamePk,
        officialDate: g.officialDate,
        isHome: homeId === WHITE_SOX_ID,
        opponent: g.teams?.[homeId === WHITE_SOX_ID ? "away" : "home"]?.team?.name ?? "?",
        abstractGameState: g.status?.abstractGameState ?? "",
      });
    }
  }

  return games.sort((a, b) => a.officialDate.localeCompare(b.officialDate));
}

async function smokeTestMlbApi() {
  const today = chicagoDateString();
  const start = addDaysYmd(today, -7);
  const end = addDaysYmd(today, 30);

  console.log(`→ Fetching White Sox schedule (${start} … ${end}, Chicago today: ${today})`);
  const games = await fetchSoxScheduleRange(start, end);

  if (games.length === 0) {
    throw new Error("No games returned from MLB Stats API");
  }

  const homeGames = games.filter((g) => g.isHome);
  const nextHome = homeGames.find((g) => g.officialDate >= today) ?? homeGames.at(-1);

  console.log(`✓ MLB Stats API OK — ${games.length} games, ${homeGames.length} home`);
  if (nextHome) {
    console.log(
      `  Next/recent home game: ${nextHome.officialDate} vs ${nextHome.opponent} ` +
        `(gamePk ${nextHome.gamePk}, ${nextHome.abstractGameState || "scheduled"})`
    );
  }

  return { today, games, homeGames, nextHome };
}

async function main() {
  console.log("White Sox Steal Alerts — local smoke test\n");

  validateAppsscriptManifest();
  validateScriptFile();
  await smokeTestMlbApi();

  console.log("\nAll checks passed. Deploy with clasp push after clasp login + clasp clone/create.");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err.message);
  process.exit(1);
});
