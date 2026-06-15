import type { UploadState } from '../types';

// Explicit transition table. Any attempted transition not listed here is a
// programming error — fail loudly in development, log silently in production.
const ALLOWED: Record<UploadState, UploadState[]> = {
  pending:   ['uploading'],
  uploading: ['uploaded', 'failed'],
  uploaded:  [],          // terminal — once confirmed, never reverts
  failed:    ['pending'], // re-queued by manual retry or scheduler
};

export function isTransitionAllowed(from: UploadState, to: UploadState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: UploadState, to: UploadState): void {
  if (!isTransitionAllowed(from, to)) {
    throw new Error(`Invalid upload state transition: ${from} → ${to}`);
  }
}

// Guard used before writing to DB. Returns false (rather than throwing) in
// contexts where silent rejection is safer than crashing (e.g. scheduler loop).
export function canTransition(from: UploadState, to: UploadState): boolean {
  return isTransitionAllowed(from, to);
}
