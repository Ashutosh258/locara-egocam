# Locara EgoCam

Ego-centric video capture system for Android. Workers capture first-person video, metadata is persisted locally in SQLite, and videos are synced to S3 via a durable upload queue that survives process death and device restarts.

---

## Setup

```bash
npm install
cp .env.example .env        # fill in AWS credentials for the mock backend
npx ts-node backend/server.ts   # start local presigned URL server
npx react-native run-android
```

**Device tested on:** Pixel 7 emulator (Android 14 / API 34), physical Samsung Galaxy A52 (Android 13).

---

## Architecture

```
┌──────────────┐   capture   ┌────────────────┐   insert    ┌──────────────┐
│  CameraScreen│ ──────────► │ useRecording + │ ──────────► │   SQLite DB  │
│  (Vision Cam)│             │  metadata.ts   │             │  (egocam.db) │
└──────────────┘             └────────────────┘             └──────┬───────┘
                                                                   │ getUploadQueue()
                                                            ┌──────▼───────┐
                                                            │  Scheduler   │
                                                            │  (30s + net  │
                                                            │   + AppState)│
                                                            └──────┬───────┘
                                                                   │ drainQueue()
                                                            ┌──────▼───────┐
                                                            │  Upload      │
                                                            │  Engine      │
                                                            └──────┬───────┘
                                          ┌──────────────┐        │
                                          │ Backend API  │ ◄──────┤ fetchPresignedUrl()
                                          │ (Lambda /    │        │
                                          │  mock server)│        │
                                          └──────┬───────┘        │
                                                 │ presigned URL  │
                                          ┌──────▼───────┐        │
                                          │   AWS S3     │ ◄──────┘ PUT
                                          └──────────────┘
```

### Data flow

1. **Capture → DB**: `useRecording` starts recording, moves temp file to stable path, calls `buildRecordingRow` (device metadata + file stats), writes to `recordings` table with `upload_state = 'pending'`.

2. **DB → Queue**: `getUploadQueue()` queries the partial index for `pending` rows or `failed` rows past their backoff deadline. Batch size is 5.

3. **Queue → S3**: `uploadOne` claims the row via an atomic `UPDATE ... WHERE upload_state IN ('pending','failed')`, fetches a presigned URL from the backend, PUTs the file to S3, then writes `uploaded` or `failed` back to the DB.

4. **Scheduler triggers**: 30-second interval + `AppState` foreground event + `NetInfo` reconnect event. All three funnel into a single `drainQueue()` guarded by an in-process lock.

---

## Database Design

### Schema

```sql
CREATE TABLE recordings (
  id                TEXT    PRIMARY KEY,             -- UUID v4 (video_id)
  worker_id         TEXT    NOT NULL,
  started_at        TEXT    NOT NULL,                -- ISO 8601
  ended_at          TEXT    NOT NULL,
  duration_ms       INTEGER NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  fps               REAL    NOT NULL,
  fps_tier          TEXT    NOT NULL
    CHECK(fps_tier IN ('low', 'standard', 'high')),
  device_model      TEXT    NOT NULL,
  os_version        TEXT    NOT NULL,
  resolution        TEXT    NOT NULL,
  local_path        TEXT    NOT NULL,
  metadata          TEXT,                            -- JSON: gps, battery, network
  upload_state      TEXT    NOT NULL DEFAULT 'pending'
    CHECK(upload_state IN ('pending', 'uploading', 'uploaded', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_attempted_at TEXT,
  next_retry_at     INTEGER,                         -- unix ms, for backoff scheduling
  s3_key            TEXT,
  created_at        INTEGER NOT NULL                 -- unix ms
);
```

**Why `created_at` as unix ms (INTEGER) instead of ISO string?**
Integer ordering is a native B-tree operation. String ordering for ISO 8601 would work but requires the query planner to treat it as a text comparison, and any locale or timezone bug would silently corrupt ordering. The tradeoff is that the value is less human-readable in a raw DB dump — acceptable.

