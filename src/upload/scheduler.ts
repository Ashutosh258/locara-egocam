import { AppState, AppStateStatus } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { drainQueue } from './queue';

// Poll interval when the app is foregrounded.
// 30 seconds is a balance: frequent enough to clear the queue quickly,
// infrequent enough to avoid unnecessary battery drain.
const POLL_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let netInfoSubscription: (() => void) | null = null;
let currentToken: string | null = null;

function tick(): void {
  if (!currentToken) return;
  drainQueue(currentToken).catch(() => {
    // drainQueue is best-effort. Individual upload failures are recorded in
    // the DB by uploadOne; we don't surface them here to avoid error loops.
  });
}

function handleAppState(nextState: AppStateStatus): void {
  if (nextState === 'active') {
    tick();
  }
}

function handleNetChange(state: NetInfoState): void {
  if (state.isConnected) {
    // Network just came back — kick the queue immediately rather than
    // waiting for the next poll interval.
    tick();
  }
}

export function startScheduler(token: string): void {
  if (intervalId) return; // already running

  currentToken = token;

  tick(); // flush anything that accumulated while the app was closed
  intervalId = setInterval(tick, POLL_INTERVAL_MS);

  appStateSubscription = AppState.addEventListener('change', handleAppState);
  netInfoSubscription = NetInfo.addEventListener(handleNetChange);
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  appStateSubscription?.remove();
  appStateSubscription = null;
  netInfoSubscription?.();
  netInfoSubscription = null;
  currentToken = null;
}

export function updateToken(token: string): void {
  currentToken = token;
}
