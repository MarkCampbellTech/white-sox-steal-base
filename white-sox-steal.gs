/**
 * Google Apps Script — White Sox home stolen bases (today only, Chicago date).
 *
 * Paste into script.google.com (Code.gs) or sync with clasp.
 *
 * Setup:
 * 1. Set Script Property NOTIFY_EMAIL (optional; defaults to active user).
 * 2. Run installCheckTrigger(5) for steal polling.
 * 3. Run installHomestandPreviewTrigger() for daily homestand preview (9 AM Chicago).
 *
 * Latch keys (Script Properties):
 * - SOX_HOME_STEAL_NOTIFY_DATE — first steal email sent this Chicago calendar day
 * - SOX_HOME_STEAL_REPORTED — JSON payload for the steal we alerted (for reversal checks)
 * - SOX_HOME_STEAL_CORRECTION_SENT — date a steal-correction email was sent
 * - SOX_HOMESTAND_PREVIEW_START — homestand start date we already previewed
 * - SOX_HOMESTAND_END_NOTIFIED — homestand start date we sent “ended, no steal” recap
 */

// --- Config ----------------------------------------------------------------

var MLB_API = "https://statsapi.mlb.com/api/v1";
var MLB_FEED_API = "https://statsapi.mlb.com/api/v1.1";
var WHITE_SOX_ID = 145;
var CHICAGO_TZ = "America/Chicago";

var PROP_LAST_FIRED = "SOX_HOME_STEAL_NOTIFY_DATE";
var PROP_STEAL_REPORTED = "SOX_HOME_STEAL_REPORTED";
var PROP_STEAL_CORRECTION_SENT = "SOX_HOME_STEAL_CORRECTION_SENT";
var PROP_HOMESTAND_PREVIEW = "SOX_HOMESTAND_PREVIEW_START";
var PROP_HOMESTAND_END_NOTIFIED = "SOX_HOMESTAND_END_NOTIFIED";
var PROP_NOTIFY_EMAIL = "NOTIFY_EMAIL";

var CONFIG = {
  senderName: "White Sox Steal Alert",
  promoBrandName: "Gas N Wash",
  promoName: "Steal a Wash",
  promoPageUrl: "https://www.gasnwash.net/steal-a-wash/",
  appStoreIosUrl: "https://apps.apple.com/us/app/gas-n-wash/id1660351704",
  appStoreAndroidUrl: "https://play.google.com/store/apps/details?id=com.rovertown.gasnwash",
  promoHeadline: "Steal a Wash — White Sox stole at home!",
  promoFooter:
    "After the game, open the Gas N Wash app, tap \"Steal A Wash,\" then redeem at any Chicagoland location. " +
    "Codes are valid on game day and the following day.",
  homestandPromoLine:
    "Gas N Wash Steal a Wash: one free wash for each White Sox stolen base at home.",
  scheduleLookbackDays: 45,
  scheduleLookaheadDays: 60,
  headshotUrlTemplate:
    "https://img.mlbstatic.com/mlb-photos/image/upload/w_120,q_auto:best/v1/people/{playerId}/headshot/silo/current",
  teamLogoUrlOnLight:
    "https://www.mlbstatic.com/team-logos/team-cap-on-light/{teamId}.svg",
};

// --- Logging ---------------------------------------------------------------

function log_(message, detail) {
  if (detail !== undefined && detail !== null) {
    var extra = typeof detail === "string" ? detail : JSON.stringify(detail);
    Logger.log(message + " | " + extra);
  } else {
    Logger.log(message);
  }
}

function logLatches_(context) {
  var props = PropertiesService.getScriptProperties();
  log_(context + " — latches", {
    SOX_HOME_STEAL_NOTIFY_DATE: props.getProperty(PROP_LAST_FIRED) || "(unset)",
    SOX_HOME_STEAL_REPORTED: props.getProperty(PROP_STEAL_REPORTED) ? "(set)" : "(unset)",
    SOX_HOME_STEAL_CORRECTION_SENT: props.getProperty(PROP_STEAL_CORRECTION_SENT) || "(unset)",
    SOX_HOMESTAND_PREVIEW_START: props.getProperty(PROP_HOMESTAND_PREVIEW) || "(unset)",
    SOX_HOMESTAND_END_NOTIFIED: props.getProperty(PROP_HOMESTAND_END_NOTIFIED) || "(unset)",
  });
}

function setLatch_(key, value, reason) {
  var props = PropertiesService.getScriptProperties();
  var before = props.getProperty(key) || "(unset)";
  props.setProperty(key, value);
  log_("Latch updated: " + key, { reason: reason, before: before, after: value });
}

function clearLatch_(key, reason) {
  var props = PropertiesService.getScriptProperties();
  var before = props.getProperty(key) || "(unset)";
  props.deleteProperty(key);
  log_("Latch cleared: " + key, { reason: reason, before: before });
}

// --- Entry points ----------------------------------------------------------

/**
 * Time-driven trigger — polls for first home steal of the Chicago calendar day.
 */
function checkSoxHomeStealsToday() {
  var todayChicago = chicagoDateString_(new Date());
  log_("checkSoxHomeStealsToday — start", { todayChicago: todayChicago });
  logLatches_("checkSoxHomeStealsToday — start");

  if (!hasSoxHomeGameTodayOrSoon_()) {
    log_("No Sox home game today or starting within 12 hours — skipping poll");
    return;
  }

  var homeGames = fetchSoxHomeGamesToday_();
  if (!homeGames.length) {
    log_("No home game on schedule today", { todayChicago: todayChicago });
    return;
  }

  var homestands = buildHomestandsFromScheduleAround_(todayChicago);
  var homestand = getHomestandForDate_(homestands, todayChicago);

  log_("Home game(s) today", {
    count: homeGames.length,
    games: homeGames.map(function (g) {
      return { gamePk: g.gamePk, status: g.abstractGameState };
    }),
  });

  var props = PropertiesService.getScriptProperties();
  var lastFired = props.getProperty(PROP_LAST_FIRED);
  var stealAlreadySent = lastFired === todayChicago;
  log_("Steal notify latch check", {
    key: PROP_LAST_FIRED,
    stored: lastFired || "(unset)",
    todayChicago: todayChicago,
    stealAlreadySent: stealAlreadySent,
  });

  if (!stealAlreadySent) {
    var allSteals = [];
    var totalSb = 0;
    var allGamesFinal = true;

    for (var i = 0; i < homeGames.length; i++) {
      var g = homeGames[i];
      if (g.abstractGameState !== "Final") {
        allGamesFinal = false;
      }
      var box = boxscoreHomeSteals_(g.gamePk);
      totalSb += box.steals;
      log_("Boxscore steals", { gamePk: g.gamePk, opponent: box.opponent, steals: box.steals, status: g.abstractGameState });
      var feedSteals = getHomeStealsFromFeed_(g.gamePk, box.opponent, g.abstractGameState || "", box.opponentTeamId);
      log_("Feed steals parsed", { gamePk: g.gamePk, count: feedSteals.length });
      for (var j = 0; j < feedSteals.length; j++) {
        allSteals.push(feedSteals[j]);
      }
    }

    log_("Steal totals for today", { totalSb: totalSb, feedPlayCount: allSteals.length });

    if (totalSb > 0) {
      if (!allSteals.length && !allGamesFinal) {
        log_("Boxscore shows steals but feed has none — waiting (possible review or scoring lag)", {
          totalSb: totalSb,
          allGamesFinal: allGamesFinal,
        });
      } else {
        allSteals.sort(compareStealsChronologically_);
        var firstSteal = allSteals.length ? allSteals[0] : buildFallbackSteal_(homeGames[0], totalSb);
        log_("Sending steal email (first steal only)", {
          player: firstSteal.playerName,
          gamePk: firstSteal.gamePk,
          inning: firstSteal.inningLabel,
        });

        var nextHomeGame = getNextHomeGameAfterFromHomestands_(homestands, todayChicago);
        var isLastHomestandDay = homestand && isLastHomestandHomeDate_(homestand, todayChicago);
        log_("Steal email schedule context", {
          homestand: homestand ? describeHomestand_(homestand) : "not in homestand today",
          isLastHomestandDay: isLastHomestandDay,
          nextHomeGame: nextHomeGame ? nextHomeGame.officialDate + " vs " + nextHomeGame.opponent : "(none in window)",
          note: isLastHomestandDay
            ? "last home day before road trip — homestand finale copy"
            : "more home games remain in this homestand OR not last calendar day of stand",
        });

        sendStealEmailHtml_({
          dateChicago: todayChicago,
          steal: firstSteal,
          isLastHomestandDay: isLastHomestandDay,
          nextHomeGame: nextHomeGame,
        });

        setLatch_(PROP_LAST_FIRED, todayChicago, "first steal email sent");
        saveReportedSteal_(firstSteal, todayChicago);
        if (isLastHomestandDay && homestand) {
          setLatch_(PROP_HOMESTAND_END_NOTIFIED, homestand.startDate, "steal on last homestand day — skip no-steal recap");
        }
      }
    } else {
      log_("Home game today — no steals yet", { todayChicago: todayChicago, totalSb: 0 });
    }
  } else {
    log_("Already sent first-steal email today — skipping steal notify", {
      latch: PROP_LAST_FIRED,
      value: lastFired,
    });
  }

  checkStealReversalToday_(todayChicago, homeGames);

  checkHomestandEndNoStealToday_(todayChicago, homeGames, homestands, homestand);
  logLatches_("checkSoxHomeStealsToday — end");
}

/**
 * Last homestand day, all home games Final, zero steals — email next homestand schedule.
 * Accepts pre-fetched homeGames/homestands to avoid duplicate API calls during a poll cycle.
 */
