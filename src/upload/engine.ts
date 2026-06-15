import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { QueueEntry } from '../types';
import {
  claimForUpload,
  markUploaded,
  markFailed,
  getRecordingById,
  updateMetadataField,
} from '../db/recordings';
import { fetchPresignedUrl } from './presigned';
import { nextRetryAt } from './backoff';
import { isNetworkAvailable, currentNetworkType } from '../utils/network';

const MAX_RETRIES = 6;

// Result shape returned to the scheduler for logging/metrics.
type UploadResult =
  | { status: 'uploaded'; s3_key: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export async function uploadOne(entry: QueueEntry, token: string): Promise<UploadResult> {
  // Guard: don't attempt if we have no connectivity at all.
  if (!(await isNetworkAvailable())) {
    return { status: 'skipped', reason: 'no network' };
  }

  // Guard: exceeded max retries — leave it in failed state for manual retry.
  if (entry.attempt_count >= MAX_RETRIES) {
    return { status: 'skipped', reason: 'max retries reached' };
  }

  // Guard: file was deleted locally (user cleared storage).
  if (!entry.local_path) {
    markFailed(entry.id, 'local file deleted', nextRetryAt(entry.attempt_count));
    return { status: 'skipped', reason: 'local file missing' };
  }

  // Verify the file actually exists before claiming the DB slot.
  // Avoids burning an upload attempt on a missing file.
  const exists = await RNFS.exists(entry.local_path);
  if (!exists) {
    markFailed(entry.id, 'file not found on disk', nextRetryAt(entry.attempt_count));
    return { status: 'failed', error: 'file not found on disk' };
  }

  // Atomically claim the upload slot. If claimForUpload returns false, another
  // scheduler tick already claimed this entry — skip without error.
  const claimed = claimForUpload(entry.id);
  if (!claimed) {
    return { status: 'skipped', reason: 'claimed by concurrent tick' };
  }

  try {
    const presigned = await fetchPresignedUrl(entry.id, entry.worker_id, token);

    // Fetch the file as a blob and PUT directly to S3.
    // react-native-fs gives us a base64 string; we convert to a Blob for fetch.
    // For files >50MB on slow connections this will block — multipart upload
    // would be the production improvement, but that requires backend coordination.
    const fileContent = await RNFS.readFile(entry.local_path, 'base64');
    const binary = Buffer.from(fileContent, 'base64');

    const uploadRes = await fetch(presigned.url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(binary.length),
      },
      body: binary,
    });

    if (!uploadRes.ok) {
      // S3 returns XML error bodies; grab it for the error log.
      const errBody = await uploadRes.text().catch(() => '');
      throw new Error(`S3 PUT failed ${uploadRes.status}: ${errBody.slice(0, 200)}`);
    }

    // Persist network type for analytics.
    const networkType = await currentNetworkType();
    updateMetadataField(entry.id, { network_type: networkType });

    markUploaded(entry.id, presigned.s3_key);
    return { status: 'uploaded', s3_key: presigned.s3_key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markFailed(entry.id, message, nextRetryAt(entry.attempt_count));
    return { status: 'failed', error: message };
  }
}
