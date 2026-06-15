import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import { useSessionStore } from '../store/session';
import { useRecording, MAX_DURATION_SECONDS } from '../camera/useRecording';

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function CameraScreen() {
  const navigation = useNavigation();
  const session = useSessionStore((s) => s.session);
  const { hasPermission, requestPermission } = useCameraPermission();
  const { state, cameraRef, startRecording, stopRecording, toggleCamera } =
    useRecording(session?.worker_id ?? '');

  const device = useCameraDevice(state.cameraPosition);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    if (state.error) {
      Alert.alert('Recording error', state.error);
    }
  }, [state.error]);

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>Camera permission required</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>No camera found</Text>
      </View>
    );
  }

  const remaining = MAX_DURATION_SECONDS - state.elapsedSeconds;
  const nearLimit = remaining <= 10;

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        video
        audio
      />

      {/* Timer overlay */}
      {state.isRecording && (
        <View style={styles.timerRow}>
          <View style={styles.recordingDot} />
          <Text style={[styles.timer, nearLimit && styles.timerWarning]}>
            {formatElapsed(state.elapsedSeconds)}
          </Text>
          <Text style={[styles.remaining, nearLimit && styles.timerWarning]}>
            -{formatElapsed(remaining)}
          </Text>
        </View>
      )}

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.sideButton}
          onPress={() => navigation.navigate('Dashboard' as never)}
        >
          <Text style={styles.sideButtonText}>≡</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.recordButton, state.isRecording && styles.recordButtonActive]}
          onPress={state.isRecording ? stopRecording : startRecording}
        >
          <View style={state.isRecording ? styles.stopIcon : styles.recordIcon} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.sideButton}
          onPress={toggleCamera}
          disabled={state.isRecording}
        >
          <Text style={styles.sideButtonText}>⇄</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  message: { color: '#fff', fontSize: 16 },

  timerRow: {
    position: 'absolute',
    top: 48,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 8,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
  timer: { color: '#fff', fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  remaining: { color: '#aaa', fontSize: 14, fontVariant: ['tabular-nums'] },
  timerWarning: { color: '#f97316' },

  controls: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
  },
  sideButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideButtonText: { color: '#fff', fontSize: 22 },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  recordButtonActive: { borderColor: '#ef4444' },
  recordIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#ef4444',
  },
  stopIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
});
