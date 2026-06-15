import { create } from 'zustand';
import type { Session } from '../types';
import { saveSession, loadSession, clearSession } from '../auth/storage';

interface SessionState {
  session: Session | null;
  hydrated: boolean;
  login: (email: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
}

// Mock auth: any email + 4-digit PIN generates a deterministic worker_id.
// In production, this would be a real API call returning a signed JWT.
function mockAuthenticate(email: string, _pin: string): Session {
  const worker_id = `worker_${email.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
  return {
    worker_id,
    email,
    token: `mock_token_${worker_id}_${Date.now()}`,
  };
}

export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  hydrated: false,

  login: async (email, pin) => {
    const session = mockAuthenticate(email, pin);
    await saveSession(session);
    set({ session });
  },

  logout: async () => {
    await clearSession();
    set({ session: null });
  },

  restore: async () => {
    const session = await loadSession();
    set({ session, hydrated: true });
  },
}));