function checkHomestandEndNoStealToday_(todayChicago, homeGames, homestands, homestand) {
  log_("checkHomestandEndNoStealToday_ — start", { todayChicago: todayChicago });

  if (!homestand) {
    log_("Not in a homestand today — skip end recap");
    return;
  }
  if (!isLastHomestandHomeDate_(homestand, todayChicago)) {
    log_("Homestand continues after today — not last homestand day", {
      homestandEnd: homestand.endDate,
      todayChicago: todayChicago,
    });
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var endNotified = props.getProperty(PROP_HOMESTAND_END_NOTIFIED);
  if (endNotified === homestand.startDate) {
    log_("Homestand end recap already sent", {
      key: PROP_HOMESTAND_END_NOTIFIED,
      value: endNotified,
      homestandStart: homestand.startDate,
    });
    return;
  }

  if (!homeGames || !homeGames.length) {
    log_("Last homestand day but no home games in schedule fetch");
    return;
  }
  if (!allHomeGamesFinal_(homeGames)) {
    log_("Last homestand day — waiting for all games Final", {
      games: homeGames.map(function (g) {
        return { gamePk: g.gamePk, status: g.abstractGameState };
      }),
    });
    return;
  }

  var stealsToday = countHomeStealsToday_(homeGames);
  if (stealsToday > 0) {
    log_("Last homestand day — steals today, no end recap", { stealsToday: stealsToday });
    return;
  }

  var nextHomestand = getNextHomestandAfter_(homestands, homestand);
  log_("Sending homestand end (no steal) email", {
    endedHomestand: homestand.startDate + "–" + homestand.endDate,
    nextHomestand: nextHomestand ? nextHomestand.startDate + "–" + nextHomestand.endDate : "(none in window)",
  });

  sendHomestandEndNoStealEmail_({
    dateChicago: todayChicago,
    homestand: homestand,
    nextHomestand: nextHomestand,
  });
  setLatch_(PROP_HOMESTAND_END_NOTIFIED, homestand.startDate, "homestand end no-steal email sent");
}

/**
 * Daily trigger — homestand preview on first home game of a homestand.
 */
function checkHomestandStartToday() {
  var todayChicago = chicagoDateString_(new Date());
  log_("checkHomestandStartToday — start", { todayChicago: todayChicago });
  logLatches_("checkHomestandStartToday — start");

  var props = PropertiesService.getScriptProperties();
  var previewSent = props.getProperty(PROP_HOMESTAND_PREVIEW);
  if (previewSent === todayChicago) {
    log_("Homestand preview latch already matches today — skip", {
      key: PROP_HOMESTAND_PREVIEW,
      value: previewSent,
    });
    return;
  }

  var startYmd = addDaysYmd_(todayChicago, -CONFIG.scheduleLookbackDays);
  var endYmd = addDaysYmd_(todayChicago, CONFIG.scheduleLookaheadDays);
  var games = fetchSoxScheduleRange_(startYmd, endYmd);
  var homestands = buildHomestands_(games);
  var homestand = getHomestandForDate_(homestands, todayChicago);

  if (!homestand) {
    log_("No homestand contains today — not a home homestand day", { todayChicago: todayChicago });
    return;
  }
  if (homestand.startDate !== todayChicago) {
    log_("Not first day of homestand", {
      todayChicago: todayChicago,
      homestandStart: homestand.startDate,
      homestandEnd: homestand.endDate,
    });
    return;
  }

  log_("Sending homestand preview email", {
    homestand: homestand.startDate + "–" + homestand.endDate,
    homeGames: homestand.homeGames.length,
  });

  sendHomestandPreviewEmailHtml_({
    dateChicago: todayChicago,
    homestand: homestand,
  });

  setLatch_(PROP_HOMESTAND_PREVIEW, homestand.startDate, "homestand preview email sent");
  logLatches_("checkHomestandStartToday — end");
}

// --- Notifications ---------------------------------------------------------

/**
 * @param {{
 *   dateChicago: string,
 *   steal: Object,
 *   isLastHomestandDay?: boolean,
 *   nextHomeGame?: Object|null
 * }} payload
 */
function sendStealEmailHtml_(payload) {
  var steal = payload.steal;
  var to = getNotifyEmail_();
  var opponent = steal.opponent || "opponent";
  var callout = formatStealCallout_(steal);
  var subject = "Stolen base!! — " + callout + " vs " + opponent;

  var html = buildStealEmailHtml_(payload);
  var plain = buildStealEmailPlain_(payload);

  log_("Gmail send — steal email", { to: to, subject: subject, dateChicago: payload.dateChicago });
  GmailApp.sendEmail(to, subject, plain, {
    htmlBody: html,
    name: CONFIG.senderName,
  });
}

function sendHomestandPreviewEmailHtml_(payload) {
  var hs = payload.homestand;
  var to = getNotifyEmail_();
  var n = hs.homeGames.length;
  var subject = "White Sox homestand starts today — " + n + " home game" + (n === 1 ? "" : "s");

  log_("Gmail send — homestand preview", {
    to: to,
    subject: subject,
    homestand: hs.startDate + "–" + hs.endDate,
  });
  GmailApp.sendEmail(to, subject, buildHomestandPreviewPlain_(payload), {
    htmlBody: buildHomestandPreviewHtml_(payload),
    name: CONFIG.senderName,
  });
}

/**
 * @param {{ dateChicago: string, homestand: Object, nextHomestand: Object|null }} payload
 */
function sendHomestandEndNoStealEmail_(payload) {
  var to = getNotifyEmail_();
  var subject = "Game ended — no steals — next homestand dates";
  var nh = payload.nextHomestand;

  log_("Gmail send — homestand end (no steal)", {
    to: to,
    subject: subject,
    ended: payload.homestand.startDate + "–" + payload.homestand.endDate,
    nextHomestand: nh ? nh.startDate + "–" + nh.endDate : "(none)",
  });
  GmailApp.sendEmail(to, subject, buildHomestandEndNoStealPlain_(payload), {
    htmlBody: buildHomestandEndNoStealHtml_(payload),
    name: CONFIG.senderName,
  });
}

/**
 * Correction when a reported steal was overturned (e.g. replay review → caught stealing).
 * @param {{ dateChicago: string, reported: Object, reversal: Object }} payload
 */
function sendStealCorrectionEmail_(payload) {
  var reported = payload.reported;
  var to = getNotifyEmail_();
  var opponent = reported.opponent || "opponent";
  var subject = "CORRECTION — no stolen base — " + reported.playerName + " vs " + opponent;

  log_("Gmail send — steal correction", {
    to: to,
    subject: subject,
    player: reported.playerName,
    gamePk: reported.gamePk,
    reason: payload.reversal.reason,
  });
  GmailApp.sendEmail(to, subject, buildStealCorrectionPlain_(payload), {
    htmlBody: buildStealCorrectionHtml_(payload),
    name: CONFIG.senderName,
  });
}

// --- Email HTML builders ---------------------------------------------------

function buildStealEmailHtml_(payload) {
  var steal = payload.steal;
  var headshot = CONFIG.headshotUrlTemplate.replace("{playerId}", String(steal.playerId || "0"));
  var gamedayUrl = "https://www.mlb.com/gameday/" + steal.gamePk;
  var parts = [];

  parts.push(buildEmailDarkModeGuardHtml_());
  parts.push(
    "<div class=\"sox-email-root\" style=\"font-family:Arial,sans-serif;max-width:600px;color:#111;color-scheme:light only;\">"
  );

  parts.push("<div style=\"background:linear-gradient(135deg,#0f172a,#1f2937);color:#fff;border-radius:12px;padding:20px;margin-bottom:16px;\">");
  parts.push("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;border-collapse:collapse;\"><tr>");
  parts.push("<td style=\"vertical-align:middle;width:100%;\">");
  parts.push("<div style=\"font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#9ca3af;margin:0 0 6px;\">Stolen Base</div>");
  parts.push("<h1 style=\"font-size:22px;line-height:1.25;margin:0 0 6px;font-weight:bold;\">" + escapeHtml_(CONFIG.promoHeadline) + "</h1>");
  parts.push(
    "<p style=\"font-size:17px;font-weight:bold;color:#f9fafb;margin:0 0 6px;line-height:1.3;\">" +
      escapeHtml_(formatStealCallout_(steal)) +
      "</p>"
  );
  parts.push("<p style=\"color:#d1d5db;margin:0;font-size:14px;\">" + escapeHtml_(formatDisplayDate_(payload.dateChicago)) + " · Chicago</p>");
  parts.push("</td>");
  parts.push(
    "<td width=\"1\" style=\"vertical-align:middle;text-align:right;white-space:nowrap;padding-left:12px;width:1%;line-height:0;font-size:0;\">"
  );
  parts.push(buildMatchupBadgesHtml_(WHITE_SOX_ID, "Chicago White Sox", steal.opponentTeamId, steal.opponent, 58));
  parts.push("</td></tr></table>");
  parts.push("</div>");

  parts.push(
    "<div style=\"border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:16px;background:#ffffff !important;background-color:#ffffff !important;color-scheme:light only;\">"
  );
  parts.push("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;border-collapse:collapse;\"><tr>");
  if (steal.playerId) {
    parts.push(
      "<td style=\"vertical-align:top;width:108px;padding-right:14px;\">" +
        "<img src=\"" + headshot + "\" alt=\"\" width=\"96\" height=\"96\" style=\"display:block;border-radius:50%;border:1px solid #e5e7eb;background:#f8f8f8;\" />" +
        "</td>"
    );
  }
  parts.push("<td style=\"vertical-align:top;\">");
  parts.push("<div style=\"font-size:21px;font-weight:bold;line-height:1.2;margin:0 0 4px;\">" + escapeHtml_(steal.playerName) + "</div>");
  parts.push("<div style=\"font-size:15px;color:#374151;margin:0 0 8px;\">" + escapeHtml_(steal.inningLabel) + " · stole " + escapeHtml_(steal.baseLabel) + "</div>");
  parts.push(
    "<div style=\"font-size:14px;color:#4b5563;margin:0 0 12px;\">" +
      "<span style=\"vertical-align:middle;\">vs </span>" +
      teamLogoImgHtml_(steal.opponentTeamId, steal.opponent, 22, "vertical-align:middle;margin:0 6px;") +
      "<span style=\"vertical-align:middle;\">" + escapeHtml_(steal.opponent) + "</span>" +
      "</div>"
  );
  parts.push(buildStealMlbPlayHtml_(steal));
  parts.push(buildButtonHtml_(gamedayUrl, "Watch on Gameday"));
  parts.push("</td></tr></table>");
  parts.push("</div>");

  parts.push(buildStealNextHomeBlockHtml_(payload.nextHomeGame, payload.isLastHomestandDay));

  parts.push(buildPromoBlockHtml_(true));
  parts.push("</div>");

  return parts.join("");
}

function buildButtonHtml_(href, label) {
  return (
    "<a href=\"" + href + "\" style=\"" +
    "display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;" +
    "padding:9px 16px;border-radius:8px;font-size:14px;font-weight:bold;\">" +
    escapeHtml_(label) +
    "</a>"
  );
}

function buildPromoCtaRowHtml_() {
  var parts = [];
  parts.push("<p style=\"margin:0 0 12px;\">");
  parts.push(buildButtonHtml_(CONFIG.promoPageUrl, CONFIG.promoName + " details"));
  parts.push(
    " <a href=\"" +
      CONFIG.promoPageUrl +
      "\" style=\"display:inline-block;margin-left:8px;color:#0ea5e9;font-size:14px;font-weight:bold;text-decoration:none;\">" +
      "Get the " +
      escapeHtml_(CONFIG.promoBrandName) +
      " app</a>"
  );
  parts.push("</p>");
  return parts.join("");
}

function buildPromoLinksLineHtml_(extraStyle) {
  var style = "font-size:12px;color:#6b7280;margin:0;" + (extraStyle || "");
  return (
    "<p style=\"" +
    style +
    "\"><a href=\"" +
    CONFIG.promoPageUrl +
    "\" style=\"color:#0ea5e9;\">" +
    escapeHtml_(CONFIG.promoName) +
    "</a> · " +
    "<a href=\"" +
    CONFIG.appStoreIosUrl +
    "\" style=\"color:#0ea5e9;\">iPhone app</a> · " +
    "<a href=\"" +
    CONFIG.appStoreAndroidUrl +
    "\" style=\"color:#0ea5e9;\">Android app</a></p>"
  );
}

function buildPromoBlockHtml_(includeCtas) {
  var parts = [];
  parts.push("<div style=\"border-top:1px solid #e5e7eb;padding-top:12px;margin-top:16px;\">");
  parts.push("<p style=\"font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.5;\">" + escapeHtml_(CONFIG.promoFooter) + "</p>");
  if (includeCtas) {
    parts.push(buildPromoCtaRowHtml_());
  }
  parts.push(buildPromoLinksLineHtml_());
  parts.push("</div>");
  return parts.join("");
}

function buildPromoLinksPlain_() {
  return [
    CONFIG.promoName + ": " + CONFIG.promoPageUrl,
    "iPhone app: " + CONFIG.appStoreIosUrl,
    "Android app: " + CONFIG.appStoreAndroidUrl,
  ];
}

function buildPromoBlockPlain_() {
  var lines = [CONFIG.promoFooter, ""];
  lines.push.apply(lines, buildPromoLinksPlain_());
  return lines;
}

function buildStealMlbPlayHtml_(steal) {
  var descriptions = getStealMlbDescriptions_(steal);
  if (!descriptions.length) {
    return "";
  }
  var parts = [];
  parts.push(
    "<div style=\"margin:0 0 14px;padding:14px 16px;background:#f9fafb;border-left:4px solid #0ea5e9;border-radius:0 8px 8px 0;\">"
  );
  parts.push("<div style=\"font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin:0 0 8px;\">MLB play-by-play</div>");
  for (var i = 0; i < descriptions.length; i++) {
    var margin = i < descriptions.length - 1 ? "0 0 10px" : "0";
    parts.push(
      "<p style=\"font-size:16px;line-height:1.55;color:#111;margin:" +
        margin +
        ";font-style:italic;\">" +
        escapeHtml_(descriptions[i]) +
        "</p>"
    );
  }
  parts.push("</div>");
  return parts.join("");
}

function buildStealEmailPlain_(payload) {
  var steal = payload.steal;
  var mlbLines = getStealMlbDescriptions_(steal);
  var lines = [
    CONFIG.promoHeadline,
    formatStealCallout_(steal),
    formatDisplayDate_(payload.dateChicago),
    "",
    steal.playerName + " · " + steal.inningLabel + " vs " + steal.opponent,
  ];
  if (mlbLines.length) {
    lines.push("");
    lines.push("MLB play-by-play:");
    for (var m = 0; m < mlbLines.length; m++) {
      lines.push(mlbLines[m]);
    }
  }
  lines.push("");
  lines.push("Gameday: https://www.mlb.com/gameday/" + steal.gamePk);
  lines.push("");
  lines.push(buildStealNextHomeBlockPlain_(payload.nextHomeGame, payload.isLastHomestandDay));
  lines.push("");
  lines.push.apply(lines, buildPromoBlockPlain_());
  return lines.join("\n");
}

function buildStealCorrectionHtml_(payload) {
  var reported = payload.reported;
  var reversal = payload.reversal || {};
  var gamedayUrl = "https://www.mlb.com/gameday/" + reported.gamePk;
  var parts = [];

  parts.push(buildEmailDarkModeGuardHtml_());
  parts.push(
    "<div class=\"sox-email-root\" style=\"font-family:Arial,sans-serif;max-width:600px;color:#111;color-scheme:light only;\">"
  );

  parts.push("<div style=\"background:linear-gradient(135deg,#7f1d1d,#991b1b);color:#fff;border-radius:12px;padding:20px;margin-bottom:16px;\">");
  parts.push("<div style=\"font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#fecaca;margin:0 0 6px;\">Correction</div>");
  parts.push("<h1 style=\"font-size:22px;line-height:1.25;margin:0 0 6px;font-weight:bold;\">No stolen base — call reversed</h1>");
  parts.push(
    "<p style=\"font-size:17px;font-weight:bold;color:#fef2f2;margin:0 0 6px;line-height:1.3;\">" +
      escapeHtml_(reported.playerName) +
      " was caught stealing, not safe on the steal</p>"
  );
  parts.push("<p style=\"color:#fecaca;margin:0;font-size:14px;\">" + escapeHtml_(formatDisplayDate_(payload.dateChicago)) + " · Chicago</p>");
  parts.push("</div>");

  parts.push(
    "<div style=\"border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:16px;background:#ffffff !important;\">"
  );
  parts.push("<p style=\"margin:0 0 10px;color:#374151;font-size:15px;line-height:1.5;\">");
  parts.push(
    "An earlier alert said <strong>" +
      escapeHtml_(reported.playerName) +
      "</strong> stole " +
      escapeHtml_(reported.baseLabel || "a base") +
      " in the " +
      escapeHtml_(reported.inningLabel || "game") +
      " vs " +
      escapeHtml_(reported.opponent) +
      ". MLB scoring updated the play after a review — it is recorded as <strong>caught stealing</strong>, so the Steal a Wash promo does not apply for that play."
  );
  parts.push("</p>");

  if (reversal.playDescription) {
    parts.push(
      "<div style=\"margin:0 0 14px;padding:14px 16px;background:#fef2f2;border-left:4px solid #dc2626;border-radius:0 8px 8px 0;\">"
    );
    parts.push("<div style=\"font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#991b1b;margin:0 0 8px;\">Official MLB scoring</div>");
    parts.push(
      "<p style=\"font-size:16px;line-height:1.55;color:#111;margin:0;font-style:italic;\">" +
        escapeHtml_(reversal.playDescription) +
        "</p>"
    );
    parts.push("</div>");
  }

  parts.push(buildButtonHtml_(gamedayUrl, "View on Gameday"));
  parts.push("</div>");

  parts.push(buildPromoBlockHtml_(false));
  parts.push("</div>");
  return parts.join("");
}

function buildStealCorrectionPlain_(payload) {
  var reported = payload.reported;
  var reversal = payload.reversal || {};
  var lines = [
    "CORRECTION — no stolen base",
    "",
    "An earlier alert said " +
      reported.playerName +
      " stole " +
      (reported.baseLabel || "a base") +
      " in the " +
      (reported.inningLabel || "game") +
      " vs " +
      reported.opponent +
      ".",
    "MLB scoring updated the play after a review — it is recorded as caught stealing.",
    "The Steal a Wash promo does not apply for that play.",
    "",
    formatDisplayDate_(payload.dateChicago),
  ];
  if (reversal.playDescription) {
    lines.push("");
    lines.push("Official MLB scoring:");
    lines.push(reversal.playDescription);
  }
  lines.push("");
  lines.push("Gameday: https://www.mlb.com/gameday/" + reported.gamePk);
  lines.push("");
  lines.push.apply(lines, buildPromoBlockPlain_());
  return lines.join("\n");
}

function buildHomestandPreviewHtml_(payload) {
  var hs = payload.homestand;
  var parts = [];
  parts.push(buildEmailDarkModeGuardHtml_());
  parts.push(
    "<div class=\"sox-email-root\" style=\"font-family:Arial,sans-serif;max-width:600px;color:#111;color-scheme:light only;\">"
  );
  parts.push(buildHomestandHeaderHtml_("White Sox homestand starts today", formatDisplayDate_(payload.dateChicago) + " · " + hs.homeGames.length + " home games"));
  parts.push("<p style=\"margin:0 0 12px;color:#374151;\">" + escapeHtml_(CONFIG.homestandPromoLine) + "</p>");
  parts.push(buildPromoCtaRowHtml_());
  parts.push(buildHomestandGamesTableHtml_(hs));
  parts.push(buildPromoLinksLineHtml_("margin-top:14px;"));
  parts.push("</div>");
  return parts.join("");
}

function buildHomestandHeaderHtml_(title, subline) {
  var parts = [];
  parts.push("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;border-collapse:collapse;margin-bottom:14px;\"><tr>");
  parts.push(
    "<td style=\"vertical-align:middle;width:60px;padding-right:12px;\">" +
      teamLogoImgHtml_(WHITE_SOX_ID, "Chicago White Sox", 48, "display:block;") +
      "</td>"
  );
  parts.push("<td style=\"vertical-align:middle;\">");
  parts.push("<h1 style=\"font-size:20px;margin:0 0 4px;line-height:1.25;\">" + escapeHtml_(title) + "</h1>");
  parts.push("<p style=\"color:#6b7280;margin:0;font-size:14px;\">" + escapeHtml_(subline) + "</p>");
  parts.push("</td></tr></table>");
  return parts.join("");
}

function buildHomestandPreviewPlain_(payload) {
  var hs = payload.homestand;
  var lines = ["White Sox homestand starts today", CONFIG.homestandPromoLine, ""];
  lines.push(buildHomestandGamesTablePlain_(hs));
  lines.push("");
  lines.push.apply(lines, buildPromoLinksPlain_());
  return lines.join("\n");
}

function buildHomestandEndNoStealHtml_(payload) {
  var parts = [];
  parts.push(buildEmailDarkModeGuardHtml_());
  parts.push(
    "<div class=\"sox-email-root\" style=\"font-family:Arial,sans-serif;max-width:600px;color:#111;color-scheme:light only;\">"
  );
  parts.push(
    buildHomestandHeaderHtml_(
      "Game ended — no steals today",
      formatDisplayDate_(payload.dateChicago) + " · Last home game before the Sox hit the road"
    )
  );
  parts.push("<p style=\"margin:0 0 16px;color:#374151;\">No White Sox stolen bases at home in the finale, so no car wash promo alert. Here is the next homestand when they return:</p>");

  if (payload.nextHomestand) {
    var nh = payload.nextHomestand;
    parts.push("<div style=\"background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px;\">");
    parts.push("<h2 style=\"font-size:16px;margin:0 0 6px;\">Next homestand · " + nh.homeGames.length + " home games</h2>");
    parts.push(
      "<p style=\"color:#6b7280;margin:0;font-size:14px;\">" +
        escapeHtml_(formatDisplayDate_(nh.startDate)) +
        " – " +
        escapeHtml_(formatDisplayDate_(nh.endDate)) +
        "</p></div>"
    );
    parts.push(buildHomestandGamesTableHtml_(nh));
    parts.push("<p style=\"font-size:13px;color:#6b7280;margin:12px 0 0;\">" + escapeHtml_(CONFIG.homestandPromoLine) + "</p>");
    parts.push(buildPromoLinksLineHtml_("margin-top:10px;"));
  } else {
    parts.push("<p style=\"margin:0;color:#374151;\">No upcoming home games scheduled in the next " + CONFIG.scheduleLookaheadDays + " days.</p>");
  }

  parts.push("</div>");
  return parts.join("");
}

function buildHomestandEndNoStealPlain_(payload) {
  var lines = [
    "Game ended — no steals today",
    formatDisplayDate_(payload.dateChicago),
    "Last game of this homestand before the Sox go on the road.",
    "",
  ];
  if (payload.nextHomestand) {
    var nh = payload.nextHomestand;
    lines.push("Next homestand (" + formatDisplayDate_(nh.startDate) + " – " + formatDisplayDate_(nh.endDate) + "):");
    lines.push(buildHomestandGamesTablePlain_(nh));
    lines.push("");
    lines.push(CONFIG.homestandPromoLine);
    lines.push("");
    lines.push.apply(lines, buildPromoLinksPlain_());
  } else {
    lines.push("No upcoming homestand in the next " + CONFIG.scheduleLookaheadDays + " days.");
  }
  return lines.join("\n");
}

function buildHomestandGamesTableHtml_(homestand) {
  var hs = homestand;
  var parts = [];
  parts.push("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%;border-collapse:collapse;font-size:14px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;\">");
  parts.push(
    "<tr style=\"background:#111827;color:#fff;\">" +
      "<th align=\"left\" style=\"padding:10px 12px;font-weight:600;font-size:12px;letter-spacing:0.8px;text-transform:uppercase;\">Date</th>" +
      "<th align=\"left\" style=\"padding:10px 12px;font-weight:600;font-size:12px;letter-spacing:0.8px;text-transform:uppercase;\">Matchup</th>" +
      "<th align=\"left\" style=\"padding:10px 12px;font-weight:600;font-size:12px;letter-spacing:0.8px;text-transform:uppercase;\">Time</th>" +
      "</tr>"
  );
  for (var i = 0; i < hs.homeGames.length; i++) {
    var g = hs.homeGames[i];
    var rowBg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
    parts.push("<tr style=\"background:" + rowBg + ";\">");
    parts.push("<td style=\"padding:10px 12px;border-top:1px solid #e5e7eb;color:#111;white-space:nowrap;\">" + escapeHtml_(formatDisplayDate_(g.officialDate)) + "</td>");
    parts.push(
      "<td style=\"padding:10px 12px;border-top:1px solid #e5e7eb;\">" +
        teamLogoImgHtml_(g.opponentTeamId, g.opponent, 24, "vertical-align:middle;margin-right:8px;") +
        "<span style=\"vertical-align:middle;color:#374151;\">vs " + escapeHtml_(g.opponent) + (g.doubleHeader ? " (DH)" : "") + "</span>" +
        "</td>"
    );
    parts.push("<td style=\"padding:10px 12px;border-top:1px solid #e5e7eb;color:#374151;white-space:nowrap;\">" + escapeHtml_(g.timeLabel) + "</td>");
    parts.push("</tr>");
  }
  parts.push("</table>");
  return parts.join("");
}

function buildHomestandGamesTablePlain_(homestand) {
  var lines = [];
  for (var i = 0; i < homestand.homeGames.length; i++) {
    var g = homestand.homeGames[i];
    lines.push(formatDisplayDate_(g.officialDate) + " vs " + g.opponent + " — " + g.timeLabel);
  }
  return lines.join("\n");
}

/** Minimal CSS — Gmail Android ignores most of this but Apple Mail / some clients benefit. */
function buildEmailDarkModeGuardHtml_() {
  return (
    "<meta name=\"color-scheme\" content=\"light only\" />" +
    "<meta name=\"supported-color-schemes\" content=\"light\" />" +
    "<style type=\"text/css\">" +
    ".sox-email-root{color-scheme:light only;supported-color-schemes:light;}" +
    "</style>"
  );
}

/** Plain cap logo for light backgrounds — no circle. */
function teamLogoImgHtml_(teamId, alt, size, extraStyle) {
  if (!teamId) {
    return "";
  }
  var url = CONFIG.teamLogoUrlOnLight.replace("{teamId}", String(teamId));
  var px = size || 24;
  return (
    "<img src=\"" +
    url +
    "\" width=\"" +
    px +
    "\" height=\"" +
    px +
    "\" alt=\"" +
    escapeHtml_(alt || "Team logo") +
    "\" style=\"display:inline-block;" +
    (extraStyle || "") +
    "\" />"
  );
}

function teamSpotUrl_(teamId) {
  if (!teamId) {
    return "";
  }
  return "https://www.mlbstatic.com/team-logos/team-spot/" + teamId + ".svg";
}

/**
 * Circular team badge: uses MLB's official "team-spot" SVG which has the circle baked in.
 * Since it's an image, Gmail Dark Mode won't aggressively invert the background colors.
 */
function teamColorBadgeHtml_(teamId, alt, circleSize, wrapStyle) {
  if (!teamId) {
    return "";
  }
  var diameter = circleSize || 58;
  var url = teamSpotUrl_(teamId);
  return (
    "<img src=\"" +
    url +
    "\" width=\"" +
    diameter +
    "\" height=\"" +
    diameter +
    "\" alt=\"" +
    escapeHtml_(alt || "Team logo") +
    "\" style=\"display:inline-block;border:0;outline:none;border-radius:50%;width:" +
    diameter +
    "px;height:" +
    diameter +
    "px;min-width:" +
    diameter +
    "px;min-height:" +
    diameter +
    "px;max-width:" +
    diameter +
    "px;max-height:" +
    diameter +
    "px;vertical-align:middle;" +
    (wrapStyle || "") +
    "\" />"
  );
}

/** Small neutral "vs" puck shown between the two team badges. */
function vsBadgeHtml_(size, wrapStyle) {
  var diameter = size || 30;
  return (
    "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"display:inline-table;border-collapse:separate;vertical-align:middle;" +
    (wrapStyle || "") +
    "\"><tr><td align=\"center\" valign=\"middle\" width=\"" +
    diameter +
    "\" height=\"" +
    diameter +
    "\" bgcolor=\"#ffffff\" style=\"width:" +
    diameter +
    "px;height:" +
    diameter +
    "px;min-width:" +
    diameter +
    "px;min-height:" +
    diameter +
    "px;max-width:" +
    diameter +
    "px;max-height:" +
    diameter +
    "px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:50%;text-align:center;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:0.5px;color:#374151;text-transform:uppercase;line-height:" +
    (diameter - 2) +
    "px;box-sizing:border-box;\">vs</td></tr></table>"
  );
}

/**
 * Matchup header art: two team-color badges with a "vs" puck between them.
 * The badges are nudged vertically (home up, away down) so they read as a
 * diagonal score-bug; clients that drop the padding offsets degrade gracefully
 * to a clean side-by-side row.
 */
function buildMatchupBadgesHtml_(homeTeamId, homeName, awayTeamId, awayName, circleSize) {
  var diameter = circleSize || 58;
  var offset = Math.round(diameter * 0.32);
  var vsSize = Math.round(diameter * 0.52);
  var gap = Math.max(4, Math.round(vsSize * 0.25));
  if (!awayTeamId) {
    return teamColorBadgeHtml_(homeTeamId, homeName, diameter);
  }
  var parts = [];
  parts.push(
    "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"display:inline-table;border-collapse:collapse;table-layout:fixed;\"><tr>"
  );
  parts.push(
    "<td valign=\"top\" style=\"padding:0 " +
      gap +
      "px " +
      offset +
      "px 0;line-height:0;font-size:0;width:" +
      diameter +
      "px;\">" +
      teamColorBadgeHtml_(homeTeamId, homeName, diameter) +
      "</td>"
  );
  parts.push(
    "<td valign=\"middle\" style=\"padding:0;line-height:0;font-size:0;width:" +
      vsSize +
      "px;\">" +
      vsBadgeHtml_(vsSize) +
      "</td>"
  );
  parts.push(
    "<td valign=\"bottom\" style=\"padding:" +
      offset +
      "px 0 0 " +
      gap +
      "px;line-height:0;font-size:0;width:" +
      diameter +
      "px;\">" +
      teamColorBadgeHtml_(awayTeamId, awayName, diameter) +
      "</td>"
  );
  parts.push("</tr></table>");
  return parts.join("");
}

/** Steal email: always show next home game; homestand-finale copy on last home day before a road trip. */
function buildStealNextHomeBlockHtml_(nextHomeGame, isLastHomestandDay) {
  var parts = [];
  parts.push("<div style=\"background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:0 0 16px;\">");
  if (isLastHomestandDay) {
    parts.push("<div style=\"font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#9ca3af;margin:0 0 4px;\">Homestand finale</div>");
    parts.push("<h2 style=\"font-size:16px;margin:0 0 6px;line-height:1.3;\">Last game of this homestand — Sox head on the road</h2>");
    parts.push("<p style=\"margin:0 0 12px;color:#4b5563;font-size:14px;\">That wraps this homestand at Guaranteed Rate Field. Next time they are home:</p>");
  } else {
    parts.push("<div style=\"font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#9ca3af;margin:0 0 4px;\">Next Sox home game</div>");
  }
  parts.push(buildNextHomeGameBodyHtml_(nextHomeGame));
  parts.push("</div>");
  return parts.join("");
}

function buildStealNextHomeBlockPlain_(nextHomeGame, isLastHomestandDay) {
  var lines = [];
  if (isLastHomestandDay) {
    lines.push("Last game of this homestand — Sox head on the road.");
    lines.push("That wraps this homestand at Guaranteed Rate Field. Next time they are home:");
  } else {
    lines.push("Next Sox home game:");
  }
  lines.push(buildNextHomeGameBodyPlain_(nextHomeGame));
  return lines.join("\n");
}

function buildNextHomeGameBodyHtml_(nextHomeGame) {
  if (!nextHomeGame) {
    return "<p style=\"margin:0;color:#4b5563;\">No White Sox home game scheduled in the next " + CONFIG.scheduleLookaheadDays + " days.</p>";
  }
  var scheduleUrl =
    "https://www.mlb.com/whitesox/schedule/" + nextHomeGame.officialDate;
  var parts = [];
  parts.push(
    "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;margin:0 0 10px;\">" +
      "<tr><td style=\"vertical-align:middle;padding:0;white-space:nowrap;\">" +
      teamLogoImgHtml_(WHITE_SOX_ID, "Chicago White Sox", 36, "vertical-align:middle;margin-right:10px;") +
      "<span style=\"display:inline-block;vertical-align:middle;background:#e5e7eb;color:#374151;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:bold;letter-spacing:0.5px;margin-right:10px;\">vs</span>" +
      teamLogoImgHtml_(nextHomeGame.opponentTeamId, nextHomeGame.opponent, 36, "vertical-align:middle;") +
      "</td></tr></table>"
  );
  parts.push(
    "<p style=\"margin:0 0 12px;font-size:15px;color:#111;line-height:1.45;\"><strong>" +
      escapeHtml_(formatDisplayDate_(nextHomeGame.officialDate)) +
      "</strong> · " +
      escapeHtml_(nextHomeGame.opponent) +
      " · " +
      escapeHtml_(nextHomeGame.timeLabel) +
      "</p>"
  );
  parts.push(buildButtonHtml_(scheduleUrl, "View schedule"));
  return parts.join("");
}

function buildNextHomeGameBodyPlain_(nextHomeGame) {
  if (!nextHomeGame) {
    return "No home game scheduled in the next " + CONFIG.scheduleLookaheadDays + " days.";
  }
  return (
    formatDisplayDate_(nextHomeGame.officialDate) +
    " vs " +
    nextHomeGame.opponent +
    " — " +
    nextHomeGame.timeLabel
  );
}

// --- Steal reversal tracking -----------------------------------------------

function saveReportedSteal_(steal, dateChicago) {
  var payload = {
    dateChicago: dateChicago,
    gamePk: steal.gamePk,
    playerId: steal.playerId,
    playerName: steal.playerName,
    inningLabel: steal.inningLabel,
    baseLabel: steal.baseLabel,
    opponent: steal.opponent,
    opponentTeamId: steal.opponentTeamId,
    atBatIndex: steal.atBatIndex,
    playEventIndex: steal.playEventIndex,
    description: steal.description || "",
    atBatDescription: steal.atBatDescription || "",
  };
  PropertiesService.getScriptProperties().setProperty(PROP_STEAL_REPORTED, JSON.stringify(payload));
  log_("Stored reported steal for reversal checks", payload);
}

function getReportedSteal_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_STEAL_REPORTED);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    log_("Failed to parse reported steal payload", String(e));
    return null;
  }
}

