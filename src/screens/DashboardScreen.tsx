import React, { useState, useCallback } from 'react';
import {
  View,
  FlatList,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import RNFS from 'react-native-fs';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSessionStore } from '../store/session';
import { listRecordingsByWorker, requeueFailed, clearLocalFile } from '../db/recordings';
import RecordingRow from '../components/RecordingRow';
import type { Recording } from '../types';

const PAGE_SIZE = 20;

export default function DashboardScreen() {
  const navigation = useNavigation();
  const session = useSessionStore((s) => s.session);
  const logout = useSessionStore((s) => s.logout);

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(
    (pageIndex: number, replace = false) => {
      if (!session) return;
      setLoading(true);
      const rows = listRecordingsByWorker(session.worker_id, PAGE_SIZE, pageIndex * PAGE_SIZE);
      setRecordings((prev) => (replace ? rows : [...prev, ...rows]));
      setHasMore(rows.length === PAGE_SIZE);
      setLoading(false);
    },
    [session],
  );

  // Reload whenever the screen comes into focus so newly captured videos appear.
  useFocusEffect(
    useCallback(() => {
      setPage(0);
      loadPage(0, true);
    }, [loadPage]),
  );

  function loadMore() {
    if (!hasMore || loading) return;
    const nextPage = page + 1;
    setPage(nextPage);
    loadPage(nextPage);
  }

  function handleRetry(id: string) {
    const ok = requeueFailed(id);
    if (ok) {
      // Optimistic update — reflect the state change immediately.
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, upload_state: 'pending', last_error: null } : r,
        ),
      );
    }
  }

  async function handleDelete(id: string) {
    const rec = recordings.find((r) => r.id === id);
    if (!rec) return;

    if (rec.local_path) {
      try {
        const exists = await RNFS.exists(rec.local_path);
        if (exists) await RNFS.unlink(rec.local_path);
      } catch {
        Alert.alert('Could not delete file', 'It may have already been removed.');
      }
    }

    clearLocalFile(id);
    setRecordings((prev) =>
      prev.map((r) => (r.id === id ? { ...r, local_path: '' } : r)),
    );
  }

  async function handleLogout() {
    Alert.alert('Sign out?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await logout();
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>← Camera</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Recordings</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={recordings}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RecordingRow item={item} onRetry={handleRetry} onDelete={handleDelete} />
        )}
        contentContainerStyle={styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>No recordings yet. Go capture something.</Text>
          ) : null
        }
        ListFooterComponent={
          loading ? <ActivityIndicator color="#2563eb" style={styles.spinner} /> : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  back: { color: '#2563eb', fontSize: 15 },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  logout: { color: '#ef4444', fontSize: 15 },
  list: { padding: 12 },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 15 },
  spinner: { paddingVertical: 16 },
});
