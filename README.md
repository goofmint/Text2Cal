# Text2Cal

自然言語の予定入力テキスト（日本語・英語対応）を解析し、  
**Google Apps Script + Gemini API** を使って **Google カレンダーに直接登録**する OSS です。

- macOS / iOS の **ショートカット** からの利用を想定
- `#ラベル` による **カレンダー色の自動割当**
- `@場所` / `[30分]` などの自然記法対応
- **タイムゾーンは Google アカウント設定に自動追従**
- **Spreadsheet（`colors` シート）だけで色管理**

## 目的（Why this exists）

- Todoistの料金が跳ね上がってしまう
- Googleカレンダーの入力は面倒
- Todoistの自然文（例:「明日14時 打ち合わせ #ClientA [30分]」）での予定入力は手放しがたい

## できること

入力例：

- 明日14時 打ち合わせ #クライアントA [30分] @渋谷オフィス
- 隔週日曜日20時 記事チェック #Conference [50min]
- Tomorrow 3pm Meeting #ClientB @Online

自動処理：

- 日時・終了時刻（デフォルト60分）
- 繰り返し（毎週 / 隔週）
- `@` → 場所
- `#` → 色ラベル（自動保存）
- タイトル自動整形
- Google カレンダー登録

## システム構成

```
[macOS / iOS Shortcut]
↓ (POST)
[Google Apps Script Web App]
↓
[Gemini API] → 構造化(JSON)
↓
[Google Calendar API]
```

## 必要なもの

### Google アカウント

利用しているAPIとサービス：

- Gemini API
- Google Calendar API
- Google Spreadsheet & Google Apps Script

### API

- **Gemini API（API Key 方式）**
- **Google Calendar API（Advanced Service）**

## スプレッドシート構成

### シート名：`colors`（必須）

| colorId | label | background | foreground |
|-------:|-------|------------|------------|
| 1 | ClientA | #a4bdfc | #1d1d1d |
| 2 | | #7ae7bf | #1d1d1d |
| 3 | | #dbadff | #1d1d1d |
| … | | | |

### ルール

- `label` が空の行は **未使用スロット**
- `#ClientA` が指定された場合：
  - 既存一致 → その `colorId` を使用
  - 未登録 → 空いている `label` に自動書き込み

## 環境変数（Script Properties）

Apps Script の **プロジェクト設定 → スクリプト プロパティ** に設定してください。

| Key | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Gemini API の API Key |
| `SHARED_SECRET` | ✅ | Web App 呼び出し用の簡易認証トークン |
| `CALENDAR_ID` |  | 登録先カレンダー（省略時 `primary`） |

## タイムゾーンについて

- `Session.getScriptTimeZone()` を使用
- スプレッドシート（≒ Google アカウント）のタイムゾーンに自動追従

例：
- 日本 → `Asia/Tokyo`
- 米国 → `America/Los_Angeles`
- 欧州 → `Europe/Berlin`

## セットアップ手順

### 1. スプレッドシート作成

- 新規 Spreadsheet
- `colors` シートを作成
- ヘッダと colorId 行を入力

### 2. Apps Script 作成

- スプレッドシートから Apps Script を作成
- `index.ts` を貼り付け（本リポジトリの内容）

### 3. Advanced Google Services

- **Calendar API を ON**
- Google Cloud 側でも有効化

### 4. スクリプトプロパティ設定

- `GEMINI_API_KEY`
- `SHARED_SECRET`
- （必要なら）`CALENDAR_ID`

### 5. Web App デプロイ

- 実行ユーザー：**自分**
- アクセス：**全員（匿名可）**
- 認証は `SHARED_SECRET` で制御

## テスト方法

### Dry Run（予定登録しません）

```ts
test_doPost_dryRun_ja();
test_doPost_dryRun_en();
```

### 実登録テスト（カレンダーに作成されます）

```ts
test_doPost_realCreate_ja();
test_doPost_realCreate_en();
```

## macOS / iOS ショートカット連携

* Web App URL に `POST`
* JSON Body 例：

```json
{
  "text": "明日14時 打ち合わせ #ClientA [30分]",
  "secret": "YOUR_SHARED_SECRET"
}
```

## 開発環境

* Node.js（clasp 利用時）
* TypeScript（ES2019）
* Google Apps Script
* Gemini API

## セキュリティ設計

* OAuth 不使用（ショートカット向け）
* Web App + `SHARED_SECRET` による簡易認証
* 書き込み対象は **自分のカレンダーのみ**

## 制限事項 / 注意

* 色スロットが埋まると新規ラベルはエラー
* Gemini の出力が不正な場合はエラーで停止
* 完全な自然言語理解ではありません（LLM 依存）

## ライセンス

MIT License
