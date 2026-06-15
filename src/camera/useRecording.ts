import { useRef, useState, useCallback, useEffect } from 'react';
import { Camera, VideoFile } from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import uuid from 'react-native-uuid';
import { insertRecording } from '../db/recordings';
import { buildRecordingRow } from './metadata';
import { getBatteryLevel } from '../utils/device';

export const MAX_DURATION_SECONDS = 60;

interface RecordingState {
  isRecording: boolean;
  elapsedSeconds: number;
  cameraPosition: 'front' | 'back';
  error: string | null;
}

interface RecordingControls {
  state: RecordingState;
  cameraRef: React.RefObject<Camera>;
  startRecording: () => void;
  stopRecording: () => void;
  toggleCamera: () => void;
}

export function useRecording(workerId: string): RecordingControls {
  const cameraRef = useRef<Camera>(null);
  const startTimeRef = useRef<Date | null>(null);
  const videoIdRef = useRef<string>('');
  const batteryStartRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cameraPosition, setCameraPosition] = useState<'front' | 'back'>('back');
  const [error, setError] = useState<string | null>(null);

  // Auto-stop at max duration.
  useEffect(() => {
    if (isRecording && elapsedSeconds >= MAX_DURATION_SECONDS) {
      stopRecording();
    }
  }, [isRecording, elapsedSeconds]);

  const startTimer = useCallback(() => {
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1_000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || isRecording) return;
    setError(null);

    try {
      const battery = await getBatteryLevel();
      batteryStartRef.current = battery;
      videoIdRef.current = uuid.v4() as string;
      startTimeRef.current = new Date();

      cameraRef.current.startRecording({
        onRecordingFinished: (file: VideoFile) => {
          handleRecordingFinished(file).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'Save failed');
          });
        },
        onRecordingError: (err) => {
          stopTimer();
          setIsRecording(false);
          setError(err.message);
        },
      });

      setIsRecording(true);
      startTimer();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording');
    }
  }, [isRecording, startTimer, stopTimer]);

  const stopRecording = useCallback(() => {
    if (!cameraRef.current || !isRecording) return;
    stopTimer();
    setIsRecording(false);
    cameraRef.current.stopRecording();
  }, [isRecording, stopTimer]);

  const handleRecordingFinished = useCallback(
    async (file: VideoFile) => {
      const endedAt = new Date();
      const startedAt = startTimeRef.current ?? endedAt;

      // Move the temp file to a stable app-owned directory.
      // Vision Camera writes to a temp path that may be cleaned up by the OS.
      const destDir = `${RNFS.DocumentDirectoryPath}/recordings`;
      await RNFS.mkdir(destDir);
      const destPath = `${destDir}/${videoIdRef.current}.mp4`;
      await RNFS.moveFile(file.path, destPath);

      const row = await buildRecordingRow({
        videoId: videoIdRef.current,
        workerId,
        startedAt,
        endedAt,
        localPath: destPath,
        fps: file.duration > 0 ? 30 : 0, // Vision Camera doesn't expose fps; default 30
        resolution: `${file.width ?? 0}x${file.height ?? 0}`,
        gps: undefined, // GPS permission is opt-in; hook caller can pass it in
        batteryStart: batteryStartRef.current,
      });

      insertRecording(row);
    },
    [workerId],
  );

  const toggleCamera = useCallback(() => {
    if (isRecording) return; // don't switch mid-recording
    setCameraPosition((prev) => (prev === 'back' ? 'front' : 'back'));
  }, [isRecording]);

  return {
    state: { isRecording, elapsedSeconds, cameraPosition, error },
    cameraRef,
    startRecording,
    stopRecording,
    toggleCamera,
  };
}
