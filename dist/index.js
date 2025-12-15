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
  const initialRows = loadColorsRows_();
  const found = initialRows.find((r) => normalizeLabel_(r.label) === normalized);
  if (found) return found.colorId;
  const lock = LockService.getScriptLock();
  const lockTimeout = 3e4;
  try {
    if (!lock.tryLock(lockTimeout)) {
      throw new Error(`Failed to acquire lock for label assignment within ${lockTimeout}ms. Please retry.`);
    }
    invalidateCache();
    const rows = loadColorsRows_();
    const existingLabel = rows.find((r) => normalizeLabel_(r.label) === normalized);
    if (existingLabel) return existingLabel.colorId;
    const empty = rows.find((r) => !r.label);
    if (!empty) throw new Error(`No empty label slots left in colors sheet for label: ${normalized}`);
    const sheet = colorsSheet_();
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((v) => String(v).trim());
    const labelColIdx = header.indexOf("label");
    if (labelColIdx < 0) throw new Error("colors header missing 'label' column.");
    sheet.getRange(empty.rowIndex, labelColIdx + 1).setValue(normalized);
    invalidateCache();
    return empty.colorId;
  } finally {
    lock.releaseLock();
  }
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const prompt = buildPrompt_(text, nowIso, timeZone);
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 }
  };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-goog-api-key": apiKey
    },
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
  return `
You are a scheduling assistant that converts free-form natural language
event descriptions into structured Google Calendar event data.

The input may be written in any language. Japanese and English must be supported.

Your task is to extract the following fields:

- title: string
- start: ISO 8601 datetime string
- end: ISO 8601 datetime string
- location: string | null
- label: string | null
- recurrence: RRULE string | null

Rules:

1. Date and time:
  - Interpret relative expressions like "tomorrow", "next Monday", "\u660E\u65E5", "\u6765\u9031".
  - If duration is specified (e.g. "45\u5206", "45 minutes"), calculate end time.
  - If no duration is specified, default to 60 minutes.

2. Label:
  - A word prefixed with "#" is always a label.
  - Remove the label text from the title.

3. Location:
  - If a word or phrase is prefixed with "@", it is always the location.
  - Otherwise, if a place name appears with particles or prepositions
    such as:
      - Japanese: "\u3067", "\u306B\u3066", "\u5834\u6240\u306F"
      - English: "at", "in", "from"
    then treat that place name as the location.
  - Typical place examples include cities, venues, offices, online platforms.
  - Remove the location text from the title.

4. Title:
  - The title should be what remains after removing date/time,
    duration, label, and location.
  - The title must be concise and human-readable.

5. Output:
  - Return only valid JSON.
  - Do not include explanations or comments.
  - Use null if a field is not present.

Example:

Input:
"\u660E\u65E514\u6642\u306B\u6771\u4EAC\u306745\u5206\u306E\u767B\u58C7 #CodeRabbit"

Output:
{
  "title": "\u767B\u58C7",
  "start": "YYYY-MM-DDT14:00:00",
  "end": "YYYY-MM-DDT14:45:00",
  "location": "\u6771\u4EAC",
  "label": "CodeRabbit",
  "recurrence": null
}
`;
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
