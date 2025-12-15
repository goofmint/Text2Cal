"use strict";
const COLORS_SHEET_NAME = "colors";
const DEFAULT_CALENDAR_ID = "primary";
const GEMINI_MODEL = "gemini-2.5-flash";
const CACHE_TTL_SECONDS = 60 * 5;
const CACHE_COLORS_KEY = "CACHE_COLORS_ROWS_V3";
function doPost(e) {
  try {
    const body = parseRequest_(e);
    const expected = getProp_("SHARED_SECRET");
    if (body.secret !== expected) {
      return jsonResponse_({ ok: false, error: "Unauthorized" }, 401);
    }
    const timeZone = getUserTimeZone_();
    const nowIso = body.nowIso || (/* @__PURE__ */ new Date()).toISOString();
    const parsed = parseWithGemini_(body.text, nowIso, timeZone);
    const colorId = resolveOrAssignColorIdByLabel_(parsed.label);
    if (body.dryRun) {
      return jsonResponse_({
        ok: true,
        timeZone,
        parsed,
        resolved: { colorId }
      });
    }
    const calendarId = getPropOptional_("CALENDAR_ID") || DEFAULT_CALENDAR_ID;
    const created = createCalendarEvent_(calendarId, parsed, colorId);
    return jsonResponse_({
      ok: true,
      timeZone,
      parsed,
      resolved: { colorId },
      created: {
        id: created.id,
        status: created.status,
        htmlLink: created.htmlLink
      }
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}
function parseRequest_(e) {
  const raw = e?.postData?.contents ?? "";
  if (!raw) throw new Error("Empty request body.");
  const obj = JSON.parse(raw);
  if (!obj.text || typeof obj.text !== "string") throw new Error("Missing 'text' (string).");
  if (!obj.secret || typeof obj.secret !== "string") throw new Error("Missing 'secret' (string).");
  return {
    text: obj.text,
    nowIso: typeof obj.nowIso === "string" ? obj.nowIso : void 0,
    secret: obj.secret,
    dryRun: !!obj.dryRun
  };
}
function jsonResponse_(obj, _status = 200) {
  const out = ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (typeof out.setHeader === "function") out.setHeader("Cache-Control", "no-store");
  return out;
}
function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Missing script property: ${key}`);
  return v;
}
function getPropOptional_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
function getUserTimeZone_() {
  return Session.getScriptTimeZone() || "UTC";
}
function colorsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(COLORS_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet not found: ${COLORS_SHEET_NAME}`);
  return sheet;
}
function invalidateCache() {
  CacheService.getScriptCache().remove(CACHE_COLORS_KEY);
}
function loadColorsRows_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_COLORS_KEY);
  if (cached) return JSON.parse(cached);
  const sheet = colorsSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error("colors sheet has no data rows.");
  const header = values[0].map((v) => String(v).trim());
  const idxId = header.indexOf("colorId");
  const idxLabel = header.indexOf("label");
  const idxBg = header.indexOf("background");
  const idxFg = header.indexOf("foreground");
  if (idxId < 0 || idxLabel < 0 || idxBg < 0 || idxFg < 0) {
    throw new Error("colors header must be: colorId | label | background | foreground");
  }
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const colorId = String(r[idxId] ?? "").trim();
    if (!colorId) continue;
    rows.push({
      rowIndex: i + 1,
      colorId,
      label: String(r[idxLabel] ?? "").trim(),
      background: String(r[idxBg] ?? "").trim(),
      foreground: String(r[idxFg] ?? "").trim()
    });
  }
  rows.sort((a, b) => Number(a.colorId) - Number(b.colorId));
  cache.put(CACHE_COLORS_KEY, JSON.stringify(rows), CACHE_TTL_SECONDS);
  return rows;
}
function normalizeLabel_(label) {
  return label.trim().replace(/^#/, "").trim();
}
function resolveOrAssignColorIdByLabel_(label) {
  if (!label) return void 0;
  const normalized = normalizeLabel_(label);
  if (!normalized) return void 0;
  const rows = loadColorsRows_();
  const found = rows.find((r) => normalizeLabel_(r.label) === normalized);
  if (found) return found.colorId;
  const empty = rows.find((r) => !r.label);
  if (!empty) throw new Error(`No empty label slots left in colors sheet for label: ${normalized}`);
  const sheet = colorsSheet_();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((v) => String(v).trim());
  const labelColIdx = header.indexOf("label");
  if (labelColIdx < 0) throw new Error("colors header missing 'label' column.");
  sheet.getRange(empty.rowIndex, labelColIdx + 1).setValue(normalized);
  invalidateCache();
  return empty.colorId;
}
function createCalendarEvent_(calendarId, ev, colorId) {
  const resource = {
    summary: ev.title,
    location: ev.location ?? void 0,
    start: { dateTime: ev.start, timeZone: ev.timezone },
    end: { dateTime: ev.end, timeZone: ev.timezone },
    recurrence: ev.recurrence ? [`RRULE:${ev.recurrence.rrule}`] : void 0,
    colorId
  };
  return Calendar.Events.insert(resource, calendarId);
}
function parseWithGemini_(text, nowIso, timeZone) {
  const apiKey = getProp_("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = buildPrompt_(text, nowIso, timeZone);
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 }
  };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const raw = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`Gemini API error: HTTP ${code} ${raw}`);
  const data = JSON.parse(raw);
  const outText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!outText) throw new Error("Gemini returned empty output.");
  const parsed = safeJsonParse_(outText);
  validateParsed_(parsed, timeZone);
  return parsed;
}
function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Gemini output is not JSON: ${text}`);
    return JSON.parse(m[0]);
  }
}
function validateParsed_(obj, timeZone) {
  const required = ["title", "location", "label", "timezone", "start", "end", "recurrence"];
  for (const k of required) if (!(k in obj)) throw new Error(`Missing field: ${k}`);
  if (obj.timezone !== timeZone) throw new Error(`timezone must be exactly "${timeZone}"`);
  if (typeof obj.title !== "string" || !obj.title.trim()) throw new Error("title must be non-empty string");
  if (!(obj.location === null || typeof obj.location === "string")) throw new Error("location must be string|null");
  if (!(obj.label === null || typeof obj.label === "string")) throw new Error("label must be string|null");
  if (typeof obj.start !== "string" || typeof obj.end !== "string") throw new Error("start/end must be strings");
  if (!(obj.recurrence === null || typeof obj.recurrence === "object" && typeof obj.recurrence.rrule === "string")) {
    throw new Error("recurrence must be null or { rrule: string }");
  }
  if (!/[+-]\d{2}:\d{2}$/.test(obj.start)) throw new Error("start must end with timezone offset like +09:00");
  if (!/[+-]\d{2}:\d{2}$/.test(obj.end)) throw new Error("end must end with timezone offset like +09:00");
}
function buildPrompt_(text, nowIso, timeZone) {
  return `You are a multilingual parser that converts free-form schedule text into ONE Google Calendar event object.