**Why `metadata` as JSON text?**
GPS, battery, and network_type are optional bonus fields. Putting them in the JSON column avoids schema migrations for feature additions. Mandatory, indexed fields (worker_id, upload_state) stay as typed columns. We never need to query `metadata.gps.lat > X` — if we did, we'd promote that to a column.

### Indexes

```sql
-- Index 1: Dashboard pagination (worker-scoped, newest first)
CREATE INDEX idx_rec_worker_created
  ON recordings(worker_id, created_at DESC);
```
**Query served:**
```sql
SELECT * FROM recordings WHERE worker_id = ? ORDER BY created_at DESC LIMIT 20 OFFSET ?;
```
The composite `(worker_id, created_at DESC)` means the query planner satisfies both the `WHERE` and `ORDER BY` from a single index scan — no filesort. Without this index, every page load does a full table sort.
**Write overhead:** One B-tree entry per insert. Acceptable — inserts happen at most once per recording (low rate).

```sql
-- Index 2: Upload queue (partial, on pending/failed only)
CREATE INDEX idx_rec_upload_queue
  ON recordings(upload_state, next_retry_at)
  WHERE upload_state IN ('pending', 'failed');
```
**Query served:**
```sql
SELECT ... FROM recordings
WHERE upload_state = 'pending'
   OR (upload_state = 'failed' AND next_retry_at <= ?)
ORDER BY created_at ASC LIMIT 5;
```
The partial index excludes `uploaded` and `uploading` rows — at steady state, the vast majority of rows. A worker with 7,300 recordings might have only 3–5 in this index at any given time. Without the partial index, the queue query scans all rows on every scheduler tick (every 30 seconds).
**Write overhead:** Only `pending` and `failed` rows pay the insert cost. `uploaded` rows (the majority at steady state) do not.

```sql
-- Index 3: State distribution (admin/debug, all workers)
CREATE INDEX idx_rec_state
  ON recordings(upload_state, created_at DESC);
```
**Query served:** `SELECT upload_state, COUNT(*) FROM recordings GROUP BY upload_state` (dashboard stats). Without this, a full scan groups all rows. With it, SQLite counts using the index.
**Write overhead:** One B-tree entry per insert — same cost as Index 1. The additional 8–16 bytes per row is well within acceptable range given insert rate.

### Migration strategy

Migrations are versioned integers tracked in a `schema_version` table. The runner reads `MAX(version)` on startup, runs only migrations newer than the current version, and wraps each migration in a transaction. A failed migration rolls back fully — the version row is never written, so the next launch retries.

**Adding a column to 50K existing rows (e.g. `gps_accuracy REAL`):**

```sql
-- Migration v2
ALTER TABLE recordings ADD COLUMN gps_accuracy REAL;
```

`ALTER TABLE ... ADD COLUMN` in SQLite is O(1) — it updates the schema without touching existing rows. Existing rows get `NULL` for the new column. No data migration needed unless the column is `NOT NULL` without a default.

If `NOT NULL` with default is needed:
```sql
ALTER TABLE recordings ADD COLUMN gps_accuracy REAL NOT NULL DEFAULT -1;
```
SQLite still handles this in O(1) via a schema update (it stores the default in the schema, not in each row). This is a safe production migration with zero downtime.

**Rollback strategy:** We ship forward-only migrations in production. The `v1Down` function exists for local dev resets. In production, if a migration causes issues, we ship a `v3` that reverts the schema change. We never run `DOWN` migrations on a live device.

### Optimised queries

**Dashboard pagination — why it scales:**
At 10K workers × 365 days × 20 videos = 73M total rows across all workers. Per-worker, a given worker sees ~7,300 rows. The `idx_rec_worker_created` index restricts the scan to that worker's rows only (log n lookup), then iterates the index in `created_at DESC` order — no sort step, no cross-worker data read. The query cost grows with the page offset (deeper pages scan more index entries), not with total table size.