function clearReportedSteal_(reason) {
  clearLatch_(PROP_STEAL_REPORTED, reason || "reported steal cleared");
}

/**
 * Re-check a steal we already emailed about. MLB may overturn it after a replay review.
 */
function checkStealReversalToday_(todayChicago, homeGames) {
  var reported = getReportedSteal_();
  if (!reported || reported.dateChicago !== todayChicago) {
    return;
  }

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_STEAL_CORRECTION_SENT) === todayChicago) {
    log_("Steal correction already sent today — skip", { todayChicago: todayChicago });
    return;
  }

  var status = getReportedStealStatus_(reported);
  log_("Reported steal status check", {
    player: reported.playerName,
    gamePk: reported.gamePk,
    stillValid: status.stillValid,
    reason: status.reason || "(ok)",
  });

  if (status.stillValid) {
    return;
  }

  sendStealCorrectionEmail_({
    dateChicago: todayChicago,
    reported: reported,
    reversal: status,
  });

  setLatch_(PROP_STEAL_CORRECTION_SENT, todayChicago, "steal correction email sent");
  clearLatch_(PROP_LAST_FIRED, "reported steal overturned — allow new steal alert today");
  clearReportedSteal_("steal overturned");
  clearLatch_(PROP_HOMESTAND_END_NOTIFIED, "false steal overturned — homestand end recap may apply");
}

