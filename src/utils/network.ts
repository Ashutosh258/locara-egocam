import NetInfo from '@react-native-community/netinfo';
import type { RecordingMetadata } from '../types';

export async function isNetworkAvailable(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return state.isConnected === true && state.isInternetReachable !== false;
}

export async function currentNetworkType(): Promise<RecordingMetadata['network_type']> {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return 'none';
  if (state.type === 'wifi') return 'wifi';
  if (state.type === 'cellular') return 'cellular';
  return 'none';
}
