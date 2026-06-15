import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { Recording, RecordingMetadata } from '../types';
import { getDeviceModel, getOsVersion, getBatteryLevel, fpsTier } from '../utils/device';

interface CaptureContext {
  videoId: string;
  workerId: string;
  startedAt: Date;
  endedAt: Date;
  localPath: string;
  fps: number;
  resolution: string;
  gps: RecordingMetadata['gps'];
  batteryStart: number;
}

export async function buildRecordingRow(
  ctx: CaptureContext,
): Promise<Omit<Recording, 'upload_state' | 'attempt_count' | 'last_error' | 'last_attempted_at' | 'next_retry_at' | 's3_key'>> {
  const [deviceModel, osVersion, batteryEnd, stat] = await Promise.all([
    getDeviceModel(),
    getOsVersion(),
    getBatteryLevel(),
    RNFS.stat(ctx.localPath),
  ]);

  const duration_ms = ctx.endedAt.getTime() - ctx.startedAt.getTime();

  const metadata: RecordingMetadata = {
    battery_start: ctx.batteryStart,
    battery_end: batteryEnd,
  };
  if (ctx.gps) {
    metadata.gps = ctx.gps;
  }

  return {
    id: ctx.videoId,
    worker_id: ctx.workerId,
    started_at: ctx.startedAt.toISOString(),
    ended_at: ctx.endedAt.toISOString(),
    duration_ms,
    file_size_bytes: stat.size,
    fps: ctx.fps,
    fps_tier: fpsTier(ctx.fps),
    device_model: deviceModel,
    os_version: osVersion,
    resolution: ctx.resolution,
    local_path: ctx.localPath,
    metadata,
    created_at: ctx.startedAt.getTime(),
  };
}
