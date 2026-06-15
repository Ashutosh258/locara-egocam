import { recoverInterruptedUploads } from '../../src/upload/queue';
import * as recordingsDb from '../../src/db/recordings';

jest.mock('../../src/db/recordings', () => ({
  resetStaleUploading: jest.fn(),
  getUploadQueue: jest.fn(() => []),
  claimForUpload: jest.fn(() => true),
  markUploaded: jest.fn(),
  markFailed: jest.fn(),
  updateMetadataField: jest.fn(),
}));

jest.mock('../../src/upload/engine', () => ({
  uploadOne: jest.fn(() => Promise.resolve({ status: 'uploaded', s3_key: 'workers/w/v.mp4' })),
}));

describe('upload queue', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('recoverInterruptedUploads', () => {
    it('resets stale uploading records on startup', () => {
      recoverInterruptedUploads();
      expect(recordingsDb.resetStaleUploading).toHaveBeenCalledTimes(1);
    });
  });

  describe('drainQueue', () => {
    it('does not call uploadOne when queue is empty', async () => {
      const { drainQueue } = await import('../../src/upload/queue');
      const { uploadOne } = await import('../../src/upload/engine');
      (recordingsDb.getUploadQueue as jest.Mock).mockReturnValue([]);
      await drainQueue('token');
      expect(uploadOne).not.toHaveBeenCalled();
    });

    it('processes each queue entry', async () => {
      // Reset module-level draining flag between tests
      jest.resetModules();
      const entries = [
        { id: '1', worker_id: 'w1', local_path: '/a.mp4', attempt_count: 0, s3_key: null },
        { id: '2', worker_id: 'w1', local_path: '/b.mp4', attempt_count: 1, s3_key: null },
      ];
      jest.mock('../../src/db/recordings', () => ({
        ...jest.requireMock('../../src/db/recordings'),
        getUploadQueue: jest.fn(() => entries),
      }));

      const uploadOneMock = jest.fn(() =>
        Promise.resolve({ status: 'uploaded', s3_key: 'k' }),
      );
      jest.mock('../../src/upload/engine', () => ({ uploadOne: uploadOneMock }));

      const { drainQueue: freshDrain } = await import('../../src/upload/queue');
      await freshDrain('token');

      expect(uploadOneMock).toHaveBeenCalledTimes(2);
    });

    it('does not run concurrently — second call is a no-op while first is running', async () => {
      jest.resetModules();
      let resolveFirst!: () => void;
      const slowUpload = new Promise<void>((res) => { resolveFirst = res; });

      jest.mock('../../src/upload/engine', () => ({
        uploadOne: jest.fn(() => slowUpload.then(() => ({ status: 'uploaded', s3_key: '' }))),
      }));
      jest.mock('../../src/db/recordings', () => ({
        ...jest.requireMock('../../src/db/recordings'),
        getUploadQueue: jest.fn(() => [
          { id: '1', worker_id: 'w', local_path: '/x.mp4', attempt_count: 0, s3_key: null },
        ]),
      }));

      const { drainQueue: freshDrain } = await import('../../src/upload/queue');
      const { uploadOne } = await import('../../src/upload/engine');

      const first = freshDrain('t');
      const second = freshDrain('t'); // should be silently skipped

      resolveFirst();
      await Promise.all([first, second]);

      // uploadOne called once, not twice
      expect(uploadOne).toHaveBeenCalledTimes(1);
    });
  });
});