The input may be Japanese, English, or other languages.

Return ONLY a JSON object with EXACT fields:
title, location, label, timezone, start, end, recurrence

Constraints:
- timezone must be exactly: "${timeZone}" (IANA timezone string)
- start/end must be ISO 8601 with timezone OFFSET, e.g. "2025-12-15T15:00:00+09:00"

Extraction markers (language-agnostic):
- "#<label>" assigns label. Take text after "#" until whitespace/end. If missing, label=null.
- "@<place>" or "\uFF20<place>" assigns location. Take text after @ until end (trim). If missing, location=null.
- Duration may be specified in brackets:
  - Japanese: [30\u5206], [90\u5206], [1\u6642\u9593]
  - English: [30m], [30min], [30 minutes], [1h], [1 hour]
  - If duration missing, default duration = 60 minutes.

Title rules:
- Remove date/time tokens, recurrence tokens, duration brackets, #label, @location from the title.
- The remaining text is title. If empty, title="Event".

Date/time interpretation (IMPORTANT):
- Interpret dates/times in timezone "${timeZone}".
- Use CURRENT_TIME_ISO as the reference "now".
- Relative day examples:
  - Japanese: \u4ECA\u65E5, \u660E\u65E5, \u660E\u5F8C\u65E5
  - English: today, tomorrow, the day after tomorrow
