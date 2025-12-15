/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Container-bound Apps Script (Spreadsheet-bound)
 * Sheet: "colors" ONLY
 *
 * colors schema (header row required):
 *   colorId | label | background | foreground
 *
 * Label->color rules:
 * - If "#label" is provided:
 *   - If colors.label matches -> use that row's colorId
 *   - Else assign the label into the first empty colors.label cell (persist), then use that row's colorId
 *   - Never overwrites an existing label cell
 *   - If no empty label slots -> error (safe)
 * - If no "#label" -> do not set event colorId (Google Calendar default)
 *
 * Timezone:
 * - Uses Session.getScriptTimeZone() (script/account timezone)
 * - Gemini is instructed to use that timezone and return ISO8601 with correct offset
 *
 * Script Properties:
 * - GEMINI_API_KEY (required)
 * - SHARED_SECRET  (required)
 * - CALENDAR_ID    (optional; default "primary")
 *
 * Requires:
 * - Advanced Google Services: Calendar API enabled (Calendar.Events.insert)
 */

type Recurrence = { rrule: string } | null;

type ParsedEvent = {
  title: string;
  location: string | null;
  label: string | null;
  timezone: string; // dynamic IANA TZ
  start: string;    // ISO8601 with offset
  end: string;      // ISO8601 with offset
  recurrence: Recurrence;
};

type RequestBody = {
  text: string;
  nowIso?: string;
  secret: string;
  dryRun?: boolean;
};

const COLORS_SHEET_NAME = "colors";
const DEFAULT_CALENDAR_ID = "primary";
const GEMINI_MODEL = "gemini-2.5-flash";

// Cache (colors rows only)
const CACHE_TTL_SECONDS = 60 * 5;
const CACHE_COLORS_KEY = "CACHE_COLORS_ROWS_V3";

// ===== Entry point =====
function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const body = parseRequest_(e);

    const expected = getProp_("SHARED_SECRET");
    if (body.secret !== expected) {
      return jsonResponse_({ ok: false, error: "Unauthorized" }, 401);
    }

    const timeZone = getUserTimeZone_();
    const nowIso = body.nowIso || new Date().toISOString();

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
  } catch (err: any) {
    return jsonResponse_({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}

// ===== Request/Response =====
function parseRequest_(e: GoogleAppsScript.Events.DoPost): RequestBody {
  const raw = e?.postData?.contents ?? "";
  if (!raw) throw new Error("Empty request body.");

  const obj = JSON.parse(raw);

  if (!obj.text || typeof obj.text !== "string") throw new Error("Missing 'text' (string).");
  if (!obj.secret || typeof obj.secret !== "string") throw new Error("Missing 'secret' (string).");

  return {
    text: obj.text,
    nowIso: typeof obj.nowIso === "string" ? obj.nowIso : undefined,
    secret: obj.secret,
    dryRun: !!obj.dryRun
  };
}

function jsonResponse_(obj: any, _status = 200): GoogleAppsScript.Content.TextOutput {
  const out = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  // @ts-ignore best-effort
  if (typeof (out as any).setHeader === "function") (out as any).setHeader("Cache-Control", "no-store");
  return out;
}

function getProp_(key: string): string {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Missing script property: ${key}`);
  return v;
}

function getPropOptional_(key: string): string | null {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getUserTimeZone_(): string {
  return Session.getScriptTimeZone() || "UTC";
}

// ===== Spreadsheet access (container-bound) =====
function colorsSheet_(): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(COLORS_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet not found: ${COLORS_SHEET_NAME}`);
  return sheet;
}

function invalidateCache(): void {
  CacheService.getScriptCache().remove(CACHE_COLORS_KEY);
}

type ColorsRow = {
  rowIndex: number; // 1-based
  colorId: string;
  label: string;
  background: string;
  foreground: string;
};

function loadColorsRows_(): ColorsRow[] {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_COLORS_KEY);
  if (cached) return JSON.parse(cached) as ColorsRow[];

  const sheet = colorsSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error("colors sheet has no data rows.");

  const header = values[0].map(v => String(v).trim());
  const idxId = header.indexOf("colorId");
  const idxLabel = header.indexOf("label");
  const idxBg = header.indexOf("background");
  const idxFg = header.indexOf("foreground");
  if (idxId < 0 || idxLabel < 0 || idxBg < 0 || idxFg < 0) {
    throw new Error("colors header must be: colorId | label | background | foreground");
  }

  const rows: ColorsRow[] = [];
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

function normalizeLabel_(label: string): string {
  return label.trim().replace(/^#/, "").trim();
}

function resolveOrAssignColorIdByLabel_(label: string | null): string | undefined {
  if (!label) return undefined;
  const normalized = normalizeLabel_(label);
  if (!normalized) return undefined;

  const rows = loadColorsRows_();

  const found = rows.find(r => normalizeLabel_(r.label) === normalized);
  if (found) return found.colorId;

  const empty = rows.find(r => !r.label);
  if (!empty) throw new Error(`No empty label slots left in colors sheet for label: ${normalized}`);

  const sheet = colorsSheet_();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(v => String(v).trim());
  const labelColIdx = header.indexOf("label");
  if (labelColIdx < 0) throw new Error("colors header missing 'label' column.");

  sheet.getRange(empty.rowIndex, labelColIdx + 1).setValue(normalized);
  invalidateCache();

  return empty.colorId;
}

// ===== Calendar (Advanced Calendar service) =====
function createCalendarEvent_(
  calendarId: string,
  ev: ParsedEvent,
  colorId?: string
): GoogleAppsScript.Calendar.Schema.Event {
  const resource: GoogleAppsScript.Calendar.Schema.Event = {
    summary: ev.title,
    location: ev.location ?? undefined,
    start: { dateTime: ev.start, timeZone: ev.timezone },
    end: { dateTime: ev.end, timeZone: ev.timezone },
    recurrence: ev.recurrence ? [`RRULE:${ev.recurrence.rrule}`] : undefined,
    colorId: colorId
  };
  return Calendar.Events.insert(resource, calendarId);
}

// ===== Gemini parsing =====
function parseWithGemini_(text: string, nowIso: string, timeZone: string): ParsedEvent {
  const apiKey = getProp_("GEMINI_API_KEY");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const prompt = buildPrompt_(text, nowIso, timeZone);

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.0 }
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
  const outText: string | undefined =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ||
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!outText) throw new Error("Gemini returned empty output.");

  const parsed = safeJsonParse_(outText);
  validateParsed_(parsed, timeZone);
  return parsed as ParsedEvent;
}

