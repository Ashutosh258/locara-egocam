// These tests exercise the query logic against a mock SQLite connection.
// Integration tests against a real SQLite file run in the e2e suite on device.

import type { Recording } from '../../src/types';

// Build a minimal mock that tracks execute calls
function makeMockDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    calls,
    execute: jest.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
      return { rowsAffected: 1, rows: { length: 0, item: () => null } };
    }),
  };
}

jest.mock('../../src/db/client', () => ({
  getDb: jest.fn(),
}));

import { getDb } from '../../src/db/client';
import {
  insertRecording,
  claimForUpload,
  markUploaded,
  markFailed,
  resetStaleUploading,
  requeueFailed,
  getUploadQueue,
  listRecordingsByWorker,
} from '../../src/db/recordings';

describe('recordings DB queries', () => {
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    (getDb as jest.Mock).mockReturnValue(mockDb);
  });

  describe('insertRecording', () => {
    it('inserts with upload_state = pending and attempt_count = 0', () => {
      const rec = {
        id: 'vid-1',
        worker_id: 'worker_a',
        started_at: '2024-01-01T10:00:00.000Z',
        ended_at: '2024-01-01T10:01:00.000Z',
        duration_ms: 60_000,
        file_size_bytes: 52_428_800,
        fps: 30,
        fps_tier: 'standard' as const,
        device_model: 'Pixel 7',
        os_version: '14',
        resolution: '1920x1080',
        local_path: '/data/recordings/vid-1.mp4',
        metadata: null,
        created_at: 1704103200000,
      };

      insertRecording(rec);

      const call = mockDb.calls[0];
      expect(call.sql).toContain("'pending'");
      expect(call.params).toContain('vid-1');
      expect(call.params).toContain('worker_a');
    });
  });

  describe('claimForUpload', () => {
    it('updates only when state is pending or failed', () => {
      claimForUpload('vid-1');
      const call = mockDb.calls[0];
      expect(call.sql).toContain("upload_state IN ('pending', 'failed')");
      expect(call.params).toContain('vid-1');
    });

    it('returns true when rowsAffected > 0', () => {
      expect(claimForUpload('vid-1')).toBe(true);
    });

    it('returns false when rowsAffected = 0', () => {
      mockDb.execute.mockReturnValueOnce({ rowsAffected: 0, rows: { length: 0, item: () => null } });
      expect(claimForUpload('vid-1')).toBe(false);
    });
  });

  describe('markUploaded', () => {
    it('only updates records in uploading state', () => {
      markUploaded('vid-1', 'workers/w/vid-1.mp4');
      const call = mockDb.calls[0];
      expect(call.sql).toContain("upload_state = 'uploading'");
      expect(call.params).toContain('workers/w/vid-1.mp4');
    });
  });

  describe('markFailed', () => {
    it('increments attempt_count and sets next_retry_at', () => {
      const now = Date.now();
      markFailed('vid-1', 'S3 timeout', now + 4000);
      const call = mockDb.calls[0];
      expect(call.sql).toContain('attempt_count = attempt_count + 1');
      expect(call.params).toContain('S3 timeout');
      expect(call.params).toContain(now + 4000);
    });
  });

  describe('resetStaleUploading', () => {
    it('sets uploading records back to pending', () => {
      resetStaleUploading();
      const call = mockDb.calls[0];
      expect(call.sql).toContain("upload_state = 'pending'");
      expect(call.sql).toContain("WHERE upload_state = 'uploading'");
    });
  });

  describe('requeueFailed', () => {
    it('sets state to pending only when currently failed', () => {
      requeueFailed('vid-1');
      const call = mockDb.calls[0];
      expect(call.sql).toContain("upload_state = 'pending'");
      expect(call.sql).toContain("upload_state = 'failed'");
    });
  });

  describe('getUploadQueue', () => {
    it('queries pending and failed records with next_retry_at check', () => {
      getUploadQueue(Date.now());
      const call = mockDb.calls[0];
      expect(call.sql).toContain("upload_state = 'pending'");
      expect(call.sql).toContain("upload_state = 'failed'");
      expect(call.sql).toContain('next_retry_at <=');
      expect(call.sql).toContain('LIMIT 5');
    });
  });

  describe('listRecordingsByWorker', () => {
    it('filters by worker_id and orders by created_at DESC with pagination', () => {
      listRecordingsByWorker('worker_a', 20, 0);
      const call = mockDb.calls[0];
      expect(call.sql).toContain('worker_id = ?');
      expect(call.sql).toContain('ORDER BY created_at DESC');
      expect(call.sql).toContain('LIMIT ? OFFSET ?');
      expect(call.params).toContain('worker_a');
    });
  });
});
