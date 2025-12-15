# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**text2cal** is a Google Apps Script project that creates Google Calendar events from natural language text using Google's Gemini AI. It supports both Japanese and English input, handles recurring events, location extraction, label-based color assignment, and timezone-aware scheduling.

This is a **container-bound Apps Script** designed to be bound to a Google Spreadsheet containing a "colors" sheet for label-to-color mappings.

## Build and Deploy Commands

```bash
# Build TypeScript to JavaScript for Apps Script
npm run build

# Build and push to Google Apps Script
npm run push

# Watch Apps Script logs
npm run logs
```

The build process uses `esbuild` to compile TypeScript from `src/index.ts` to `dist/index.js` with the following configuration:
- Platform: neutral (Google Apps Script environment)
- Target: ES2020
- Format: CommonJS
- Output: `dist/index.js`

## Architecture

### Build Flow

1. **Source**: `src/index.ts` (TypeScript with Google Apps Script types)
2. **Build**: `esbuild` compiles to `dist/index.js`
3. **Deploy**: `clasp push` uploads `dist/` contents to Google Apps Script
4. **Runtime**: Google Apps Script V8 runtime executes the code

### Key Components

#### Entry Point
- `doPost(e)`: HTTP POST webhook handler that receives JSON requests
- Authentication via shared secret
- Supports `dryRun` mode for testing without creating events

#### Gemini AI Integration
- `parseWithGemini_()`: Sends text to Gemini API with structured prompt
- Uses model: `gemini-2.5-flash`
- Temperature: 0.0 (deterministic output)
- Returns structured JSON: `{ title, location, label, timezone, start, end, recurrence }`

#### Color Management (Spreadsheet-bound)
- `loadColorsRows_()`: Reads "colors" sheet with caching (5min TTL)
- `resolveOrAssignColorIdByLabel_()`: Label resolution logic
  - If label exists → return existing colorId
  - If label doesn't exist → assign to first empty slot
  - Never overwrites existing labels
  - Throws error if no empty slots available
- **Cache key**: `CACHE_COLORS_ROWS_V3`

#### Calendar Event Creation
- Uses Advanced Calendar Service (Calendar.Events.insert)
- Supports recurrence via RRULE syntax
- Timezone-aware start/end times (ISO8601 with offset)

### Data Flow

```
POST request → doPost()
  → parseRequest_() validates input
  → parseWithGemini_() extracts event details
  → resolveOrAssignColorIdByLabel_() determines color
  → createCalendarEvent_() inserts to Google Calendar
  → jsonResponse_() returns result
```

### Required Script Properties

Set these via Apps Script UI (Project Settings → Script Properties):

- `GEMINI_API_KEY`: Google Gemini API key (required)
- `SHARED_SECRET`: Authentication secret for webhook (required)
- `CALENDAR_ID`: Target calendar ID (optional, defaults to "primary")

### Spreadsheet Schema

**Sheet name**: `colors` (exact name required)

**Header row** (required columns):
```
colorId | label | background | foreground
```

- `colorId`: Google Calendar color ID (1-11)
- `label`: Text label for the color (can be empty initially)
- `background`: Hex color for reference (#RRGGBB)
- `foreground`: Hex color for reference (#RRGGBB)

## Input Text Format

The system parses free-form text with special markers:

- `#<label>`: Assigns color label (e.g., `#ClientA`)
- `@<place>` or `＠<place>`: Location (e.g., `@Shibuya Office`)
- `[duration]`: Event duration
  - Japanese: `[30分]`, `[1時間]`
  - English: `[30min]`, `[1h]`
  - Default: 60 minutes if unspecified

**Examples**:
```
Tomorrow 2pm Meeting #ClientA [30min] @Shibuya Office
明日14時 打ち合わせ #クライアントA [30分] @渋谷オフィス
Every Tuesday 10am Standup #TeamSync [15min] @Zoom
```

## Testing

The codebase includes test functions that can be run from the Apps Script editor:

- `test_doPost_dryRun_en()`: English dry run (no event created)
- `test_doPost_dryRun_ja()`: Japanese dry run
- `test_doPost_realCreate_en()`: Creates actual English event
- `test_doPost_realCreate_ja()`: Creates actual Japanese event
- `test_assignLabelToColorsSheet()`: Tests label assignment logic
- `test_listColorsRows()`: Lists all colors rows
- `invalidateCache()`: Clears colors cache

**Note**: These functions are exported to `globalThis` at the bottom of `src/index.ts` to ensure visibility even after bundling.

## Development Workflow

1. **Edit**: Modify `src/index.ts`
2. **Build**: Run `npm run build` to compile
3. **Deploy**: Run `npm run push` to upload to Apps Script
4. **Test**: Run test functions from Apps Script editor or use Apps Script logs
5. **Debug**: Use `npm run logs` to monitor execution logs

## Important Implementation Details

### Timezone Handling
- Uses `Session.getScriptTimeZone()` (script/account timezone)
- Gemini is instructed to interpret dates in this timezone
- All event times use ISO8601 format with explicit timezone offset (e.g., `2025-12-15T15:00:00+09:00`)

### Caching Strategy
- Colors sheet data is cached for 5 minutes (`CACHE_TTL_SECONDS`)
- Cache is invalidated when labels are assigned
- Cache key: `CACHE_COLORS_KEY = "CACHE_COLORS_ROWS_V3"`

### Error Handling
- All errors in `doPost()` return HTTP 500 with JSON error message
- Unauthorized requests return HTTP 401
- Gemini API errors include HTTP status and response body
- Missing required script properties throw descriptive errors

### Global Exports
Functions exported to `globalThis` to survive bundling:
```typescript
doPost, invalidateCache, test_doPost_dryRun_en, test_doPost_dryRun_ja,
test_doPost_realCreate_en, test_doPost_realCreate_ja,
test_assignLabelToColorsSheet, test_listColorsRows
```

## TypeScript Configuration

- **Target**: ES2020 (Google Apps Script V8 runtime)
- **Module**: ESNext with Bundler resolution
- **Strict mode**: Enabled
- **Types**: `google-apps-script` package
- **Output**: `dist/` directory

## Dependencies

**Production**: None (uses Google Apps Script built-in services)

**Development**:
- `@google/clasp`: Google Apps Script CLI
- `@types/google-apps-script`: TypeScript type definitions
- `esbuild`: Fast TypeScript bundler
- `typescript`: TypeScript compiler

## Advanced Google Services

Required in `appsscript.json`:
- **Calendar API v3**: For creating calendar events
- **Tasks API v1**: (Currently enabled but not used in code)

## Security Notes

- Shared secret authentication for webhook access
- API keys stored in Script Properties (not in code)
- No sensitive data in version control
- HTTP responses include `Cache-Control: no-store` header (best-effort)
