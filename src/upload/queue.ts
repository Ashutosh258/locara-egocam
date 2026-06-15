import { getUploadQueue, resetStaleUploading } from '../db/recordings';
import { uploadOne } from './engine';
import type { QueueEntry } from '../types';

// This module owns one shared lock to prevent overlapping drain() calls.
// The scheduler can fire on multiple triggers (interval + AppState + NetInfo)
// and we don't want two concurrent drains reading the same queue rows.
let draining = false;

// Called once on app start. Any record in 'uploading' state means the previous
// process was killed mid-transfer. Reset to 'pending' so the scheduler retries.
export function recoverInterruptedUploads(): void {
  resetStaleUploading();
}

// Process the upload queue. Runs sequentially rather than in parallel to
// avoid saturating the device's connection on cellular or throttled wifi.
// The batch size of 5 (set in getUploadQueue) limits how long one drain
// holds the CPU before yielding to the next scheduler tick.
export async function drainQueue(token: string): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    const entries: QueueEntry[] = getUploadQueue(Date.now());

    for (const entry of entries) {
      await uploadOne(entry, token);
    }
  } finally {
    draining = false;
  }
}
