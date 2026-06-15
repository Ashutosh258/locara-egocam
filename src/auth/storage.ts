import * as Keychain from 'react-native-keychain';
import type { Session } from '../types';

const SERVICE = 'com.locara.egocam.session';

// react-native-keychain writes to Android Keystore on API 23+ —
// the token is hardware-backed and never leaves the secure element in plaintext.
// This is strictly stronger than AsyncStorage + manual encryption.

export async function saveSession(session: Session): Promise<void> {
  await Keychain.setGenericPassword(
    session.worker_id,
    JSON.stringify(session),
    { service: SERVICE, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
}

export async function loadSession(): Promise<Session | null> {
  const result = await Keychain.getGenericPassword({ service: SERVICE });
  if (!result) return null;

  try {
    return JSON.parse(result.password) as Session;
  } catch {
    // Corrupted credential — wipe and force re-login.
    await clearSession();
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
