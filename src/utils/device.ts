import DeviceInfo from 'react-native-device-info';
import type { FpsTier } from '../types';

export function fpsTier(fps: number): FpsTier {
  if (fps < 20) return 'low';
  if (fps <= 30) return 'standard';
  return 'high';
}

export async function getDeviceModel(): Promise<string> {
  return DeviceInfo.getModel();
}

export async function getOsVersion(): Promise<string> {
  return DeviceInfo.getSystemVersion();
}

export async function getBatteryLevel(): Promise<number> {
  // Returns 0–1; we store as 0–100 integer.
  const level = await DeviceInfo.getBatteryLevel();
  return Math.round(level * 100);
}
