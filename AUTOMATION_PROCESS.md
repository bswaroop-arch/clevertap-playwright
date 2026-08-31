# CRM WhatsApp/RCS Automation — End-to-End Process

This documents the full weekly pipeline, from the creative deck to a live CleverTap
campaign draft. It exists so the process can be reconstructed or handed off without
re-deriving it from scratch.

## 0. Inputs each week

- A **"CRM Weekly <date range>.pptx"** Google Slides deck (creative team's pitch deck —
  offer copy, CTA, cohort description, creative images, per-slide "works"/"Drop this"
  status tag).
- A **"CRM <week>.xlsx"** Google Sheet, usually copied from the prior week's file so the
  `Day Wise Plan` tab's formulas/structure carry forward.

## 1. Day Wise Plan tab

One row per (Channel, Cohort, Offer). Columns: Channel · Cohort · Segment ID · Segment
Name · Base Size · Base Size (number) · Brand · Format · Offer · GV · Targeted Base ·
Thursday/Friday/Saturday/Sunday count · same-day "temp" (template) counts · Total Temp
Needed · Webhook ID · Excluded Segment ID · Campaign Name · Template Name · Whatsapp
message · button 1/2 · deeplink 1/2 · Header Image · Delivered · Spend.

- **Row 1** holds the day-of-week send-split percentages (e.g. 10/20/70/20 for
  Thu/Fri/Sat/Sun); day counts = Targeted Base × that split; "temp" counts =
  `ROUNDUP(day_count / 500000)` (500k is the per-template send cap).
- **Segment ID**: pulled forward from the prior week's workbook when the cohort
  definition repeats (match by wording against a running "Master Segment" lookup sheet
  of every Segment ID ever used, with its cohort definition and which weeks it appeared
  in). New/changed cohorts get no ID until a real CleverTap segment exists — never guess
  a numeric ID; leave it blank and flag it.
- **WA copy / button / deeplink**: pulled from the matching pitch slide. Deeplink1/2 are
  also reused from the prior week when the *offer* (not just the cohort) repeats.
  Slides whose status rectangle reads "Drop this" (vs "works") are creative the team has
  not finalized — skip those rows rather than shipping a discarded creative.
- **Carousel handling**: when a slide has multiple images with no distinguishing
  per-image caption (a shared asset pool, not individually-labeled cards), treat it as a
  carousel — comma-join every image's CDN URL into the single Header Image cell and set
  Format to `Carousel`.
- **Template Name**: must be globally unique. If two rows would share a name (same offer,
  different copy/cohort), disambiguate with `_1`, `_2`, ... A common convention is also
  to append a build-date suffix (`_DDMMYY`) so template names don't collide across weeks.

## 2. Header image upload

1. Download each creative image referenced in the deck to `~/Desktop/wa-headers/`
   (dedupe by content hash — the same creative is often reused across multiple slides).
2. Run the upload script (also available as a double-clickable launcher):
   ```
   cd ~/Desktop/Engineering/clevertap-playwright
   node scripts/upload-headers.js [folder]      # default folder: ~/Desktop/wa-headers/
   ```
   This POSTs each image to CleverTap's CDN (`{BASE}/json/cdn/campaigns/image`) using the
   session in `auth.json`, then `PUT`s the raw bytes to the returned signed URL. Output:
   a permanent CDN URL per file, logged to a `Header URLs` tab.
3. If you see `AUTH ERROR — session expired`, the CleverTap login cookie has expired.
   Refresh it (interactive — opens a real browser, needs a human to log in):
   ```
   cd ~/Desktop/Engineering/clevertap-playwright
   node scripts/save-auth.js
   ```
   Log in via Google SSO in the browser window that opens, then press Enter in the
   terminal. This writes a fresh `auth.json`.
4. Paste the resulting CDN URLs into the Day Wise Plan's Header Image column (and into
   the workbook's own `header images file` tab, as a local record).

## 3. Masterinput (per-workbook build)

Explode the Day Wise Plan into one row per (plan row with a filled Header Image) ×
(each day of the week with a non-zero send count) — **WA channel only**; RCS rows are
tracked in Day Wise Plan but not exploded into this WA send plan.