/**
 * @returns {{ stillValid: boolean, reason?: string, playDescription?: string }}
 */
function getReportedStealStatus_(reported) {
  var box = boxscoreHomeSteals_(reported.gamePk);
  var feed = fetchJson_(MLB_FEED_API + "/game/" + reported.gamePk + "/feed/live");
  var feedSteals = getHomeStealsFromFeed_(reported.gamePk, box.opponent, "Final", box.opponentTeamId);

  for (var i = 0; i < feedSteals.length; i++) {
    var s = feedSteals[i];
    if (s.playerId === reported.playerId && s.atBatIndex === reported.atBatIndex) {
      return { stillValid: true, reason: "steal_still_in_feed" };
    }
  }

  var cs = findHomeCaughtStealingOnPlay_(feed, reported.atBatIndex, reported.playerId);
  if (cs) {
    return {
      stillValid: false,
      reason: "caught_stealing",
      playDescription: cs.playDescription || cs.description || "",
    };
  }

  var playerStats = getPlayerStealStatsInBoxscore_(reported.gamePk, reported.playerId);
  if (playerStats.cs > 0 && playerStats.sb === 0) {
    var playDesc = getPlayDescriptionFromFeed_(feed, reported.atBatIndex);
    return {
      stillValid: false,
      reason: "player_cs_in_boxscore",
      playDescription: playDesc,
    };
  }

  if (box.steals === 0 && !feedSteals.length) {
    return {
      stillValid: false,
      reason: "no_home_steals_in_boxscore",
      playDescription: getPlayDescriptionFromFeed_(feed, reported.atBatIndex),
    };
  }

  if (playerStats.sb === 0 && reported.playerId) {
    return {
      stillValid: false,
      reason: "player_sb_removed",
      playDescription: getPlayDescriptionFromFeed_(feed, reported.atBatIndex),
    };
  }

  return { stillValid: true, reason: "inconclusive" };
}