**Upload queue — why it scales:**
The partial index keeps only `pending` + `failed` rows. At steady state (most videos uploaded), this is a tiny fraction of the total table. A 10K-worker deployment at 99% upload success rate keeps ~100–500 rows in the partial index at any moment. The queue query is O(log n) on that small index, not O(n) on the full table.

---

## Upload Engine

### State machine

```
pending ──► uploading ──► uploaded  (terminal)
                │
                └──► failed ──► pending  (via retry)
```

Transitions are enforced at two levels:
1. **Application level** (`src/upload/state.ts`): `assertTransition` / `canTransition` throw or return false for invalid transitions.
2. **Database level**: The `UPDATE ... WHERE upload_state = ?` pattern means a transition only applies if the DB is in the expected prior state. `claimForUpload` uses `WHERE upload_state IN ('pending', 'failed')` — if two scheduler ticks race, only one wins.

### Idempotency

The S3 key is `workers/{worker_id}/videos/{video_id}.mp4`. The `video_id` is a UUID generated at capture time and stored as the primary key. If an upload is retried after a network interruption:
- The same presigned URL (or a fresh one) targets the exact same S3 key.
- S3 PUT is idempotent: uploading the same content to the same key replaces with identical bytes.
- The DB write uses `WHERE upload_state = 'uploading'` — so even if `markUploaded` is called twice (e.g. race between two scheduler instances), the second call is a no-op.

### Exponential backoff

`delay = min(2^attempt × 2000ms, 64000ms) ± 10% jitter`

| Attempt | Base delay | With 0% jitter |
|---------|-----------|----------------|
| 0       | 2s        | 2s             |
| 1       | 4s        | 4s             |
| 2       | 8s        | 8s             |
| 3       | 16s       | 16s            |
| 4       | 32s       | 32s            |
| 5+      | 64s (cap) | 64s            |

Jitter prevents thundering herd if many workers fail simultaneously (e.g. a regional S3 outage restores and all 10K workers retry at once).

### Edge case handling

| Scenario | Handling |
|---|---|
| No internet | `isNetworkAvailable()` returns false → skip, no attempt consumed |
| App killed mid-upload | `resetStaleUploading()` on startup resets `uploading → pending` |
| Presigned URL expiration | `fetchPresignedUrl` checks TTL; rejects URLs with <30s remaining |
| File not found | `RNFS.exists()` check before claiming; marks `failed` without burning a network attempt |
| File deleted by user | `local_path = ''` sentinel; upload engine skips with `status: skipped` |
| Concurrent scheduler ticks | `drainQueue` in-process lock + DB-level `claimForUpload` both guard against double processing |
| Max retries reached | `attempt_count >= MAX_RETRIES` check skips without incrementing; leaves in `failed` for manual retry |

---

## Scalability

**What breaks first at 10,000 workers?**

See `INFRA.md` for the full analysis. Short answer: the presigned URL Lambda becomes the bottleneck at ~200 req/s (10K workers × 20 videos = 200K requests/day = ~2.3/s average, but spiky at shift start). Concurrent uploads from the same workers hit S3 PUT rate limits per prefix partition. Both are solved by Lambda auto-scaling and S3 prefix distribution (handled by the UUID-in-key strategy).

The mobile SQLite layer scales without issue — it's local per device.

---

## What I'd improve given more time

1. **Multipart upload** for files >10MB. The current PUT approach re-sends the full file on any retry. Multipart would resume from the last completed part, critical for slow cellular connections.
2. **Background upload** using Android WorkManager (`react-native-background-fetch` or a headless task). Currently the scheduler stops when the app is killed.
3. **Push confirmation** via S3 Event → Lambda → mobile push notification so workers know their upload is confirmed without polling.
4. **GPS integration** using `react-native-geolocation-service` — the hook and metadata schema already support it, just needs the call wired in.
5. **Integration tests** against a real SQLite file using a device farm or Detox.
