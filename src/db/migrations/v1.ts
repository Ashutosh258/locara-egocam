// Migration v1 — initial schema.
//
// Design notes:
// - upload_state uses a CHECK constraint so the DB rejects invalid transitions
//   even if application logic has a bug. Belt-and-suspenders.
// - metadata is stored as JSON text to avoid schema churn for optional/bonus
//   fields (GPS, battery, network). Mandatory fields have explicit columns so
//   the query planner can use indexes on them.
// - next_retry_at is unix ms (INTEGER). Compared with Date.now() in the upload
//   queue query — keeps the math in one place and avoids timezone edge cases.
// - created_at is unix ms, not ISO string. Ordering by time is faster on
//   integers and avoids locale-dependent string comparison bugs.

export const v1Up = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id                TEXT    PRIMARY KEY,
    worker_id         TEXT    NOT NULL,
    started_at        TEXT    NOT NULL,
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
    metadata          TEXT,
    upload_state      TEXT    NOT NULL DEFAULT 'pending'
      CHECK(upload_state IN ('pending', 'uploading', 'uploaded', 'failed')),
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    last_attempted_at TEXT,
    next_retry_at     INTEGER,
    s3_key            TEXT,
    created_at        INTEGER NOT NULL
  );

  -- Dashboard query: paginated list for a worker, newest first.
  -- Composite covers both the WHERE worker_id = ? and ORDER BY created_at DESC
  -- without a separate sort step. Write overhead: one extra B-tree entry per insert.
  CREATE INDEX IF NOT EXISTS idx_rec_worker_created
    ON recordings(worker_id, created_at DESC);

  -- Upload queue query: find pending records or failed records past their
  -- backoff deadline. Partial index keeps it small — excludes the majority
  -- of rows (uploaded/uploading). Write overhead: only pending/failed rows pay it.
  CREATE INDEX IF NOT EXISTS idx_rec_upload_queue
    ON recordings(upload_state, next_retry_at)
    WHERE upload_state IN ('pending', 'failed');

  -- Dashboard filter by upload_state across all workers (admin/debug view).
  -- Without this, a full table scan is required to group by state.
  -- Write overhead: one entry per insert — acceptable given low insert rate.
  CREATE INDEX IF NOT EXISTS idx_rec_state
    ON recordings(upload_state, created_at DESC);
`;

// Rollback: drop in reverse dependency order.
// In practice we never run down migrations in production —
// we'd rather ship a forward-only fix — but this is useful for dev resets.
export const v1Down = `
  DROP INDEX IF EXISTS idx_rec_state;
  DROP INDEX IF EXISTS idx_rec_upload_queue;
  DROP INDEX IF EXISTS idx_rec_worker_created;
  DROP TABLE IF EXISTS recordings;
  DROP TABLE IF EXISTS schema_version;
`;