function getPlayDescriptionFromFeed_(feed, atBatIndex) {
  var plays = (feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) || [];
  for (var i = 0; i < plays.length; i++) {
    var about = plays[i].about || {};
    if (about.atBatIndex === atBatIndex && plays[i].result && plays[i].result.description) {
      return plays[i].result.description;
    }
  }
  return "";
}

function getPlayerStealStatsInBoxscore_(gamePk, playerId) {
  var box = fetchJson_(MLB_API + "/game/" + gamePk + "/boxscore");
  var home = box.teams && box.teams.home;
  if (!home || !home.players || !playerId) {
    return { sb: 0, cs: 0 };
  }
  var players = home.players;
  for (var key in players) {
    if (!players.hasOwnProperty(key)) {
      continue;
    }
    var p = players[key];
    var person = p.person || {};
    if (person.id !== playerId) {
      continue;
    }
    var batting = (p.stats && p.stats.batting) || {};
    return {
      sb: parseInt(batting.stolenBases, 10) || 0,
      cs: parseInt(batting.caughtStealing, 10) || 0,
    };
  }
  return { sb: 0, cs: 0 };
}

function findHomeCaughtStealingOnPlay_(feed, atBatIndex, playerId) {
  var plays = (feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) || [];
  var homeTeamId =
    feed.gameData && feed.gameData.teams && feed.gameData.teams.home && feed.gameData.teams.home.id;

  for (var i = 0; i < plays.length; i++) {
    var play = plays[i];
    var about = play.about || {};
    if (about.atBatIndex !== atBatIndex) {
      continue;
    }

    var playDescription = (play.result && play.result.description) || "";
    var runners = play.runners || [];
    for (var r = 0; r < runners.length; r++) {
      var details = runners[r].details || {};
      if (!isCaughtStealingEventType_(details.eventType)) {
        continue;
      }
      var runner = details.runner || {};
      if (playerId && runner.id !== playerId) {
        continue;
      }
      if (homeTeamId && details.team && details.team.id && details.team.id !== homeTeamId) {
        continue;
      }
      return {
        description: details.description || details.event || "",
        playDescription: playDescription,
      };
    }

    if (isOverturnedCaughtStealingPlay_(play)) {
      return {
        description: playDescription,
        playDescription: playDescription,
      };
    }
  }
  return null;
}

