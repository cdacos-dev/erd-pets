# Plan: Self-contained "Share link" (everything in the URL, no files)

> Status: planned, not started. Implement on this branch (`claude/share-link-plan`)
> or a fresh branch off `main`. PR #5 (parser FK fix) and PR #6 (recents + `#p=`
> URL keys) are already merged into `main`.

## Goal

Add a **Share** button that encodes the entire current project — the SQL schema
text **and** the diagram layout (positions, colors, notes, arrows, all diagram
tabs) — into a single URL the user can send to someone. Opening that URL renders
the diagram with **no files required** on the recipient's machine.

## Key decisions (already settled with the user)

- **Compression:** browser-native `CompressionStream('deflate-raw')` /
  `DecompressionStream('deflate-raw')`. No new dependency. Available in Chrome 80+,
  Safari 16.4+, Firefox 113+ — fine since the app is already Chrome-only. Node 22
  (our test runtime) exposes these as globals, so round-trip unit tests work in vitest.
- **Where in the URL:** the **fragment** (`#…`), never the query string. The
  fragment is not sent to the server, so it bypasses all server/proxy/CDN request
  limits (~8 KB) and stays out of server logs.
- **Size reality (measured on the user's ~16.8 KB `intercompany_isp.sql`):**
  deflate-raw → 3,068 bytes → **~4,091 base64url chars**. Add the diagram JSON
  envelope → **~4,200 chars**. SQL compresses ~5.3×.
  - Safe everywhere incl. QR: ≤ ~2,000 chars.
  - Fine in all modern browsers + almost all share channels: ≤ ~8,000 chars.
  - The real limit is the **sharing channel** (chat apps, email, link unfurlers),
    not the browser (Chrome ~2 MB) and not servers (fragment isn't sent).
  - Action: **warn** (don't block) when a generated link exceeds ~8,000 chars.
- **Privacy caveat to surface in UI copy:** the blob is plaintext to anyone with
  the link, and it is a **snapshot** — later edits require resending a new link.

## URL scheme

```
https://<host>/<path>#d=<base64url(deflate-raw(JSON envelope))>
```

- Param name `d` lives in the hash, parsed with `URLSearchParams` exactly like the
  existing `#p=<key>` recents key (see `src/lib/recentProjects.js`
  `getUrlProjectKey` / `setUrlProjectKey`). The two must coexist.
- **Precedence on load:** if `#d=` is present it wins over `#p=` (explicit share).
- **Envelope (compressed):**
  ```json
  { "v": 1, "sql": "<raw SQL text>", "diagram": "<serialized .erd-pets.json (JSONC)>" }
  ```
  `v` is a format version for forward-compat. `diagram` is the *string* produced by
  the existing `serializeDiagramFile(...)` so we reuse parse/serialize and capture
  current node positions. Compression makes the double-encoding overhead irrelevant.

## New module: `src/lib/shareLink.js`

Pure, framework-free, unit-testable. Exports:

- `isShareSupported(): boolean` — `typeof CompressionStream !== 'undefined'`.
- `async encodeShareLink({ sql, diagram }): Promise<string>` — build envelope
  `{v:1, sql, diagram}` → `TextEncoder` → `deflate-raw` via `CompressionStream` →
  `Uint8Array` → **base64url** (no padding). Returns just the blob (caller builds
  the full URL).
- `async decodeShareLink(blob): Promise<{ sql: string, diagram: string }>` —
  reverse; throws on malformed/corrupt/unsupported-version input.
- `getUrlShareBlob(): string | null` — read `d` from `location.hash`.
- `buildShareUrl(blob): string` — `location.origin + location.pathname + '#d=' + blob`
  (drops any existing hash; deliberately omits `#p=` since a share isn't a local recent).
- base64url helpers for `Uint8Array` ⇄ string (handle binary safely; do **not** use
  `btoa(String.fromCharCode(...))` on large arrays without chunking).
- `SHARE_SIZE_WARN = 8000` (chars) constant.

Streaming helper pattern:
```js
async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// inflate: DecompressionStream('deflate-raw'), same shape.
```

### Tests: `src/lib/shareLink.test.js`
- Round-trip: `decodeShareLink(await encodeShareLink(x))` deep-equals `x` (incl. the
  user's real SQL fixture if convenient, or a representative multi-table sample).
- base64url output contains only `[A-Za-z0-9_-]` (no `+`, `/`, `=`).
- `decodeShareLink` throws on garbage / truncated input and on unknown `v`.
- (Optional) assert compressed size is materially smaller than raw for SQL-like input.

## App integration: `src/App.svelte`

### 1. Generate (Share button)
- Add `handleShare()`:
  - Guard: `if (!parseResult || !diagramFile) { toast 'Open a diagram first'; return }`
    and `if (!isShareSupported()) { toast unsupported; return }`.
  - Capture current layout exactly like `performSave()` does: `getNodePositions()` +
    note positions, then `serializeDiagramFile(diagramFile, selectedDiagramId,
    nodePositions, parseResult?.tables ?? [])` → `diagramString`.
  - `blob = await encodeShareLink({ sql: sqlContent, diagram: diagramString })`.
  - `url = buildShareUrl(blob)`; `await navigator.clipboard.writeText(url)`.
  - Toast success: "Share link copied (N chars)". If `url.length > SHARE_SIZE_WARN`,
    toast a warning that some chat apps may truncate it.
- Wire a **Share** button in `src/lib/DiagramToolbar.svelte` next to Export, shown
  when a diagram is loaded (use the "has diagram" flag below, not `fileLoaded`).

### 2. Load from a share link (extend existing `onMount`)
The `onMount` in `App.svelte` already handles `#p=`. Add a **first** branch:
- `const blob = getUrlShareBlob(); if (blob) { await loadSharedProject(blob); return; }`
  (so `#d=` takes precedence over `#p=`).
- `async loadSharedProject(blob)`:
  - `try { const { sql, diagram } = await decodeShareLink(blob); }` → on throw, toast
    "This share link is invalid or corrupted." and fall through to the welcome screen.
  - `const { data: parsedDiagram } = parseDiagramFile(diagram)` (reuse existing parser).
  - `parseResult = parsePostgresSQL(sql)`; set `sqlContent = sql`,
    `diagramFile = parsedDiagram`, `diagramContent = diagram`,
    `selectedDiagramId = parsedDiagram.diagrams[0]?.id ?? ''`, render via
    `convertToFlowWithDiagram(...)` (or `convertToFlow` if no diagrams).
  - **Leave `diagramHandle = null` and `sqlHandle = null`** — there are no files.
  - Set a new flag `isSharedSession = true` (see §3). Do **not** add to recents
    (no handles to persist). Optionally `setUrlProjectKey` is NOT called.

### 3. Handle-less ("shared / read-only") mode — the main integration risk
The app currently conflates "a project is loaded" with "writable file handles
exist" via `!!diagramHandle`. A shared session has a loaded diagram but no handles.
**Audit and split these two concepts:**

- Add `let hasDiagram = $derived(!!diagramFile && !!parseResult);` (= something is on
  screen) vs the existing `diagramHandle`/`sqlHandle` (= can write to disk).
- **Welcome overlay:** currently rendered when `!diagramHandle`. Change the condition
  to `!hasDiagram` (otherwise the welcome screen covers a shared diagram). Search for
  the `{#if !diagramHandle}` wrapping `<RecentProjects … />` in the markup.
- **Toolbar `fileLoaded` prop:** currently `fileLoaded={!!diagramHandle}`. Decide per
  button:
  - Sidebar toggle, Export, Share, Layout, diagram tabs, Add diagram, Diagram
    settings → gate on `hasDiagram`.
  - **Save, Refresh** → keep gated on `!!diagramHandle` (no file = can't save/refresh).
    They naturally hide in shared mode.
- **SQL-mutating actions** (`handleCreateTable`, `handleCreateRelationship`,
  `handleDeleteRelationship`, `handleTogglePrimaryKey`, `handleDropTableRequest`,
  add/remove PK column) all early-return with `if (!sqlHandle)`. In shared mode they
  will no-op; improve the message to: "This is a shared diagram. Use **Save as
  files…** to edit it." (toast or disabled buttons). Pick disabled buttons where easy.
- Layout drags still work in memory but can't be saved. That's fine; see §4.

### 4. "Save as files…" (converts a shared session into a real local project) — recommended
So a recipient can keep/edit the shared diagram:
- Button shown only when `isSharedSession`.
- Flow: prompt for SQL save location (`showSaveFilePicker`, write `sqlContent`) to get
  `sqlHandle`; then `saveNewDiagramFile(serializedDiagram, sqlHandle)` for
  `diagramHandle` (mirror `handleNew` steps 3-5). Then `rememberProject(...)` (from the
  recents module) and clear `isSharedSession`. After this, Save/Refresh/edit all work
  and it appears in recents + gets a `#p=` key.
- If this is deferred, at minimum let the user **re-Share** after dragging, so layout
  tweaks aren't lost.

## Edge cases / failure handling
- `CompressionStream` unsupported → Share button hidden/disabled + toast on attempt.
- Corrupt/truncated `#d=` → caught in `loadSharedProject`, toast, show welcome.
- Unknown envelope `v` → throw in `decodeShareLink`, treated as corrupt.
- Both `#d=` and `#p=` present → `#d=` wins.
- Empty/zero-table SQL in a share → render nothing but don't crash (existing
  "No tables found" path).
- Very large link → warn at 8,000 chars; never hard-block.
- Clipboard API can reject (permissions) → fall back to showing the URL in a toast /
  prompt so the user can copy manually.

## Files touched (summary)
- **New** `src/lib/shareLink.js` — encode/decode/url helpers + size constant.
- **New** `src/lib/shareLink.test.js` — round-trip + format tests.
- **Edit** `src/App.svelte` — `handleShare`, `loadSharedProject`, `onMount` `#d=`
  branch, `isSharedSession` state, `hasDiagram` derived, welcome-overlay condition,
  gating of mutating actions, optional "Save as files…".
- **Edit** `src/lib/DiagramToolbar.svelte` — Share button (+ optional "Save as
  files…"), split `fileLoaded` usage into "has diagram" vs "has handle".
- **Optional** `README.md` / `doc/` — document the share-link feature + caveats.

## Out of scope (future)
- Backend "short link" / paste service (`#s=<id>`), optionally with an encryption key
  in the fragment (Excalidraw-style) for guaranteed-short URLs and very large schemas.
- QR-code generation for small links (≤ ~2,000 chars).
- `lz-string` alternative encoder (only if we ever need to drop the
  `CompressionStream` requirement for non-Chromium browsers).

## Suggested implementation order
1. `shareLink.js` + tests (pure; fully testable, no UI). Verify round-trip + sizes.
2. `handleShare` + toolbar Share button (generate side).
3. `onMount` `#d=` decode + `loadSharedProject` (consume side).
4. Handle-less mode audit: `hasDiagram`, welcome condition, button gating.
5. "Save as files…" conversion.
6. README/doc + manual test (generate link, open in incognito, oversize warning,
   corrupt-blob handling).