- Weekdays examples:
  - Japanese: \u6708 \u706B \u6C34 \u6728 \u91D1 \u571F \u65E5 (optionally with \u66DC\u65E5)
  - English: Monday Tuesday Wednesday Thursday Friday Saturday Sunday
- If weekday is specified without a date, choose the NEXT occurrence after now;
  if today matches and the time is still in the future, you may use today.
- If time is missing, assume 09:00.

Time examples:
- Japanese: 15\u6642 => 15:00, 15:30 => 15:30, \u5348\u5F8C3\u6642 => 15:00
- English: 3pm => 15:00, 15:00 => 15:00, 3:30 PM => 15:30

Recurrence normalization:
- Weekly examples: "\u6BCE\u9031\u706B\u66DC\u65E5", "every Tuesday", "weekly on Tuesday"
  => recurrence={"rrule":"FREQ=WEEKLY;BYDAY=TU"}
- Biweekly examples: "\u9694\u9031\u65E5\u66DC\u65E5", "every other Sunday", "biweekly on Sunday"
  => recurrence={"rrule":"FREQ=WEEKLY;INTERVAL=2;BYDAY=SU"}
- Otherwise recurrence=null.
- BYDAY mapping for Japanese weekdays: \u6708=MO \u706B=TU \u6C34=WE \u6728=TH \u91D1=FR \u571F=SA \u65E5=SU

If date/time cannot be confidently parsed:
- Choose the earliest reasonable upcoming time: today 09:00 if still future else tomorrow 09:00 (in "${timeZone}").

INPUT: ${text}
CURRENT_TIME_ISO: ${nowIso}

Return only the JSON object.`;
}
function test_doPost_dryRun_en() {
  const body = {
    text: "Tomorrow 2pm Meeting #ClientA [30min] @Shibuya Office",
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: true
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } };
  Logger.log(doPost(e).getContent());
}
function test_doPost_dryRun_ja() {
  const body = {
    text: "\u660E\u65E514\u6642 \u6253\u3061\u5408\u308F\u305B #\u30AF\u30E9\u30A4\u30A2\u30F3\u30C8A [30\u5206] @\u6E0B\u8C37\u30AA\u30D5\u30A3\u30B9",
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: true
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } };
  Logger.log(doPost(e).getContent());
}
function test_doPost_realCreate_en() {
  const body = {
    text: "[AUTO-TEST] Tomorrow 4pm Review #ClientB [15min] @Online",
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: false
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } };
  Logger.log(doPost(e).getContent());
}
function test_doPost_realCreate_ja() {
  const body = {
    text: "[AUTO-TEST] \u660E\u65E516\u6642 \u30EC\u30D3\u30E5\u30FC #\u30AF\u30E9\u30A4\u30A2\u30F3\u30C8B [15\u5206] @\u30AA\u30F3\u30E9\u30A4\u30F3",
    nowIso: (/* @__PURE__ */ new Date()).toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: false
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } };
  Logger.log(doPost(e).getContent());
}
function test_assignLabelToColorsSheet() {
  const label = "TestNewLabel";
  const colorId = resolveOrAssignColorIdByLabel_(label);
  Logger.log({ label, colorId });
}
function test_listColorsRows() {
  Logger.log(loadColorsRows_());
}
globalThis.doPost = doPost;
globalThis.invalidateCache = invalidateCache;
globalThis.test_doPost_dryRun_en = test_doPost_dryRun_en;
globalThis.test_doPost_dryRun_ja = test_doPost_dryRun_ja;
globalThis.test_doPost_realCreate_en = test_doPost_realCreate_en;
globalThis.test_doPost_realCreate_ja = test_doPost_realCreate_ja;
globalThis.test_assignLabelToColorsSheet = test_assignLabelToColorsSheet;
globalThis.test_listColorsRows = test_listColorsRows;
