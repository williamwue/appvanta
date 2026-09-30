import { inspectDeviceLock } from '../packages/core/dist/index.js';

export async function inspectStartingDeviceLease(deviceId, directory) {
  try {
    const state = await inspectDeviceLock(deviceId, directory);
    return state ? { status: 'ready', state } : { status: 'absent' };
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'incomplete' };
    throw error;
  }
}