function isCaughtStealingEventType_(eventType) {
  return eventType && eventType.indexOf("caught_stealing") === 0;
}

function isOverturnedCaughtStealingPlay_(play) {
  var desc = (play.result && play.result.description) || "";
  return desc.indexOf("overturned") >= 0 && /caught stealing/i.test(desc);
}

function hasActiveReviewOnPlay_(play) {
  if (play.about && play.about.hasReview && !play.about.isComplete) {
    return true;
  }
  var events = play.playEvents || [];
  for (var i = 0; i < events.length; i++) {
    var rev = events[i].reviewDetails;
    if (rev && rev.inProgress) {
      return true;
    }
  }
  return false;
}

// --- Play-by-play ----------------------------------------------------------

/** e.g. "Miguel Vargas stole 2B" */
function formatStealCallout_(steal) {
  var name = (steal && steal.playerName) || "White Sox";
  var base = (steal && steal.baseLabel) || "a base";
  return name + " stole " + base;
}

/** MLB play-by-play text for the email body (steal line + parent at-bat when available). */
function getStealMlbDescriptions_(steal) {
  var lines = [];
  if (steal && steal.description) {
    lines.push(String(steal.description).trim());
  }
  if (steal && steal.atBatDescription) {
    var atBat = String(steal.atBatDescription).trim();
    if (atBat && lines.indexOf(atBat) === -1) {
      lines.push(atBat);
    }
  }
  return lines;
}

/**
 * Stolen bases by White Sox (home team) from live feed.
 * Steals may be a top-level play or a playEvent inside an at-bat (common in recent feeds).
 * @returns {Array<{gamePk:number,playerId:number,playerName:string,description:string,inningLabel:string,baseLabel:string,opponent:string,opponentTeamId:number,status:string,atBatIndex:number,playEventIndex:number,sortKey:number}>}
 */
function getHomeStealsFromFeed_(gamePk, opponent, status, opponentTeamId) {
  var url = MLB_FEED_API + "/game/" + gamePk + "/feed/live";
  var feed = fetchJson_(url);
  var plays = (feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) || [];
  var out = [];

  for (var i = 0; i < plays.length; i++) {
    var play = plays[i];
    if (hasActiveReviewOnPlay_(play) || isOverturnedCaughtStealingPlay_(play)) {
      continue;
    }
    var stealEvents = collectStealEventsFromPlay_(play);
    for (var e = 0; e < stealEvents.length; e++) {
      var ev = stealEvents[e];
      if (!isHomeTeamSteal_(play, ev, feed)) {
        continue;
      }

      var runner = resolveStealRunner_(play, ev, feed);
      var about = play.about || {};
      var half = about.halfInning === "top" ? "Top" : "Bot";
      var inningNum = about.inning || 0;
      var atBatIndex = about.atBatIndex != null ? about.atBatIndex : i;
      var playEventIndex = ev.playEventIndex != null ? ev.playEventIndex : 0;

      var atBatDescription =
        ev.source === "playEvent" && play.result && play.result.description ? play.result.description : "";

      out.push({
        gamePk: gamePk,
        playerId: runner.id,
        playerName: runner.name,
        description: ev.description || "",
        atBatDescription: atBatDescription,
        inningLabel: half + " " + inningNum,
        baseLabel: parseStolenBaseLabel_(ev.eventType, ev.event),
        opponent: opponent,
        opponentTeamId: opponentTeamId,
        status: status,
        atBatIndex: atBatIndex,
        playEventIndex: playEventIndex,
        sortKey: inningNum * 100000 + (about.halfInning === "bottom" ? 50000 : 0) + atBatIndex * 100 + playEventIndex,
      });
    }
  }

  return out;
}

/** Standalone steal play or embedded playEvent (e.g. steal during a single). */
function collectStealEventsFromPlay_(play) {
  var events = [];
  if (play.result && isStolenBaseEventType_(play.result.eventType)) {
    events.push({
      source: "result",
      eventType: play.result.eventType,
      event: play.result.event,
      description: play.result.description || "",
      playEventIndex: 0,
    });
  }
  var playEvents = play.playEvents || [];
  for (var p = 0; p < playEvents.length; p++) {
    var pe = playEvents[p];
    var det = pe.details || {};
    if (!isStolenBaseEventType_(det.eventType)) {
      continue;
    }
    events.push({
      source: "playEvent",
      playEvent: pe,
      eventType: det.eventType,
      event: det.event,
      description: det.description || "",
      playEventIndex: pe.index != null ? pe.index : p,
    });
  }
  return events;
}

/** MLB API uses stolen_base_2b / stolen_base_3b / stolen_base_home, never bare "stolen_base". */
function isStolenBaseEventType_(eventType) {
  if (!eventType) {
    return false;
  }
  return eventType.indexOf("stolen_base") === 0;
}

function isHomeTeamSteal_(play, stealEvent, feed) {
  var homeTeamId =
    feed.gameData &&
    feed.gameData.teams &&
    feed.gameData.teams.home &&
    feed.gameData.teams.home.id;
  if (!homeTeamId) {
    return play.about && play.about.halfInning === "bottom";
  }

  var runners = play.runners || [];
  for (var r = 0; r < runners.length; r++) {
    var details = runners[r].details || {};
    if (!isStolenBaseEventType_(details.eventType) || !details.runner || !details.runner.id) {
      continue;
    }
    if (stealEvent.source === "playEvent" && stealEvent.playEvent && stealEvent.playEvent.player) {
      if (details.runner.id !== stealEvent.playEvent.player.id) {
        continue;
      }
    }
    var teamId = details.team && details.team.id;
    if (teamId === homeTeamId) {
      return true;
    }
  }

  if (stealEvent.source === "playEvent" && stealEvent.playEvent && stealEvent.playEvent.player) {
    var playerId = stealEvent.playEvent.player.id;
    if (isPlayerOnTeamInFeed_(playerId, homeTeamId, feed)) {
      return true;
    }
  }

  return play.about && play.about.halfInning === "bottom";
}

function resolveStealRunner_(play, stealEvent, feed) {
  if (stealEvent.source === "playEvent" && stealEvent.playEvent && stealEvent.playEvent.player) {
    var pePlayer = stealEvent.playEvent.player;
    var id = pePlayer.id;
    var name =
      lookupPlayerNameInFeed_(id, feed) ||
      parseRunnerNameFromStealDescription_(stealEvent.description) ||
      "Unknown";
    return { id: id, name: name };
  }
  return extractStealRunner_(play);
}

function extractStealRunner_(play) {
  var runners = play.runners || [];
  for (var r = 0; r < runners.length; r++) {
    var d = runners[r].details || {};
    if (isStolenBaseEventType_(d.eventType) && d.runner) {
      return { id: d.runner.id, name: d.runner.fullName || "Unknown" };
    }
  }
  var batter = play.matchup && play.matchup.batter;
  if (batter) {
    return { id: batter.id, name: batter.fullName || "Unknown" };
  }
  return { id: 0, name: "White Sox runner" };
}

function lookupPlayerNameInFeed_(playerId, feed) {
  if (!playerId || !feed || !feed.liveData || !feed.liveData.boxscore) {
    return "";
  }
  var teams = feed.liveData.boxscore.teams || {};
  for (var side in teams) {
    if (!teams.hasOwnProperty(side)) {
      continue;
    }
    var players = (teams[side] && teams[side].players) || {};
    for (var key in players) {
      if (!players.hasOwnProperty(key)) {
        continue;
      }
      var person = players[key].person;
      if (person && person.id === playerId) {
        return person.fullName || "";
      }
    }
  }
  return "";
}

function isPlayerOnTeamInFeed_(playerId, teamId, feed) {
  if (!playerId || !teamId || !feed || !feed.liveData || !feed.liveData.boxscore) {
    return false;
  }
  var teams = feed.liveData.boxscore.teams || {};
  for (var side in teams) {
    if (!teams.hasOwnProperty(side)) {
      continue;
    }
    var team = teams[side].team;
    if (!team || team.id !== teamId) {
      continue;
    }
    var players = teams[side].players || {};
    for (var key in players) {
      if (!players.hasOwnProperty(key)) {
        continue;
      }
      var person = players[key].person;
      if (person && person.id === playerId) {
        return true;
      }
    }
  }
  return false;
}

function parseRunnerNameFromStealDescription_(description) {
  if (!description) {
    return "";
  }
  var m = String(description).match(/^(.+?)\s+steals?\b/i);
  return m ? m[1].trim() : "";
}

