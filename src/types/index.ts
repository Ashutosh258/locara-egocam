export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';

export type FpsTier = 'low' | 'standard' | 'high';

export interface RecordingMetadata {
  gps?: { lat: number; lng: number; accuracy: number };
  battery_start?: number;
  battery_end?: number;
  network_type?: 'wifi' | 'cellular' | 'none';
}

export interface Recording {
  id: string;
  worker_id: string;
  started_at: string;   // ISO 8601
  ended_at: string;     // ISO 8601
  duration_ms: number;
  file_size_bytes: number;
  fps: number;
  fps_tier: FpsTier;
  device_model: string;
  os_version: string;
  resolution: string;
  local_path: string;
  metadata: RecordingMetadata | null;
  upload_state: UploadState;
  attempt_count: number;
  last_error: string | null;
  last_attempted_at: string | null;
  next_retry_at: number | null;  // unix ms — when backoff expires
  s3_key: string | null;
  created_at: number;            // unix ms
}

// Subset needed by the upload queue; avoids passing full rows around
export interface QueueEntry {
  id: string;
  worker_id: string;
  local_path: string;
  attempt_count: number;
  s3_key: string | null;
}

export interface Session {
  worker_id: string;
  token: string;
  email: string;
}

export interface PresignedUrlResponse {
  url: string;
  s3_key: string;
  expires_at: number; // unix ms
}
