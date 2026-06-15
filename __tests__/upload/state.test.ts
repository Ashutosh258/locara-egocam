import { isTransitionAllowed, assertTransition, canTransition } from '../../src/upload/state';
import type { UploadState } from '../../src/types';

describe('upload state machine', () => {
  describe('allowed transitions', () => {
    it('pending → uploading', () => {
      expect(isTransitionAllowed('pending', 'uploading')).toBe(true);
    });

    it('uploading → uploaded', () => {
      expect(isTransitionAllowed('uploading', 'uploaded')).toBe(true);
    });

    it('uploading → failed', () => {
      expect(isTransitionAllowed('uploading', 'failed')).toBe(true);
    });

    it('failed → pending (manual re-queue)', () => {
      expect(isTransitionAllowed('failed', 'pending')).toBe(true);
    });
  });

  describe('forbidden transitions', () => {
    const cases: Array<[UploadState, UploadState]> = [
      ['uploaded', 'pending'],
      ['uploaded', 'uploading'],
      ['uploaded', 'failed'],
      ['pending', 'uploaded'],
      ['pending', 'failed'],
      ['failed', 'uploaded'],
      ['failed', 'uploading'],
    ];

    it.each(cases)('%s → %s is forbidden', (from, to) => {
      expect(isTransitionAllowed(from, to)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('throws on invalid transition', () => {
      expect(() => assertTransition('uploaded', 'pending')).toThrow(
        'Invalid upload state transition: uploaded → pending',
      );
    });

    it('does not throw on valid transition', () => {
      expect(() => assertTransition('pending', 'uploading')).not.toThrow();
    });
  });

  describe('canTransition', () => {
    it('returns false without throwing', () => {
      expect(canTransition('uploaded', 'failed')).toBe(false);
    });
  });

  it('uploaded is a terminal state — no outgoing transitions exist', () => {
    const states: UploadState[] = ['pending', 'uploading', 'uploaded', 'failed'];
    for (const target of states) {
      expect(isTransitionAllowed('uploaded', target)).toBe(false);
    }
  });
});