/** First home player with a stolen base in the boxscore (fallback when feed has no steal plays). */
function getHomeStealerFromBoxscore_(gamePk) {
  var box = fetchJson_(MLB_API + "/game/" + gamePk + "/boxscore");
  var home = box.teams && box.teams.home;
  if (!home || !home.players) {
    return null;
  }
  var players = home.players;
  for (var key in players) {
    if (!players.hasOwnProperty(key)) {
      continue;
    }
    var p = players[key];
    var sb = p.stats && p.stats.batting && p.stats.batting.stolenBases;
    if (sb && parseInt(sb, 10) > 0) {
      var person = p.person || {};
      return { id: person.id || 0, name: person.fullName || "White Sox" };
    }
  }
  return null;
}

/**
 * Prefer eventType suffix (stolen_base_2b → "2B", stolen_base_home → "home").
 * Falls back to parsing the event description.
 */
function parseStolenBaseLabel_(eventType, eventStr) {
  if (eventType) {
    var suffix = eventType.replace(/^stolen_base_?/i, "");
    if (suffix) {
      if (suffix.toLowerCase() === "home") {
        return "home";
      }
      var m1 = suffix.match(/^(\d)b$/i);
      if (m1) {
        return m1[1] + "B";
      }
    }
  }
  if (eventStr) {
    var m2 = eventStr.match(/(\dB)/i);
    if (m2) {
      return m2[1].toUpperCase();
    }
    var stripped = eventStr.replace(/^Stolen Base\s*/i, "");
    if (stripped) {
      return stripped;
    }
  }
  return "a base";
}

function compareStealsChronologically_(a, b) {
  var ka = a.sortKey != null ? a.sortKey : 0;
  var kb = b.sortKey != null ? b.sortKey : 0;
  if (ka !== kb) {
    return ka - kb;
  }
  return (a.atBatIndex || 0) - (b.atBatIndex || 0);
}

function buildFallbackSteal_(game, totalSb) {
  var box = boxscoreHomeSteals_(game.gamePk);
  var stealer = getHomeStealerFromBoxscore_(game.gamePk);
  return {
    gamePk: game.gamePk,
    playerId: stealer ? stealer.id : 0,
    playerName: stealer ? stealer.name : "White Sox",
    description: "",
    atBatDescription: "",
    inningLabel: "Today",
    baseLabel: "a base",
    opponent: box.opponent,
    opponentTeamId: box.opponentTeamId,
    status: game.abstractGameState || "",
    atBatIndex: 0,
    playEventIndex: 0,
    sortKey: 0,
  };
}

// --- Schedule / homestand --------------------------------------------------

function fetchSoxScheduleRange_(startYmd, endYmd) {
  var url =
    MLB_API +
    "/schedule?sportId=1&teamId=" +
    WHITE_SOX_ID +
    "&startDate=" +
    encodeURIComponent(startYmd) +
    "&endDate=" +
    encodeURIComponent(endYmd);
  var data = fetchJson_(url);
  var out = [];
  var dates = data.dates || [];
  for (var d = 0; d < dates.length; d++) {
    var games = dates[d].games || [];
    for (var i = 0; i < games.length; i++) {
      out.push(normalizeScheduleGame_(games[i]));
    }
  }
  out.sort(function (a, b) {
    var da = a.officialDate + a.gameDate;
    var db = b.officialDate + b.gameDate;
    if (da !== db) {
      return da < db ? -1 : 1;
    }
    return (a.gamePk || 0) - (b.gamePk || 0);
  });
  return out;
}

function normalizeScheduleGame_(g) {
  var home = g.teams && g.teams.home;
  var away = g.teams && g.teams.away;
  var isHome = home && home.team && home.team.id === WHITE_SOX_ID;
  var opponentTeam = isHome ? away : home;
  var st = g.status || {};
  var tbd = st.startTimeTBD === true;
  var gameDate = g.gameDate || "";
  var timeLabel = tbd ? "TBD" : formatGameTimeChicago_(gameDate);

  return {
    gamePk: g.gamePk,
    officialDate: g.officialDate || chicagoDateStringFromIso_(gameDate),
    gameDate: gameDate,
    isHome: isHome,
    opponent: (opponentTeam && opponentTeam.team && opponentTeam.team.name) || "?",
    opponentTeamId: (opponentTeam && opponentTeam.team && opponentTeam.team.id) || null,
    abstractGameState: st.abstractGameState || "",
    timeLabel: timeLabel,
    doubleHeader: g.doubleHeader === "Y" || g.doubleHeader === true,
  };
}

/**
 * Homestand = every consecutive White Sox home game between road trips (typically ~6–7 games).
 * Walks the full schedule in date order; an away game ends the current block. Off days with
 * no scheduled game do not split a homestand. Doubleheaders count as separate homeGames entries.
 *
 * @returns {Array<{startDate:string,endDate:string,homeGames:Array}>}
 */
function buildHomestands_(games) {
  var homestands = [];
  var current = null;

  for (var i = 0; i < games.length; i++) {
    var g = games[i];
    if (!g.isHome) {
      if (current) {
        homestands.push(current);
        current = null;
      }
      continue;
    }
    if (!current) {
      current = {
        startDate: g.officialDate,
        endDate: g.officialDate,
        homeGames: [g],
      };
    } else {
      current.endDate = g.officialDate;
      current.homeGames.push(g);
    }
  }
  if (current) {
    homestands.push(current);
  }
  return homestands;
}

function describeHomestand_(homestand) {
  return {
    startDate: homestand.startDate,
    endDate: homestand.endDate,
    homeGameCount: homestand.homeGames.length,
  };
}

function buildHomestandsFromScheduleAround_(ymd) {
  var startYmd = addDaysYmd_(ymd, -CONFIG.scheduleLookbackDays);
  var endYmd = addDaysYmd_(ymd, CONFIG.scheduleLookaheadDays);
  return buildHomestands_(fetchSoxScheduleRange_(startYmd, endYmd));
}

function getHomestandForDate_(homestands, ymd) {
  for (var i = 0; i < homestands.length; i++) {
    var hs = homestands[i];
    for (var j = 0; j < hs.homeGames.length; j++) {
      if (hs.homeGames[j].officialDate === ymd) {
        return hs;
      }
    }
  }
  return null;
}

/**
 * True when ymd is the last calendar day of this homestand (last home date before the next road trip).
 */
function isLastHomestandHomeDate_(homestand, ymd) {
  if (!homestand || !homestand.homeGames.length) {
    return false;
  }
  return ymd === homestand.endDate;
}

/** First home game strictly after ymd, searching an already-built homestand list (no extra API call). */
function getNextHomeGameAfterFromHomestands_(homestands, ymd) {
  for (var i = 0; i < homestands.length; i++) {
    var hs = homestands[i];
    for (var j = 0; j < hs.homeGames.length; j++) {
      var g = hs.homeGames[j];
      if (g.officialDate > ymd) {
        return g;
      }
    }
  }
  return null;
}

/** Next consecutive-home block after the given homestand. */
function getNextHomestandAfter_(homestands, current) {
  if (!current || !homestands.length) {
    return null;
  }
  var idx = -1;
  for (var i = 0; i < homestands.length; i++) {
    if (homestands[i].startDate === current.startDate) {
      idx = i;
      break;
    }
  }
  if (idx < 0 || idx >= homestands.length - 1) {
    return null;
  }
  return homestands[idx + 1];
}

/** First homestand with startDate on or after ymd. */
function getUpcomingHomestand_(homestands, ymd) {
  for (var i = 0; i < homestands.length; i++) {
    if (homestands[i].startDate >= ymd) {
      return homestands[i];
    }
  }
  return homestands.length ? homestands[homestands.length - 1] : null;
}

/** Last homestand whose endDate is on or before ymd. */
function getMostRecentHomestandOnOrBefore_(homestands, ymd) {
  var best = null;
  for (var i = 0; i < homestands.length; i++) {
    if (homestands[i].endDate <= ymd) {
      best = homestands[i];
    }
  }
  return best;
}

function allHomeGamesFinal_(homeGames) {
  for (var i = 0; i < homeGames.length; i++) {
    if (homeGames[i].abstractGameState !== "Final") {
      return false;
    }
  }
  return true;
}

function countHomeStealsToday_(homeGames) {
  var total = 0;
  for (var i = 0; i < homeGames.length; i++) {
    total += boxscoreHomeSteals_(homeGames[i].gamePk).steals;
  }
  return total;
}

// --- Triggers --------------------------------------------------------------

/** Valid Google minutes intervals: 1, 5, 10, 15, 30 */
function installCheckTrigger(everyMinutes) {
  var n = everyMinutes || 5;
  log_("installCheckTrigger", { everyMinutes: n });
  removeCheckTriggers();
  ScriptApp.newTrigger("checkSoxHomeStealsToday")
    .timeBased()
    .everyMinutes(n)
    .create();
}

function installHomestandPreviewTrigger() {
  log_("installHomestandPreviewTrigger", { at: "9:00 America/Chicago daily" });
  removeHomestandPreviewTriggers();
  ScriptApp.newTrigger("checkHomestandStartToday")
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .inTimezone(CHICAGO_TZ)
    .create();
}

function removeCheckTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkSoxHomeStealsToday") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function removeHomestandPreviewTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkHomestandStartToday") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function resetNotifyLatch() {
  clearLatch_(PROP_LAST_FIRED, "manual reset");
}

function resetStealReportedLatch() {
  clearReportedSteal_("manual reset");
}

function resetStealCorrectionLatch() {
  clearLatch_(PROP_STEAL_CORRECTION_SENT, "manual reset");
}

function resetHomestandPreviewLatch() {
  clearLatch_(PROP_HOMESTAND_PREVIEW, "manual reset");
}

function resetHomestandEndLatch() {
  clearLatch_(PROP_HOMESTAND_END_NOTIFIED, "manual reset");
}

function logAllLatches() {
  logLatches_("manual logAllLatches");
}

// --- Tests -----------------------------------------------------------------

