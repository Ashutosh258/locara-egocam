import { getDb } from './client';
import type { Recording, QueueEntry, UploadState, RecordingMetadata } from '../types';

// ─── helpers ────────────────────────────────────────────────────────────────

function rowToRecording(row: Record<string, unknown>): Recording {
  return {
    id: row.id as string,
    worker_id: row.worker_id as string,
    started_at: row.started_at as string,
    ended_at: row.ended_at as string,
    duration_ms: row.duration_ms as number,
    file_size_bytes: row.file_size_bytes as number,
    fps: row.fps as number,
    fps_tier: row.fps_tier as Recording['fps_tier'],
    device_model: row.device_model as string,
    os_version: row.os_version as string,
    resolution: row.resolution as string,
    local_path: row.local_path as string,
    metadata: row.metadata ? (JSON.parse(row.metadata as string) as RecordingMetadata) : null,
    upload_state: row.upload_state as UploadState,
    attempt_count: row.attempt_count as number,
    last_error: (row.last_error as string | null) ?? null,
    last_attempted_at: (row.last_attempted_at as string | null) ?? null,
    next_retry_at: (row.next_retry_at as number | null) ?? null,
    s3_key: (row.s3_key as string | null) ?? null,
    created_at: row.created_at as number,
  };
}

// ─── writes ─────────────────────────────────────────────────────────────────

export function insertRecording(r: Omit<Recording, 'upload_state' | 'attempt_count' | 'last_error' | 'last_attempted_at' | 'next_retry_at' | 's3_key'>): void {
  const db = getDb();
  db.execute(
    `INSERT INTO recordings (
       id, worker_id, started_at, ended_at, duration_ms, file_size_bytes,
       fps, fps_tier, device_model, os_version, resolution, local_path,
       metadata, upload_state, attempt_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?);`,
    [
      r.id,
      r.worker_id,
      r.started_at,
      r.ended_at,
      r.duration_ms,
      r.file_size_bytes,
      r.fps,
      r.fps_tier,
      r.device_model,
      r.os_version,
      r.resolution,
      r.local_path,
      r.metadata ? JSON.stringify(r.metadata) : null,
      r.created_at,
    ],
  );
}

// Claim a record for upload. Returns true if we won the race; false if another
// worker (or a concurrent scheduler tick) already claimed it.
export function claimForUpload(id: string): boolean {
  const db = getDb();
  const result = db.execute(
    `UPDATE recordings
     SET upload_state = 'uploading', last_attempted_at = ?
     WHERE id = ? AND upload_state IN ('pending', 'failed');`,
    [new Date().toISOString(), id],
  );
  return (result.rowsAffected ?? 0) > 0;
}

export function markUploaded(id: string, s3Key: string): void {
  const db = getDb();
  // WHERE clause enforces the rule: uploaded is terminal and can only be
  // reached from uploading. If the row was already uploaded, rowsAffected = 0
  // and we silently succeed (idempotent).
  db.execute(
    `UPDATE recordings
     SET upload_state = 'uploaded', s3_key = ?
     WHERE id = ? AND upload_state = 'uploading';`,
    [s3Key, id],
  );
}

export function markFailed(id: string, error: string, nextRetryAt: number): void {
  const db = getDb();
  db.execute(
    `UPDATE recordings
     SET upload_state = 'failed',
         attempt_count = attempt_count + 1,
         last_error = ?,
         next_retry_at = ?
     WHERE id = ? AND upload_state = 'uploading';`,
    [error, nextRetryAt, id],
  );
}

// On app restart, any record stuck in 'uploading' means the process was killed
// mid-transfer. Reset to 'pending' so the scheduler picks them up again.
export function resetStaleUploading(): void {
  const db = getDb();
  db.execute(
    `UPDATE recordings
     SET upload_state = 'pending', last_error = 'interrupted by process exit'
     WHERE upload_state = 'uploading';`,
  );
}

// Manual retry from dashboard: re-queue a failed upload immediately.
export function requeueFailed(id: string): boolean {
  const db = getDb();
  const result = db.execute(
    `UPDATE recordings
     SET upload_state = 'pending', next_retry_at = NULL, last_error = NULL
     WHERE id = ? AND upload_state = 'failed';`,
    [id],
  );
  return (result.rowsAffected ?? 0) > 0;
}

