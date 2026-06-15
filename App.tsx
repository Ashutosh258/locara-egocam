import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initDb } from './src/db/client';
import { recoverInterruptedUploads } from './src/upload/queue';
import { startScheduler, stopScheduler } from './src/upload/scheduler';
import { useSessionStore } from './src/store/session';
import Navigation from './src/navigation';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000 },
  },
});

function AppInner() {
  const session = useSessionStore((s) => s.session);
  const restore = useSessionStore((s) => s.restore);

  useEffect(() => {
    (async () => {
      await initDb();
      // Reset any uploads that were in-flight when the process was killed.
      // Must run before the scheduler starts, otherwise the scheduler would
      // see 'uploading' rows and skip them (claimForUpload returns false).
      recoverInterruptedUploads();
      await restore();
    })();
  }, [restore]);

  useEffect(() => {
    if (session) {
      startScheduler(session.token);
    } else {
      stopScheduler();
    }
    return () => stopScheduler();
  }, [session]);

  return <Navigation />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <AppInner />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