/**
 * Steal email test — REAL MLB data for gamePk (default 824595 / pass another gamePk).
 * Email header date is TODAY (Chicago). Uses same homestand / next-home logic as production.
 */
function testStealEmail(gamePk) {
  var todayChicago = chicagoDateString_(new Date());
  var pk = gamePk || 824595;
  var homestands = buildHomestandsFromScheduleAround_(todayChicago);
  var homestand = getHomestandForDate_(homestands, todayChicago);
  var nextHomeGame = getNextHomeGameAfterFromHomestands_(homestands, todayChicago);
  var isLastHomestandDay = homestand && isLastHomestandHomeDate_(homestand, todayChicago);

  log_("[TEST] testStealEmail — real game from MLB API", {
    gamePk: pk,
    headerDateChicago: todayChicago,
    homestand: homestand ? describeHomestand_(homestand) : null,
    isLastHomestandDay: isLastHomestandDay,
    nextHomeGame: nextHomeGame ? nextHomeGame.officialDate + " vs " + nextHomeGame.opponent : null,
  });

  var box = boxscoreHomeSteals_(pk);
  var steals = getHomeStealsFromFeed_(pk, box.opponent, "Final", box.opponentTeamId);
  var steal = steals.length ? steals[0] : buildFallbackSteal_({ gamePk: pk, abstractGameState: "Final" }, box.steals || 1);
  log_("[TEST] steal payload", steal);

  sendStealEmailHtml_({
    dateChicago: todayChicago,
    steal: steal,
    isLastHomestandDay: isLastHomestandDay,
    nextHomeGame: nextHomeGame,
  });
}

/**
 * Homestand preview test — REAL MLB schedule. Uses today's homestand if any, else next upcoming homestand.
 */
function testHomestandPreview() {
  var todayChicago = chicagoDateString_(new Date());
  var homestands = buildHomestandsFromScheduleAround_(todayChicago);
  var homestand = getHomestandForDate_(homestands, todayChicago);
  if (!homestand) {
    homestand = getUpcomingHomestand_(homestands, todayChicago);
    log_("[TEST] testHomestandPreview — no homestand today, using next upcoming", {
      todayChicago: todayChicago,
      homestand: homestand.startDate + "–" + homestand.endDate,
    });
  } else {
    log_("[TEST] testHomestandPreview — homestand containing today (real schedule)", {
      todayChicago: todayChicago,
      homestand: homestand.startDate + "–" + homestand.endDate,
      homeGames: homestand.homeGames.length,
    });
  }
  sendHomestandPreviewEmailHtml_({ dateChicago: todayChicago, homestand: homestand });
}

/**
 * Homestand end (no steal) test — REAL MLB schedule. Uses today's homestand + next after it (production logic).
 */
function testHomestandEndNoSteal() {
  var todayChicago = chicagoDateString_(new Date());
  var homestands = buildHomestandsFromScheduleAround_(todayChicago);
  var homestand = getHomestandForDate_(homestands, todayChicago);
  var nextHomestand;

  if (homestand) {
    nextHomestand = getNextHomestandAfter_(homestands, homestand);
    log_("[TEST] testHomestandEndNoSteal — homestand containing today", {
      homestand: homestand.startDate + "–" + homestand.endDate,
    });
  } else {
    var recent = getMostRecentHomestandOnOrBefore_(homestands, todayChicago);
    if (recent) {
      homestand = recent;
      nextHomestand = getNextHomestandAfter_(homestands, recent) || getUpcomingHomestand_(homestands, todayChicago);
      log_("[TEST] testHomestandEndNoSteal — using most recent ended homestand", {
        homestand: recent.startDate + "–" + recent.endDate,
      });
    } else {
      var upcoming = getUpcomingHomestand_(homestands, todayChicago);
      homestand = upcoming || { startDate: todayChicago, endDate: todayChicago, homeGames: [] };
      nextHomestand = upcoming ? getNextHomestandAfter_(homestands, upcoming) : null;
      log_("[TEST] testHomestandEndNoSteal — no past homestand, simulating with next upcoming", {
        homestand: upcoming ? upcoming.startDate + "–" + upcoming.endDate : "(none)",
      });
    }
  }

  log_("[TEST] next homestand after that block (real schedule)", {
    nextHomestand: nextHomestand ? nextHomestand.startDate + "–" + nextHomestand.endDate : "(none in window)",
    gamesInNext: nextHomestand ? nextHomestand.homeGames.length : 0,
  });

  sendHomestandEndNoStealEmail_({
    dateChicago: todayChicago,
    homestand: homestand,
    nextHomestand: nextHomestand,
  });
}

/**
 * Steal correction test — uses game 824583 (Meidroth CS overturn) by default.
 */
function testStealCorrectionEmail(gamePk) {
  var todayChicago = chicagoDateString_(new Date());
  var pk = gamePk || 824583;
  var box = boxscoreHomeSteals_(pk);
  var reported = {
    dateChicago: todayChicago,
    gamePk: pk,
    playerId: 805367,
    playerName: "Chase Meidroth",
    inningLabel: "Bot 2",
    baseLabel: "2B",
    opponent: box.opponent,
    opponentTeamId: box.opponentTeamId,
    atBatIndex: 13,
    playEventIndex: 0,
    description: "Chase Meidroth steals (1) 2nd base.",
    atBatDescription: "",
  };
  var status = getReportedStealStatus_(reported);
  log_("[TEST] testStealCorrectionEmail", { gamePk: pk, status: status });

  sendStealCorrectionEmail_({
    dateChicago: todayChicago,
    reported: reported,
    reversal: status.stillValid
      ? {
          reason: "test",
          playDescription:
            "Guardians challenged (tag play), call on the field was overturned: Braden Montgomery called out on strikes and Chase Meidroth caught stealing 2nd, catcher Patrick Bailey to shortstop Brayan Rocchio to catcher Patrick Bailey.",
        }
      : status,
  });
}

// --- MLB helpers -----------------------------------------------------------

function hasSoxHomeGameTodayOrSoon_() {
  var today = fetchSoxHomeGamesToday_();
  if (today.length) {
    log_("Sox home game today — will poll", {
      games: today.map(function (g) {
        return { gamePk: g.gamePk, status: g.abstractGameState };
      }),
    });
    return true;
  }

  var now = new Date();
  var tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowChicago = chicagoDateString_(tomorrow);
  var url =
    MLB_API +
    "/schedule?sportId=1&teamId=" +
    WHITE_SOX_ID +
    "&date=" +
    encodeURIComponent(tomorrowChicago);
  try {
    var data = fetchJson_(url);
    var dates = data.dates || [];
    for (var d = 0; d < dates.length; d++) {
      var games = dates[d].games || [];
      for (var i = 0; i < games.length; i++) {
        var g = games[i];
        var homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
        if (homeId !== WHITE_SOX_ID) {
          continue;
        }
        var gameDate = g.gameDate ? new Date(g.gameDate) : null;
        if (gameDate && gameDate.getTime() - now.getTime() <= 12 * 60 * 60 * 1000 && gameDate > now) {
          log_("Sox home game starting within 12 hours — will poll", {
            gamePk: g.gamePk,
            gameDate: g.gameDate,
          });
          return true;
        }
      }
    }
  } catch (e) {
    log_("hasSoxHomeGameTodayOrSoon_ schedule check failed", String(e));
  }
  log_("No Sox home game today or within 12 hours");
  return false;
}

function chicagoDateString_(date) {
  return Utilities.formatDate(date, CHICAGO_TZ, "yyyy-MM-dd");
}

function chicagoDateStringFromIso_(iso) {
  if (!iso) {
    return chicagoDateString_(new Date());
  }
  return chicagoDateString_(new Date(iso));
}

function addDaysYmd_(ymd, days) {
  var parts = ymd.split("-");
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, CHICAGO_TZ, "yyyy-MM-dd");
}

function formatDisplayDate_(ymd) {
  var parts = ymd.split("-");
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return Utilities.formatDate(d, CHICAGO_TZ, "EEEE, MMM d, yyyy");
}

function formatGameTimeChicago_(gameDateIso) {
  if (!gameDateIso) {
    return "TBD";
  }
  return Utilities.formatDate(new Date(gameDateIso), CHICAGO_TZ, "h:mm a z");
}

function getNotifyEmail_() {
  var fromProp = PropertiesService.getScriptProperties().getProperty(PROP_NOTIFY_EMAIL);
  if (fromProp) {
    return fromProp;
  }
  return Session.getActiveUser().getEmail();
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("HTTP " + code + " " + url);
  }
  return JSON.parse(res.getContentText());
}

function fetchSoxHomeGamesToday_() {
  var ymd = chicagoDateString_(new Date());
  var url =
    MLB_API +
    "/schedule?sportId=1&teamId=" +
    WHITE_SOX_ID +
    "&date=" +
    encodeURIComponent(ymd);
  var data = fetchJson_(url);
  var out = [];
  var dates = data.dates || [];
  for (var d = 0; d < dates.length; d++) {
    var games = dates[d].games || [];
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      var homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
      if (homeId === WHITE_SOX_ID) {
        var st = g.status || {};
        out.push({
          gamePk: g.gamePk,
          abstractGameState: st.abstractGameState || "",
        });
      }
    }
  }
  return out;
}

function boxscoreHomeSteals_(gamePk) {
  var box = fetchJson_(MLB_API + "/game/" + gamePk + "/boxscore");
  var home = box.teams && box.teams.home;
  var away = box.teams && box.teams.away;
  var opponent = (away && away.team && away.team.name) || "?";
  var opponentTeamId = (away && away.team && away.team.id) || null;
  var raw = home && home.teamStats && home.teamStats.batting && home.teamStats.batting.stolenBases;
  var steals = parseInt(raw, 10);
  if (isNaN(steals)) {
    steals = 0;
  }
  return { steals: steals, opponent: opponent, opponentTeamId: opponentTeamId };
}