Columns: Date · Week · Segment ID · Segment Name (= plan's Campaign Name) · Size (=
that day's count) · Est Delivered · WA Template Name · WA Copy · Button 1/2 · Deeplink
1/2 · No of Templates (= that day's temp count) · Status · Cumulative (running `SUM`
formula over No of Templates) · Header URL · Schedule Time · Apply CG.

Rows are ordered date-major, then plan-row order within each date.

## 4. CleverTap Campaign Automation workbook (separate sheet: `1KF-ItkIUuvhgh64HGIQ6_HUDXMroQqCvYuz8Pk1oYUg`)

A **different**, standing workbook (not the weekly CRM file) drives actual template and
campaign creation via formulas:

```
Master Input (user fills)
  ├──→ Bulk Automation (formulas)  →  Karix Apps Script (in-sheet menu) → templates in Karix
  │                                 →  scripts/create-clevertap-template-api.js → templates in CleverTap
  └──→ Campaigns (formulas)         →  scripts/create-campaign-api.js → draft campaigns in CleverTap
```

- **Master Input!O (Cumulative)** = `=IF(M2="","",SUM($M$2:M2))` — a running total over
  "No of Templates" that lets every downstream sheet look up "which Master Input row does
  output row N belong to" via `2 + COUNTIF('Master Input'!$O:$O,"<="&(ROW()-2))` (call
  this **MIROW**). This is the load-bearing mechanic of the whole pipeline — if it breaks,
  everything downstream breaks with it.
- **Bulk Automation** and **Campaigns** rows pull most columns from Master Input via
  `INDEX(...,MIROW)` formulas (see `RULES.md` / rebuild blueprint in this repo's memory
  for the exact per-column formulas) and leave a few columns (status, template_id,
  campaign ID, manual Var 1-4) for the scripts or a human to fill.
- Rows 2-3 in Bulk Automation/Campaigns **must stay formula rows** — never let a
  copy-paste or manual edit turn them into static values, or the whole downstream chain
  stops updating.

### Scripts

| Script | What it does |
|---|---|
| `scripts/create-clevertap-template-api.js` | Reads Bulk Automation. **Karix-first ordering**: gets a fresh image file-handle from Drive → POSTs the WhatsApp template to Karix (Meta's BSP) with the HEADER+IMAGE component → then POSTs `saveWhatsAppTemplate` to CleverTap. (CleverTap's own template-save call silently drops the HEADER component when forwarding to Karix, so Karix must be hit directly first.) |
| `scripts/create-campaign-api.js` | Reads Campaigns tab, POSTs to CleverTap's internal `whatsApp/save?saveAsDraft=true` endpoint. Builds the segment query, body/button replacements, and optional personalized-image header. Rate-limited to 1 campaign / 5s. |
| `scripts/upload-headers.js` | Bulk image → CDN uploader (see step 2 above). |
| `scripts/save-auth.js` | Interactive Playwright login → refreshes `auth.json`. Run whenever a script reports an auth error. |
| `scripts/codegen-with-auth.js` | Manual-inspection helper only — not part of the production flow. |

All three "run" scripts are also wrapped as double-clickable `.command` launchers under
`~/Desktop/Engineering/Commands for clevertap/`.

## 5. Required credentials (all `.env`, never hardcoded)

- `KARIX_KEY` — Karix API key (`Authentication: Bearer <key>` header, non-standard header
  name — not `Authorization`).
- `SHEET_API_URL` — Apps Script Web App URL used by some scripts to write back to Sheets.
- CleverTap auth is **not** an env var — it's the Playwright-captured session in
  `auth.json` (gitignored, regenerated via `save-auth.js`).
- Google Sheets/Drive access for the Node scripts uses a locally-stored OAuth token
  (`~/.google_workspace_mcp/credentials/<email>.json`) — not part of this repo.

## 6. Known manual steps / gaps

- Segment IDs for brand-new cohorts (no prior-week match) must be created in CleverTap by
  a human before that row can be included in a real send.
- Reach-estimation per segment is not automated.
- Campaign "Var 1-4" (template body variables) and header image URL are filled by hand
  in the Campaigns tab before running the campaign-creation script.
- File handles for image headers expire ~7 days — the Apps Script path auto-refreshes on
  every run; the Node path re-fetches once per script invocation.
