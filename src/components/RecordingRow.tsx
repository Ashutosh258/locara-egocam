import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import type { Recording } from '../types';

interface Props {
  item: Recording;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
}

const STATE_COLOR: Record<Recording['upload_state'], string> = {
  pending:   '#f59e0b',
  uploading: '#3b82f6',
  uploaded:  '#22c55e',
  failed:    '#ef4444',
};

const STATE_LABEL: Record<Recording['upload_state'], string> = {
  pending:   'Pending',
  uploading: 'Uploading',
  uploaded:  'Uploaded',
  failed:    'Failed',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function RecordingRow({ item, onRetry, onDelete }: Props) {
  const date = new Date(item.created_at).toLocaleString();

  function handleDelete() {
    Alert.alert(
      'Delete local file?',
      'The upload record is kept. The local file will be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onDelete(item.id) },
      ],
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: STATE_COLOR[item.upload_state] }]}>
          <Text style={styles.badgeText}>{STATE_LABEL[item.upload_state]}</Text>
        </View>
        <Text style={styles.date}>{date}</Text>
      </View>

      <View style={styles.meta}>
        <Text style={styles.metaText}>{formatDuration(item.duration_ms)}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.metaText}>{formatBytes(item.file_size_bytes)}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.metaText}>{item.fps_tier.toUpperCase()}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.metaText}>{item.resolution}</Text>
      </View>

      {item.last_error ? (
        <Text style={styles.error} numberOfLines={1}>
          {item.last_error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {item.upload_state === 'failed' && (
          <TouchableOpacity style={styles.actionBtn} onPress={() => onRetry(item.id)}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        )}
        {item.upload_state !== 'uploading' && item.local_path !== '' && (
          <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} onPress={handleDelete}>
            <Text style={styles.deleteText}>Delete file</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  badge: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  date: { color: '#666', fontSize: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  metaText: { color: '#aaa', fontSize: 13 },
  dot: { color: '#444', fontSize: 13 },
  error: { color: '#ef4444', fontSize: 12, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#2563eb',
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  deleteBtn: { backgroundColor: '#3f3f3f' },
  deleteText: { color: '#ccc', fontSize: 13 },
});