function safeJsonParse_(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Gemini output is not JSON: ${text}`);
    return JSON.parse(m[0]);
  }
}

function validateParsed_(obj: any, timeZone: string): void {
  const required = ["title", "location", "label", "timezone", "start", "end", "recurrence"];
  for (const k of required) if (!(k in obj)) throw new Error(`Missing field: ${k}`);

  if (obj.timezone !== timeZone) throw new Error(`timezone must be exactly "${timeZone}"`);
  if (typeof obj.title !== "string" || !obj.title.trim()) throw new Error("title must be non-empty string");
  if (!(obj.location === null || typeof obj.location === "string")) throw new Error("location must be string|null");
  if (!(obj.label === null || typeof obj.label === "string")) throw new Error("label must be string|null");
  if (typeof obj.start !== "string" || typeof obj.end !== "string") throw new Error("start/end must be strings");
  if (!(obj.recurrence === null || (typeof obj.recurrence === "object" && typeof obj.recurrence.rrule === "string"))) {
    throw new Error("recurrence must be null or { rrule: string }");
  }

  if (!/[+-]\d{2}:\d{2}$/.test(obj.start)) throw new Error("start must end with timezone offset like +09:00");
  if (!/[+-]\d{2}:\d{2}$/.test(obj.end)) throw new Error("end must end with timezone offset like +09:00");
}

function buildPrompt_(text: string, nowIso: string, timeZone: string): string {
  return `You are a multilingual parser that converts free-form schedule text into ONE Google Calendar event object.
The input may be Japanese, English, or other languages.

Return ONLY a JSON object with EXACT fields:
title, location, label, timezone, start, end, recurrence

Constraints:
- timezone must be exactly: "${timeZone}" (IANA timezone string)
- start/end must be ISO 8601 with timezone OFFSET, e.g. "2025-12-15T15:00:00+09:00"

Extraction markers (language-agnostic):
- "#<label>" assigns label. Take text after "#" until whitespace/end. If missing, label=null.
- "@<place>" or "＠<place>" assigns location. Take text after @ until end (trim). If missing, location=null.
- Duration may be specified in brackets:
  - Japanese: [30分], [90分], [1時間]
  - English: [30m], [30min], [30 minutes], [1h], [1 hour]
  - If duration missing, default duration = 60 minutes.

Title rules:
- Remove date/time tokens, recurrence tokens, duration brackets, #label, @location from the title.
- The remaining text is title. If empty, title="Event".

Date/time interpretation (IMPORTANT):
- Interpret dates/times in timezone "${timeZone}".
- Use CURRENT_TIME_ISO as the reference "now".
- Relative day examples:
  - Japanese: 今日, 明日, 明後日
  - English: today, tomorrow, the day after tomorrow
- Weekdays examples:
  - Japanese: 月 火 水 木 金 土 日 (optionally with 曜日)
  - English: Monday Tuesday Wednesday Thursday Friday Saturday Sunday
- If weekday is specified without a date, choose the NEXT occurrence after now;
  if today matches and the time is still in the future, you may use today.
- If time is missing, assume 09:00.

Time examples:
- Japanese: 15時 => 15:00, 15:30 => 15:30, 午後3時 => 15:00
- English: 3pm => 15:00, 15:00 => 15:00, 3:30 PM => 15:30

Recurrence normalization:
- Weekly examples: "毎週火曜日", "every Tuesday", "weekly on Tuesday"
  => recurrence={"rrule":"FREQ=WEEKLY;BYDAY=TU"}
- Biweekly examples: "隔週日曜日", "every other Sunday", "biweekly on Sunday"
  => recurrence={"rrule":"FREQ=WEEKLY;INTERVAL=2;BYDAY=SU"}
- Otherwise recurrence=null.
- BYDAY mapping for Japanese weekdays: 月=MO 火=TU 水=WE 木=TH 金=FR 土=SA 日=SU

If date/time cannot be confidently parsed:
- Choose the earliest reasonable upcoming time: today 09:00 if still future else tomorrow 09:00 (in "${timeZone}").

INPUT: ${text}
CURRENT_TIME_ISO: ${nowIso}

Return only the JSON object.`;
}

// ===== Tests (run from Apps Script editor) =====
function test_doPost_dryRun_en(): void {
  const body = {
    text: "Tomorrow 2pm Meeting #ClientA [30min] @Shibuya Office",
    nowIso: new Date().toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: true
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } } as GoogleAppsScript.Events.DoPost;
  Logger.log(doPost(e).getContent());
}

function test_doPost_dryRun_ja(): void {
  const body = {
    text: "明日14時 打ち合わせ #クライアントA [30分] @渋谷オフィス",
    nowIso: new Date().toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: true
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } } as GoogleAppsScript.Events.DoPost;
  Logger.log(doPost(e).getContent());
}

/**
 * REAL CREATE (English) - creates an actual event
 */
function test_doPost_realCreate_en(): void {
  const body = {
    text: "[AUTO-TEST] Tomorrow 4pm Review #ClientB [15min] @Online",
    nowIso: new Date().toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: false
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } } as GoogleAppsScript.Events.DoPost;
  Logger.log(doPost(e).getContent());
}

/**
 * REAL CREATE (Japanese) - creates an actual event
 */
function test_doPost_realCreate_ja(): void {
  const body = {
    text: "[AUTO-TEST] 明日16時 レビュー #クライアントB [15分] @オンライン",
    nowIso: new Date().toISOString(),
    secret: getProp_("SHARED_SECRET"),
    dryRun: false
  };
  const e = { postData: { contents: JSON.stringify(body), type: "application/json" } } as GoogleAppsScript.Events.DoPost;
  Logger.log(doPost(e).getContent());
}

/**
 * Verifies that a new label gets written into an empty colors.label slot (no overwrite)
 */
function test_assignLabelToColorsSheet(): void {
  const label = "TestNewLabel";
  const colorId = resolveOrAssignColorIdByLabel_(label);
  Logger.log({ label, colorId });
}

function test_listColorsRows(): void {
  Logger.log(loadColorsRows_());
}

// ===== Ensure visibility even if bundler wraps =====
(globalThis as any).doPost = doPost;
(globalThis as any).invalidateCache = invalidateCache;
(globalThis as any).test_doPost_dryRun_en = test_doPost_dryRun_en;
(globalThis as any).test_doPost_dryRun_ja = test_doPost_dryRun_ja;
(globalThis as any).test_doPost_realCreate_en = test_doPost_realCreate_en;
(globalThis as any).test_doPost_realCreate_ja = test_doPost_realCreate_ja;
(globalThis as any).test_assignLabelToColorsSheet = test_assignLabelToColorsSheet;
(globalThis as any).test_listColorsRows = test_listColorsRows;
