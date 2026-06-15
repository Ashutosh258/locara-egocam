import type { PresignedUrlResponse } from '../types';

// The backend generates the presigned URL, keeping AWS credentials
// off the device entirely. In production this is a Lambda function.
// In development it's the local mock server at PRESIGNED_URL_API.
const API_BASE = process.env.PRESIGNED_URL_API ?? 'http://10.0.2.2:3001';

// TTL buffer: reject URLs that expire in less than 30 seconds.
// A 60-second video upload on a slow connection needs headroom.
const MIN_TTL_MS = 30_000;

export async function fetchPresignedUrl(
  videoId: string,
  workerId: string,
  token: string,
): Promise<PresignedUrlResponse> {
  const res = await fetch(`${API_BASE}/presigned-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ video_id: videoId, worker_id: workerId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Presigned URL request failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as PresignedUrlResponse;

  if (data.expires_at - Date.now() < MIN_TTL_MS) {
    // The URL was generated just now but somehow already near expiry —
    // more likely a clock skew issue than a real problem. Reject and let
    // the engine retry (it will fetch a fresh URL next attempt).
    throw new Error('Presigned URL expires too soon — possible clock skew');
  }

  return data;
}
