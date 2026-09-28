import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock, type DeviceId } from '@appvanta/core';

const exec = promisify(execFile);
const component = 'dev.appvanta.input/.InputService';
const clipboardReceiver = 'dev.appvanta.input/.ClipboardReceiver';
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Installed helper is explicit; never download or install an APK implicitly. */
export async function inputWithIme(adb: string, device: DeviceId, text: string, focus: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > 24000 || Buffer.from(text, 'utf8').toString('utf8') !== text || text.includes('\0')) throw new Error('Input must be valid Unicode without NUL, at most 24000 UTF-8 bytes');
  await withDeviceLock(device, async () => {
    const shell = async (args: string[], cleanup = false) => {
      const result = await exec(adb, ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000, ...(!cleanup && signal ? { signal } : {}) });
      if (/Exception|Error:/i.test(result.stdout)) throw new Error(`Input bridge command failed: ${result.stdout.trim()}`);
      return result.stdout.trim();
    };
    const previous = await shell(['settings', 'get', 'secure', 'default_input_method']);
    if (!/^[\w.]+\/[\w.$]+$/.test(previous)) throw new Error('Cannot safely restore the current input method');
    const available = await shell(['ime', 'list', '-a', '-s']);
    if (!available.split(/\r?\n/).includes(component)) throw new Error('Install the AppVanta input helper first; see docs/input.md');
    const enabled = (await shell(['ime', 'list', '-s'])).split(/\r?\n/).includes(component);
    let primary: unknown;
    try {
      await shell(['ime', 'enable', component]);
      await shell(['ime', 'set', component]);
      if (await shell(['settings', 'get', 'secure', 'default_input_method']) !== component) throw new Error('Input method switch was rejected');
      await focus();
      const foreground = await shell(['dumpsys', 'activity', 'activities']);
      const expected = /(?:topResumedActivity|ResumedActivity)=ActivityRecord\{[^}]*\s([A-Za-z0-9_.$]+)\/[^\s}]+/.exec(foreground)?.[1];
      if (!expected) throw new Error('Cannot determine input target package');
      const broadcast = (action: string, extra: string[] = []) => shell(['am', 'broadcast', '-a', `dev.appvanta.input.${action}`, '-p', 'dev.appvanta.input', '--es', 'expectedPackage', quote(expected), ...extra]);
      const deadline = Date.now() + 5000;
      while (!/result=1\b/.test(await broadcast('READY'))) {
        if (Date.now() >= deadline) throw new Error('Input helper has no matching editor');
        await delay(100, undefined, signal ? { signal } : {});
      }
      // Never retry COMMIT: a lost acknowledgement could otherwise duplicate input.
      const result = await broadcast('COMMIT', ['--es', 'text64', quote(Buffer.from(text, 'utf8').toString('base64'))]);
      if (!/result=1\b/.test(result)) throw new Error(`Input was not acknowledged: ${result}`);
    } catch (error) { primary = error; throw error; }
    finally {
      try {
        await shell(['ime', 'set', quote(previous)], true);
        if (!enabled) await shell(['ime', 'disable', component], true);
        if (await shell(['settings', 'get', 'secure', 'default_input_method'], true) !== previous) throw new Error('Original input method was not restored');
      } catch (cleanup) { throw new AggregateError(primary ? [primary, cleanup] : [cleanup], 'Input method cleanup failed'); }
    }
  });
}

export async function setClipboardWithHelper(adb: string, device: DeviceId, text: string, signal?: AbortSignal): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > 24000 || Buffer.from(text, 'utf8').toString('utf8') !== text || text.includes('\0')) throw new Error('Clipboard text must be valid Unicode without NUL, at most 24000 UTF-8 bytes');
  const installed = await exec(adb, ['-s', device, 'shell', 'pm', 'path', 'dev.appvanta.input'], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
  if (!installed.stdout.trim().split(/\r?\n/).some(line => line.startsWith('package:/'))) throw new Error('Install the AppVanta input helper first; see docs/input.md');
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const result = await exec(adb, ['-s', device, 'shell', 'am', 'broadcast', '-n', clipboardReceiver, '-a', 'dev.appvanta.input.SET_CLIPBOARD', '--es', 'text64', quote(payload)], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
  if (!/result=1\b/.test(result.stdout)) throw new Error(`Clipboard update was not acknowledged: ${result.stdout.trim()}`);
}

export async function pasteWithHelper(adb: string, device: DeviceId, signal?: AbortSignal): Promise<void> {
  const run = (args: string[]) => exec(adb, ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
  const installed = await run(['pm', 'path', 'dev.appvanta.input']);
  if (!installed.stdout.trim().split(/\r?\n/).some(line => line.startsWith('package:/'))) throw new Error('Install the AppVanta input helper first; see docs/input.md');
  const enabled = (await run(['settings', 'get', 'secure', 'enabled_accessibility_services'])).stdout.trim();
  const component = 'dev.appvanta.input/dev.appvanta.input.GestureService';
  if (!enabled.split(':').some(value => value === component || value === 'dev.appvanta.input/.GestureService')) throw new Error('Enable the AppVanta Gesture Service in Android Accessibility settings');
  const result = await run(['am', 'broadcast', '-a', 'dev.appvanta.input.PASTE', '-p', 'dev.appvanta.input']);
  if (!/result=1\b/.test(result.stdout)) throw new Error(`Paste was not acknowledged: ${result.stdout.trim()}`);
}