// Soft-delete: nullify local_path so the file handle is gone but the DB row
// and upload history are preserved. The upload engine checks for null path
// and skips gracefully.
export function clearLocalFile(id: string): boolean {
  const db = getDb();
  const result = db.execute(
    `UPDATE recordings
     SET local_path = ''
     WHERE id = ? AND upload_state != 'uploading';`,
    [id],
  );
  return (result.rowsAffected ?? 0) > 0;
}

export function updateMetadataField(id: string, patch: Partial<RecordingMetadata>): void {
  const db = getDb();
  const row = db.execute('SELECT metadata FROM recordings WHERE id = ?;', [id]);
  const existing: RecordingMetadata = row.rows?.item(0)?.metadata
    ? JSON.parse(row.rows.item(0).metadata as string)
    : {};
  const updated = { ...existing, ...patch };
  db.execute('UPDATE recordings SET metadata = ? WHERE id = ?;', [
    JSON.stringify(updated),
    id,
  ]);
}

// ─── reads ──────────────────────────────────────────────────────────────────

export function getRecordingById(id: string): Recording | null {
  const db = getDb();
  const result = db.execute('SELECT * FROM recordings WHERE id = ?;', [id]);
  const row = result.rows?.item(0);
  return row ? rowToRecording(row as Record<string, unknown>) : null;
}

// Dashboard pagination. Uses idx_rec_worker_created: (worker_id, created_at DESC).
// The index covers the WHERE and ORDER BY, so SQLite avoids a filesort entirely.
// At 20 videos/day × 365 days, a worker accumulates ~7300 rows —
// the index keeps this O(log n + page_size) regardless of total table size.
export function listRecordingsByWorker(
  workerId: string,
  limit: number,
  offset: number,
): Recording[] {
  const db = getDb();
  const result = db.execute(
    `SELECT * FROM recordings
     WHERE worker_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?;`,
    [workerId, limit, offset],
  );

  const rows: Recording[] = [];
  for (let i = 0; i < (result.rows?.length ?? 0); i++) {
    rows.push(rowToRecording(result.rows!.item(i) as Record<string, unknown>));
  }
  return rows;
}

// Upload queue. Uses idx_rec_upload_queue: partial index on (upload_state, next_retry_at)
// WHERE upload_state IN ('pending', 'failed').
// The partial index excludes uploaded/uploading rows — the vast majority of rows
// at steady state — so the index stays small and fast as the table grows.
// LIMIT 5 caps the batch size; we process a small window and let the scheduler
// tick again rather than holding a large result set in memory.
export function getUploadQueue(nowMs: number): QueueEntry[] {
  const db = getDb();
  const result = db.execute(
    `SELECT id, worker_id, local_path, attempt_count, s3_key
     FROM recordings
     WHERE upload_state = 'pending'
        OR (upload_state = 'failed' AND next_retry_at <= ?)
     ORDER BY created_at ASC
     LIMIT 5;`,
    [nowMs],
  );

  const entries: QueueEntry[] = [];
  for (let i = 0; i < (result.rows?.length ?? 0); i++) {
    const row = result.rows!.item(i) as Record<string, unknown>;
    entries.push({
      id: row.id as string,
      worker_id: row.worker_id as string,
      local_path: row.local_path as string,
      attempt_count: row.attempt_count as number,
      s3_key: (row.s3_key as string | null) ?? null,
    });
  }
  return entries;
}

export function countByState(workerId: string): Record<UploadState, number> {
  const db = getDb();
  const result = db.execute(
    `SELECT upload_state, COUNT(*) AS cnt
     FROM recordings
     WHERE worker_id = ?
     GROUP BY upload_state;`,
    [workerId],
  );

  const counts: Record<UploadState, number> = {
    pending: 0,
    uploading: 0,
    uploaded: 0,
    failed: 0,
  };

  for (let i = 0; i < (result.rows?.length ?? 0); i++) {
    const row = result.rows!.item(i) as { upload_state: UploadState; cnt: number };
    counts[row.upload_state] = row.cnt;
  }
  return counts;
}
