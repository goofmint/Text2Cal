/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Container-bound Apps Script (Spreadsheet-bound)
 * Sheets: "colors", "logs"
 *
 * colors schema (header row required):
 *   colorId | label | background | foreground
 *
 * logs schema (auto-created):
 *   timestamp | requestText | parseResult | calendarResult | status | errorMessage
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

type ParsedTask = {
  title: string;
  due: string | null;      // ISO8601 date (YYYY-MM-DD)
  notes: string | null;    // Additional notes (including recurrence info)
  recurrence: string | null; // Human-readable recurrence description
  taskList: string | null;  // Task list name (extracted from #label)
};

type RequestBody = {
  text: string;
  nowIso?: string;
  secret: string;
  dryRun?: boolean;
};

const COLORS_SHEET_NAME = "colors";
const LOGS_SHEET_NAME = "logs";
const DEFAULT_CALENDAR_ID = "primary";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// Cache (colors rows only)
const CACHE_TTL_SECONDS = 60 * 5;
const CACHE_COLORS_KEY = "CACHE_COLORS_ROWS_V3";

// ===== Entry point =====
function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  let logRowIndex: number | null = null;

  try {
    const body = parseRequest_(e);
    const timestamp = new Date();

    // Create initial log entry
    logRowIndex = createLogEntry_(body.text, timestamp);

    const expected = getProp_("SHARED_SECRET");
    if (body.secret !== expected) {
      if (logRowIndex) {
        updateLogEntry_(logRowIndex, {
          status: "UNAUTHORIZED",
          errorMessage: "Authentication failed"
        });
      }
      return jsonResponse_({ ok: false, error: "Unauthorized" }, 401);
    }

    const timeZone = getUserTimeZone_();
    const nowIso = body.nowIso || new Date().toISOString();

    // Check if this is a task (starts with "!")
    const isTask = body.text.trim().startsWith("!");

    if (isTask) {
      // Task processing
      const parsedTask = parseTaskWithGemini_(body.text, nowIso, timeZone);

      // Update log with parse result
      if (logRowIndex) {
        updateLogEntry_(logRowIndex, {
          parseResult: JSON.stringify(parsedTask, null, 2),
          status: "PARSED"
        });
      }

      if (body.dryRun) {
        if (logRowIndex) {
          updateLogEntry_(logRowIndex, {
            status: "DRY_RUN",
            calendarResult: JSON.stringify({
              task: parsedTask,
              taskList: parsedTask.taskList || "@default",
              dryRun: true
            }, null, 2)
          });
        }
        return jsonResponse_({
          ok: true,
          timeZone,
          parsed: parsedTask,
          type: "task",
          taskList: parsedTask.taskList || "@default"
        });
      }

      const createdTask = createGoogleTask_(parsedTask);

      // Update log with task creation result
      if (logRowIndex) {
        updateLogEntry_(logRowIndex, {
          calendarResult: JSON.stringify({
            id: createdTask.id,
            status: createdTask.status,
            title: createdTask.title,
            due: createdTask.due,
            taskList: parsedTask.taskList || "@default"
          }, null, 2),
          status: "SUCCESS"
        });
      }

      return jsonResponse_({
        ok: true,
        timeZone,
        parsed: parsedTask,
        type: "task",
        created: {
          id: createdTask.id,
          status: createdTask.status,
          title: createdTask.title,
          due: createdTask.due,
          selfLink: createdTask.selfLink,
          taskList: parsedTask.taskList || "@default"
        }
      });
    }

    // Calendar event processing
    const parsed = parseWithGemini_(body.text, nowIso, timeZone);

    // Update log with parse result
    if (logRowIndex) {
      updateLogEntry_(logRowIndex, {
        parseResult: JSON.stringify(parsed, null, 2),
        status: "PARSED"
      });
    }

    const colorId = resolveOrAssignColorIdByLabel_(parsed.label);

    if (body.dryRun) {
      if (logRowIndex) {
        updateLogEntry_(logRowIndex, {
          status: "DRY_RUN",
          calendarResult: JSON.stringify({ colorId, dryRun: true }, null, 2)
        });
      }
      return jsonResponse_({
        ok: true,
        timeZone,
        parsed,
        type: "event",
        resolved: { colorId }
      });
    }

    const calendarId = getPropOptional_("CALENDAR_ID") || DEFAULT_CALENDAR_ID;
    const created = createCalendarEvent_(calendarId, parsed, colorId);

    // Update log with calendar creation result
    if (logRowIndex) {
      updateLogEntry_(logRowIndex, {
        calendarResult: JSON.stringify({
          id: created.id,
          status: created.status,
          htmlLink: created.htmlLink,
          colorId
        }, null, 2),
        status: "SUCCESS"
      });
    }

    return jsonResponse_({
      ok: true,
      timeZone,
      parsed,
      type: "event",
      resolved: { colorId },
      created: {
        id: created.id,
        status: created.status,
        htmlLink: created.htmlLink
      }
    });
  } catch (err: any) {
    // Update log with error
    if (logRowIndex) {
      updateLogEntry_(logRowIndex, {
        status: "ERROR",
        errorMessage: String(err?.message ?? err)
      });
    }
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

// ===== Logs sheet (auto-create if not exists) =====
function logsSheet_(): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOGS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(LOGS_SHEET_NAME);
    // Set header row
    const headers = ["timestamp", "requestText", "parseResult", "calendarResult", "status", "errorMessage"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function createLogEntry_(text: string, timestamp: Date): number {
  const sheet = logsSheet_();
  const nextRow = sheet.getLastRow() + 1;

  sheet.getRange(nextRow, 1, 1, 6).setValues([[
    timestamp,
    text,
    "", // parseResult - will be updated later
    "", // calendarResult - will be updated later
    "RECEIVED", // status
    "" // errorMessage
  ]]);

  return nextRow;
}

type LogUpdate = {
  parseResult?: string;
  calendarResult?: string;
  status?: string;
  errorMessage?: string;
};

function updateLogEntry_(rowIndex: number, updates: LogUpdate): void {
  const sheet = logsSheet_();

  if (updates.parseResult !== undefined) {
    sheet.getRange(rowIndex, 3).setValue(updates.parseResult);
  }
  if (updates.calendarResult !== undefined) {
    sheet.getRange(rowIndex, 4).setValue(updates.calendarResult);
  }
  if (updates.status !== undefined) {
    sheet.getRange(rowIndex, 5).setValue(updates.status);
  }
  if (updates.errorMessage !== undefined) {
    sheet.getRange(rowIndex, 6).setValue(updates.errorMessage);
  }
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

  // Fast path: check if label already exists (no lock needed for reads)
  const initialRows = loadColorsRows_();
  const found = initialRows.find(r => normalizeLabel_(r.label) === normalized);
  if (found) return found.colorId;

  // Slow path: assign new label (requires lock to prevent TOCTOU race)
  const lock = LockService.getScriptLock();
  const lockTimeout = 30000; // 30 seconds

  try {
    if (!lock.tryLock(lockTimeout)) {
      throw new Error(`Failed to acquire lock for label assignment within ${lockTimeout}ms. Please retry.`);
    }

    // Re-load rows inside lock to check if another request assigned this label
    invalidateCache();
    const rows = loadColorsRows_();

    // Check again if label now exists (another request may have assigned it)
    const existingLabel = rows.find(r => normalizeLabel_(r.label) === normalized);
    if (existingLabel) return existingLabel.colorId;

    // Find empty slot
    const empty = rows.find(r => !r.label);
    if (!empty) throw new Error(`No empty label slots left in colors sheet for label: ${normalized}`);

    // Assign label to empty slot
    const sheet = colorsSheet_();
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(v => String(v).trim());
    const labelColIdx = header.indexOf("label");
    if (labelColIdx < 0) throw new Error("colors header missing 'label' column.");

    sheet.getRange(empty.rowIndex, labelColIdx + 1).setValue(normalized);
    invalidateCache();

    return empty.colorId;
  } finally {
    lock.releaseLock();
  }
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
  return Calendar!.Events.insert(resource, calendarId);
}

// ===== Google Tasks (Advanced Tasks service) =====
function getOrCreateTaskList_(listName: string): string {
  // Get all task lists
  const taskLists = Tasks!.Tasklists.list();

  if (!taskLists.items) {
    // No task lists exist, create the first one
    const newList = Tasks!.Tasklists.insert({ title: listName });
    return newList.id!;
  }

  // Search for existing list by name
  const existing = taskLists.items.find(list => list.title === listName);
  if (existing) {
    return existing.id!;
  }

  // List not found, create new one
  const newList = Tasks!.Tasklists.insert({ title: listName });
  return newList.id!;
}

function createGoogleTask_(task: ParsedTask): GoogleAppsScript.Tasks.Schema.Task {
  const resource: GoogleAppsScript.Tasks.Schema.Task = {
    title: task.title,
    due: task.due ? `${task.due}T00:00:00.000Z` : undefined,
    notes: task.notes ?? undefined
  };

  // Determine task list ID
  let tasklistId: string;
  if (task.taskList) {
    tasklistId = getOrCreateTaskList_(task.taskList);
  } else {
    tasklistId = "@default";
  }

  return Tasks!.Tasks.insert(resource, tasklistId);
}

// ===== Gemini parsing =====
function parseWithGemini_(text: string, nowIso: string, timeZone: string): ParsedEvent {
  const apiKey = getProp_("GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const systemPrompt = buildSystemPrompt_(timeZone);
  const userPrompt = buildUserPrompt_(text, nowIso);

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0
    }
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
  const outText: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!outText) throw new Error("Gemini returned empty output.");

  const parsed = JSON.parse(outText);
  validateParsed_(parsed, timeZone);
  return parsed as ParsedEvent;
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

function parseTaskWithGemini_(text: string, nowIso: string, timeZone: string): ParsedTask {
  const apiKey = getProp_("GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const systemPrompt = buildTaskSystemPrompt_(timeZone);
  const userPrompt = buildTaskUserPrompt_(text, nowIso);

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0
    }
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
  const outText: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!outText) throw new Error("Gemini returned empty output.");

  const parsed = JSON.parse(outText);
  validateParsedTask_(parsed);
  return parsed as ParsedTask;
}

function validateParsedTask_(obj: any): void {
  const required = ["title", "due", "notes", "recurrence", "taskList"];
  for (const k of required) if (!(k in obj)) throw new Error(`Missing field: ${k}`);

  if (typeof obj.title !== "string" || !obj.title.trim()) throw new Error("title must be non-empty string");
  if (!(obj.due === null || typeof obj.due === "string")) throw new Error("due must be string|null");
  if (!(obj.notes === null || typeof obj.notes === "string")) throw new Error("notes must be string|null");
  if (!(obj.recurrence === null || typeof obj.recurrence === "string")) throw new Error("recurrence must be string|null");
  if (!(obj.taskList === null || typeof obj.taskList === "string")) throw new Error("taskList must be string|null");

  if (obj.due && !/^\d{4}-\d{2}-\d{2}$/.test(obj.due)) {
    throw new Error("due must be in YYYY-MM-DD format");
  }
}

function buildSystemPrompt_(timeZone: string): string {
  return `You are a scheduling assistant that converts free-form natural language event descriptions into structured Google Calendar event data.

The input may be written in any language. Japanese and English must be supported.

Your task is to extract the following fields and return them as a JSON object:

- title: string (the event title)
- start: string (ISO 8601 datetime with timezone offset, e.g., "2025-12-16T14:00:00+09:00")
- end: string (ISO 8601 datetime with timezone offset)
- location: string | null (the event location)
- label: string | null (extracted from "#label" syntax)
- timezone: string (must be exactly "${timeZone}")
- recurrence: object | null (if recurring, format: { "rrule": "FREQ=WEEKLY;BYDAY=TU" })

Rules:

1. Date and time:
  - Interpret relative expressions like "tomorrow", "next Monday", "明日", "来週"
  - Calculate dates relative to the provided current time
  - Always use timezone: ${timeZone}
  - Format datetime as ISO 8601 with timezone offset (e.g., "+09:00")
  - If duration is specified (e.g., "45分", "45 minutes"), calculate end time accordingly
  - If no duration is specified, default to 60 minutes

2. Label:
  - A word prefixed with "#" is always a label
  - Extract the label without the "#" prefix
  - Remove the label text from the title

3. Location:
  - If a word or phrase is prefixed with "@" or "＠", it is always the location
  - Otherwise, if a place name appears with particles or prepositions such as:
    - Japanese: "で", "にて", "場所は"
    - English: "at", "in", "from"
    then treat that place name as the location
  - Remove the location text from the title

4. Title:
  - The title should be what remains after removing date/time, duration, label, and location
  - The title must be concise and human-readable

5. Output:
  - Return ONLY valid JSON
  - Use null if a field is not present
  - Do not include explanations or comments`;
}

function buildUserPrompt_(text: string, nowIso: string): string {
  return `Current time: ${nowIso}

Event description:
${text}

Extract the event information and return as JSON.`;
}

function buildTaskSystemPrompt_(timeZone: string): string {
  return `You are a task management assistant that converts free-form natural language task descriptions into structured Google Tasks data.

The input may be written in any language. Japanese and English must be supported.

Your task is to extract the following fields and return them as a JSON object:

- title: string (the task title)
- due: string | null (due date in YYYY-MM-DD format, or null if no date specified)
- notes: string | null (additional notes including recurrence information)
- recurrence: string | null (human-readable recurrence description like "毎週火曜日" or "Every Tuesday")
- taskList: string | null (task list name extracted from "#label" syntax)

Rules:

1. Date handling:
  - Interpret relative expressions like "today", "tomorrow", "明日", "今日"
  - Calculate dates relative to the provided current time
  - Always use timezone: ${timeZone}
  - Format date as YYYY-MM-DD (date only, no time)
  - If no date is specified, use today's date
  - If time is specified, ignore it (tasks are all-day by default)

2. Recurrence:
  - Extract recurrence patterns like "毎週火曜日", "Every Tuesday", "毎日", etc.
  - Store the recurrence description in both the 'recurrence' field and 'notes' field
  - Note: Google Tasks API does not natively support recurring tasks, so this is informational only

3. Task List:
  - A word prefixed with "#" is always a task list name
  - Extract the task list name without the "#" prefix
  - Remove the task list text from the title
  - If no "#label" is provided, set taskList to null (will use default list)

4. Title:
  - Remove the leading "!" character from the title
  - The title should be concise and clear
  - Remove date/time expressions, recurrence patterns, and task list names from the title

5. Output:
  - Return ONLY valid JSON
  - Use null if a field is not present
  - Do not include explanations or comments`;
}

function buildTaskUserPrompt_(text: string, nowIso: string): string {
  return `Current time: ${nowIso}

Task description (starts with "!"):
${text}

Extract the task information and return as JSON.`;
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
