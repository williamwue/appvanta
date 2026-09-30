import { captureArtifact } from './capture.js';
import { textShareArguments } from './text-share.js';
import { fileShareArguments } from './file-share.js';
import { shareFiles } from './multi-file-share.js';
import { shakeEmulator } from './emulator-sensors.js';
import { matchAnrStack } from './anr-stacks.js';
import { parseRuntimeIncidents } from './runtime-diagnostics.js';
import { createHash, randomUUID } from 'node:crypto';
import { parseMemoryMetrics } from './memory-metrics.js';
import { comparePngScreenshots, findPngMatches, parsePerformanceDocument } from '@appvanta/core';
import { inputWithIme, pasteWithHelper, setClipboardWithHelper } from "./input.js";
import { dispatchGestureWithHelper } from './gestures.js';
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import type { Condition, Target, Action, ActionResult, AppArtifact, AppPackageName, Device, DeviceDriver, DeviceId, HardwareButton, LogArtifact, Observation, Orientation } from "@appvanta/core";
import { brand } from "@appvanta/core";
import { center, findNode, findNodes, parseUiTree } from "./locator.js";
import type { UiTree } from './locator.js';

const execFileAsync = promisify(execFile);
const keyCodes: Record<HardwareButton, number> = { home: 3, back: 4, power: 26, 'volume-up': 24, 'volume-down': 25, mute: 164, 'app-switch': 187, enter: 66, menu: 82, 'dpad-up': 19, 'dpad-down': 20, 'dpad-left': 21, 'dpad-right': 22, 'dpad-center': 23 };
const rotations: Record<Orientation, number> = { portrait: 0, 'landscape-left': 1, 'portrait-upside-down': 2, 'landscape-right': 3 };

export const androidKeyCode = (button: HardwareButton): number => keyCodes[button];
export const androidRotation = (orientation: Orientation): number => rotations[orientation];

export interface AdbDriverOptions {
  readonly adbPath?: string;
  readonly artifactsDirectory: string;
  readonly signal?: AbortSignal;
  readonly sensorRecoveryDirectory?: string;
}

export type PermissionState = "allow" | "deny" | "foreground" | "default" | "unknown";
export interface RuntimeDiagnostics { readonly foregroundPackage?: string; readonly processId?: string; readonly crashCount: number; readonly anrCount: number; readonly logPath: string; readonly eventsPath: string; readonly diagnosticsPath: string; readonly sinceMs: number; readonly malformedEvents: number }

interface AdbDeviceLine { readonly id: DeviceId; readonly status: Device["status"]; readonly model?: string }

export class AdbDriver implements DeviceDriver {
  public async openUrl(deviceId: DeviceId, value: string): Promise<void> {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
    const quoted = "'" + url.href.replaceAll("'", "'\"'\"'") + "'";
    await this.run(["-s", deviceId, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", quoted]);
  }
  public readonly name = "android-adb";
  private readonly adbPath: string;
  private readonly artifactsDirectory: string;
  private readonly signal: AbortSignal | undefined;
  private readonly sensorRecoveryDirectory: string | undefined;

  public constructor(options: AdbDriverOptions) {
    this.adbPath = options.adbPath ?? "adb";
    this.artifactsDirectory = options.artifactsDirectory;
    this.signal = options.signal;
    this.sensorRecoveryDirectory = options.sensorRecoveryDirectory;
  }

  public async listDevices(): Promise<readonly Device[]> {
    const output = await this.run(["devices", "-l"]);
    return output.split(/\r?\n/).slice(1).map(parseDeviceLine).filter((device): device is AdbDeviceLine => device !== undefined).map((device) => ({
      id: device.id,
      platform: "android",
      kind: device.id.startsWith("emulator-") ? "emulator" : "physical",
      status: device.status,
      name: device.model ?? device.id,
      ...(device.model ? { model: device.model } : {}),
      capabilities: ["screenshot", "ui-tree", "logcat", "input", "apk-install", "hardware-buttons", "orientation"],
    }));
  }

  public async deviceEnvironment(deviceId: DeviceId): Promise<{ model: string; osVersion: string }> {
    const [model, osVersion] = await Promise.all([
      this.run(['-s', deviceId, 'shell', 'getprop', 'ro.product.model']),
      this.run(['-s', deviceId, 'shell', 'getprop', 'ro.build.fingerprint']),
    ]);
    if (!model.trim() || !osVersion.trim()) throw new Error('Incomplete device environment');
    return { model: model.trim(), osVersion: osVersion.trim() };
  }

  public async applicationIdentity(deviceId: DeviceId, packageName: string) {
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid package name');
    const installed = await this.run(['-s', deviceId, 'shell', 'pm', 'list', 'packages', packageName]);
    if (!installed.split(/\r?\n/).some(line => line.trim() === `package:${packageName}`)) return { packageName, installed: false, apks: [] };
    const output = await this.run(['-s', deviceId, 'shell', 'pm', 'path', packageName]);
    const paths = output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      if (!line.startsWith('package:/')) throw new Error(`Unexpected package path: ${line}`);
      return line.slice(8);
    });
    const apks = [];
    for (const path of paths) {
      const quoted = "'" + path.replaceAll("'", "'\"'\"'") + "'";
      const hash = (await this.run(['-s', deviceId, 'shell', 'sha256sum', quoted], 120000)).split(/\s+/)[0]!;
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Unable to hash installed APK');
      apks.push({ name: path.split('/').at(-1)!, sha256: hash });
    }
    apks.sort((a, b) => a.name.localeCompare(b.name));
    return { packageName, installed: paths.length > 0, apks };
  }

  public async install(deviceId: DeviceId, artifact: AppArtifact): Promise<void> {
    await this.run(["-s", deviceId, "install", "-r", artifact.path]);
  }

  public async launch(deviceId: DeviceId, packageName: AppPackageName): Promise<void> {
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid package name');
    const resolved = await this.run(['-s', deviceId, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', packageName]);
    const component = resolved.trim().split(/\r?\n/).at(-1);
    if (!component || !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(component)) throw new Error(`Launcher Activity not found: ${packageName}`);
    const quoted = "'" + component + "'";
    const output = await this.run(['-s', deviceId, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-n', quoted]);
    if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(output)) throw new Error(`Launch failed: ${output.trim()}`);
  }

  public async uninstall(deviceId: DeviceId, packageName: AppPackageName): Promise<void> {
    await this.run(["-s", deviceId, "uninstall", packageName]);
  }

  public async stopApp(deviceId: DeviceId, packageName: AppPackageName): Promise<void> {
    await this.run(["-s", deviceId, "shell", "am", "force-stop", packageName]);
  }

  public async clearAppData(deviceId: DeviceId, packageName: AppPackageName): Promise<void> {
    await this.run(["-s", deviceId, "shell", "pm", "clear", packageName]);
  }

  public async getForegroundPackage(deviceId: DeviceId): Promise<string | undefined> {
    const output = await this.run(["-s", deviceId, "shell", "dumpsys", "activity", "activities"]);
    const match = /(?:topResumedActivity|ResumedActivity)=ActivityRecord\{[^}]*\s([A-Za-z0-9_.$]+)\/[^\s}]+/.exec(output);
    return match?.[1];
  }

  public async getPermissionState(deviceId: DeviceId, packageName: AppPackageName, permission: string): Promise<PermissionState> {
    const output = await this.run(["-s", deviceId, "shell", "appops", "get", packageName, permission]);
    const state = /(?:allow|deny|foreground|default)/i.exec(output)?.[0]?.toLowerCase();
    return state === "allow" || state === "deny" || state === "foreground" || state === "default" ? state : "unknown";
  }

  public async setPermissionState(deviceId: DeviceId, packageName: AppPackageName, permission: string, state: "allow" | "deny"): Promise<void> {
    await this.run(["-s", deviceId, "shell", "appops", "set", packageName, permission, state]);
  }

  public async observe(deviceId: DeviceId): Promise<Observation> {
    this.signal?.throwIfAborted();
    await mkdir(this.artifactsDirectory, { recursive: true });
    const observationId = `${Date.now()}-${randomUUID()}`;
    const observationAttemptsPath = join(this.artifactsDirectory, `observation-${observationId}.json`);
    const attempts: Array<{ index: number; screenshotPath: string; uiTreePath: string; status: string; error?: string }> = [];
    for (let index = 1; index <= 3; index++) {
      this.signal?.throwIfAborted();
      const suffix = `${observationId}-${index}`;
      const screenshotPath = join(this.artifactsDirectory, `screenshot-${suffix}.png`);
      const uiTreePath = join(this.artifactsDirectory, `ui-${suffix}.xml`);
      const screenshot = await this.runBinary(["-s", deviceId, "exec-out", "screencap", "-p"]);
      await writeFile(screenshotPath, screenshot);
      const uiTree = await this.run(["-s", deviceId, "exec-out", "uiautomator", "dump", "/dev/tty"]);
      await writeFile(uiTreePath, uiTree, "utf8");
      const attempt = { index, screenshotPath, uiTreePath, status: 'captured' } as (typeof attempts)[number];
      attempts.push(attempt);
      const saveAttempts = () => writeFile(observationAttemptsPath, JSON.stringify({ version: 1, deviceId, attempts }, null, 2));
      if (uiTree.trim() === 'ERROR: null root node returned by UiTestAutomationBridge.') {
        attempt.status = 'transient-null-root'; await saveAttempts();
        if (index === 3) throw new Error('UI tree unavailable after 3 attempts: null root node');
        await delay(250, undefined, this.signal ? { signal: this.signal } : {});
        continue;
      }
      let tree: UiTree;
      try { tree = parseUiTree(uiTree); }
      catch (error) { attempt.status = 'failed'; attempt.error = String(error); await saveAttempts(); throw error; }
      const uiDescriptionPath = join(this.artifactsDirectory, `ui-${suffix}.json`);
      await writeFile(uiDescriptionPath, JSON.stringify(tree, null, 2), 'utf8');
      attempt.status = 'passed'; await saveAttempts();
      return { capturedAt: new Date().toISOString(), screenshotPath, uiTreePath, uiDescriptionPath, metadata: { deviceId, uiObservationAttempts: String(index), observationAttemptsPath } };
    }
    throw new Error('UI observation attempts exhausted');
  }

  public async execute(deviceId: DeviceId, action: Action): Promise<ActionResult> {
    const startedAt = new Date().toISOString();
    switch (action.kind) {
      case 'shake': {
        if (!this.sensorRecoveryDirectory) throw new Error('shake requires a managed Android Flow; use run_flow');
        await shakeEmulator(this.adbPath, deviceId, this.sensorRecoveryDirectory, action, this.signal);
        break;
      }
      case "tap": {
        const point = await this.resolvePoint(deviceId, action.target);
        await this.run(["-s", deviceId, "shell", "input", "tap", `${point.x}`, `${point.y}`]);
        break;
      }
      case "long-press": {
        const point = await this.resolvePoint(deviceId, action.target);
        await this.run(["-s", deviceId, "shell", "input", "swipe", `${point.x}`, `${point.y}`, `${point.x}`, `${point.y}`, `${action.durationMs}`]);
        break;
      }
      case "input": {
        if (!/^[\x20-\x7e]*$/.test(action.text) || action.text.includes("%s")) {
          await inputWithIme(this.adbPath, deviceId, action.text, async () => {
            const point = await this.resolvePoint(deviceId, action.target);
            await this.run(["-s", deviceId, "shell", "input", "tap", `${point.x}`, `${point.y}`]);
          }, this.signal);
          break;
        }
        const point = await this.resolvePoint(deviceId, action.target);
        await this.run(["-s", deviceId, "shell", "input", "tap", `${point.x}`, `${point.y}`]);
        const quotedText = "'" + action.text.replaceAll(" ", "%s").replaceAll("'", "'\"'\"'") + "'";
        await this.run(["-s", deviceId, "shell", "input", "text", quotedText]);
        break;
      }
      case "swipe": await this.run(["-s", deviceId, "shell", "input", "swipe", `${action.from.x}`, `${action.from.y}`, `${action.to.x}`, `${action.to.y}`, `${action.durationMs}`]); break;
      case 'pinch': case 'rotate-gesture': case 'multi-touch': await dispatchGestureWithHelper(this.adbPath, deviceId, action, this.signal); break;
      case "back": await this.run(["-s", deviceId, "shell", "input", "keyevent", "4"]); break;
      case "button": {
        await this.run(["-s", deviceId, "shell", "input", "keyevent", String(androidKeyCode(action.button))]);
        break;
      }
      case 'set-clipboard': await setClipboardWithHelper(this.adbPath, deviceId, action.text, this.signal); break;
      case 'share-text': {
        const output = await this.run(['-s', deviceId, ...textShareArguments(action)]);
        if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(output)) throw new Error(`Text share failed: ${output.trim()}`);
        break;
      }
      case 'share-files': {
        await shareFiles(action, this.artifactsDirectory,
          args => this.run(['-s', deviceId, ...args]),
          async args => (await execFileAsync(this.adbPath, ['-s', deviceId, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 })).stdout);
        break;
      }
      case 'share-file': {
        const output = await this.run(['-s', deviceId, ...fileShareArguments(action)]);
        if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(output)) throw new Error(`Attachment share failed: ${output.trim()}`);
        break;
      }
      case 'paste': {
        const point = await this.resolvePoint(deviceId, action.target);
        await this.run(['-s', deviceId, 'shell', 'input', 'tap', `${point.x}`, `${point.y}`]);
        await delay(150, undefined, this.signal ? { signal: this.signal } : undefined);
        await pasteWithHelper(this.adbPath, deviceId, this.signal);
        break;
      }
      case "rotate": {
        await this.run(["-s", deviceId, "shell", "cmd", "window", "user-rotation", "lock", String(androidRotation(action.orientation))]);
        break;
      }
      case "restart-app": throw new Error("restart-app requires an app package and is not available on the base Driver");
      case "wait": {
        if (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 1 || action.timeoutMs > 3600000) throw new Error('Invalid wait timeout');
        const expiry = new AbortController();
        const timer = setTimeout(() => expiry.abort(new Error(`Condition timed out: ${JSON.stringify(action.condition)}`)), action.timeoutMs);
        const signal = this.signal ? AbortSignal.any([this.signal, expiry.signal]) : expiry.signal;
        const waiting = new AdbDriver({ adbPath: this.adbPath, artifactsDirectory: this.artifactsDirectory, signal });
        try {
          if (action.condition.kind === 'screen-stable') {
            let baselinePath: string | undefined;
            let stableSince = Date.now();
            while (true) {
              const observation = await waiting.observe(deviceId);
              if (!observation.screenshotPath) throw new Error('Screenshot was not captured');
              const now = Date.now();
              if (!baselinePath) { baselinePath = observation.screenshotPath; stableSince = now; }
              else {
                const prefix = join(this.artifactsDirectory, `stability-${randomUUID()}`);
                const comparison = await comparePngScreenshots(baselinePath, observation.screenshotPath, `${prefix}.png`, {
                  channelThreshold: action.condition.channelThreshold ?? 0,
                  maxMismatchRatio: action.condition.maxMismatchRatio ?? 0,
                  ...(action.condition.ignoreRegions ? { ignoreRegions: action.condition.ignoreRegions } : {}),
                });
                await writeFile(`${prefix}.json`, JSON.stringify({ baselinePath, currentPath: observation.screenshotPath, stableSince, sampledAt: now, comparison }, null, 2));
                signal.throwIfAborted();
                if (comparison.status !== 'passed') { baselinePath = observation.screenshotPath; stableSince = now; }
                else if (now - stableSince >= action.condition.stableMs) break;
              }
              await delay(200, undefined, { signal });
            }
            signal.throwIfAborted();
            break;
          }
          let baseline: UiTree | undefined;
          if (action.condition.kind === 'ui-changed') {
            const initial = await waiting.observe(deviceId);
            baseline = parseUiTree(await readFile(initial.uiTreePath!, 'utf8'));
          }
          while (!await waiting.checkCondition(deviceId, action.condition, undefined, baseline)) {
            await delay(200, undefined, { signal });
          }
          signal.throwIfAborted();
        } catch (error) {
          if (expiry.signal.aborted && !this.signal?.aborted) throw expiry.signal.reason;
          throw error;
        } finally {
          clearTimeout(timer);
        }
        break;
      }
      default: throw new Error("Unsupported action");
    }
    return { success: true, startedAt, finishedAt: new Date().toISOString() };
  }

  public async extractValue(_deviceId: DeviceId, extraction: { target: Target; attribute: 'text' | 'accessibility-label' }, observation: Observation): Promise<string> {
    this.signal?.throwIfAborted();
    if (!observation.uiTreePath) throw new Error('Extraction requires a captured UI tree');
    const node = await findNode(observation.uiTreePath, extraction.target);
    if (node.password) throw new Error('Cannot extract a password field');
    return (extraction.attribute === 'text' ? node.text : node.contentDescription) ?? '';
  }

  public async checkCondition(deviceId: DeviceId, condition: Condition, observation?: Observation, baseline?: UiTree): Promise<boolean> {
    this.signal?.throwIfAborted();
    if (condition.kind === 'app-running') {
      if (!/^[A-Za-z0-9_.]+$/.test(condition.packageName)) throw new Error('Invalid package name');
      const command = `output=$(pidof ${condition.packageName} 2>&1); status=$?; printf '%s\\nAPPVANTA_PIDOF_STATUS=%s\\n' "$output" "$status"`;
      const output = await this.run(['-s', deviceId, 'shell', command]);
      const result = /^([^\r\n]*)\r?\nAPPVANTA_PIDOF_STATUS=(\d+)\r?\n$/.exec(output);
      if (result?.[2] === '1' && result[1] === '') return false;
      if (result?.[2] === '0' && /^[1-9]\d*(?:\s+[1-9]\d*)*$/.test(result[1]!)) return true;
      throw new Error('Unverified application process query result');
    }
    if (condition.kind === 'ui-changed') {
      if (!baseline) throw new Error('ui-changed requires a baseline observation from wait');
      const current = observation ?? await this.observe(deviceId);
      if (!current.uiTreePath) throw new Error('UI tree was not captured');
      return JSON.stringify(parseUiTree(await readFile(current.uiTreePath, 'utf8'))) !== JSON.stringify(baseline);
    }
    if (condition.kind === 'screen-stable') throw new Error('screen-stable is a stateful wait condition');
    const target: Target = condition.kind === 'text-visible' || condition.kind === 'text-absent' ? { kind: 'text', value: condition.text, match: 'contains' } : condition.target;
    if (target.kind === 'coordinate') throw new Error('Condition requires a supported semantic target');
    const current = observation ?? await this.observe(deviceId);
    if (target.kind === 'image-template') {
      if (!current.screenshotPath) throw new Error('Screenshot was not captured');
      const present = (await findPngMatches(current.screenshotPath, resolve(target.path), { limit: (target.occurrence ?? 0) + 1, ...(target.maxChannelDelta !== undefined ? { maxChannelDelta: target.maxChannelDelta } : {}), ...(target.scalePercents ? { scalePercents: target.scalePercents } : {}) }))[target.occurrence ?? 0] !== undefined;
      return condition.kind === 'target-absent' ? !present : present;
    }
    if (!current.uiTreePath) throw new Error('UI tree was not captured');
    const matches = findNodes(parseUiTree(await readFile(current.uiTreePath, 'utf8')), target);
    const present = matches[target.occurrence ?? 0] !== undefined;
    return condition.kind === 'text-absent' || condition.kind === 'target-absent' ? !present : present;
  }

  public async collectLogs(deviceId: DeviceId, since?: string): Promise<LogArtifact> {
    await mkdir(this.artifactsDirectory, { recursive: true });
    const path = join(this.artifactsDirectory, `logcat-${Date.now()}.txt`);
    const args = ["-s", deviceId, "logcat", "-d"];
    if (since) args.push("-T", since);
    await writeFile(path, await this.run(args), "utf8");
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).length;
    return { path, lines, capturedAt: new Date().toISOString() };
  }

  public async diagnoseRuntime(deviceId: DeviceId, packageName: AppPackageName, since?: string): Promise<RuntimeDiagnostics> {
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid package name');
    if (since !== undefined && !/^\d+(?:\.\d+)?$/.test(since)) throw new Error('since must be device Unix epoch seconds');
    const deviceNow = Number((await this.run(['-s', deviceId, 'shell', 'date', '+%s'])).trim());
    if (!Number.isFinite(deviceNow) || deviceNow <= 0) throw new Error('Cannot determine device time');
    const sinceMs = since === undefined ? Math.max(0, deviceNow - 300) * 1000 : Number(since) * 1000;
    if (!Number.isFinite(sinceMs) || sinceMs > (deviceNow + 1) * 1000) throw new Error('Invalid or future diagnostics start time');
    await mkdir(this.artifactsDirectory, { recursive: true });
    const name = `diagnostics-${Date.now()}-${randomUUID()}`;
    const logPath = join(this.artifactsDirectory, `${name}.crash.txt`);
    const eventsPath = join(this.artifactsDirectory, `${name}.events.txt`);
    const diagnosticsPath = join(this.artifactsDirectory, `${name}.json`);
    const [events, crash] = await Promise.all([
      this.run(['-s', deviceId, 'logcat', '-b', 'events', '-d', '-v', 'epoch', '-s', 'am_crash:I', 'am_anr:I']),
      this.run(['-s', deviceId, 'logcat', '-b', 'crash', '-d', '-v', 'epoch']),
    ]);
    await Promise.all([writeFile(logPath, crash), writeFile(eventsPath, events)]);
    const { incidents, malformedEvents } = parseRuntimeIncidents(events, crash, packageName, sinceMs);
    const anrStacks: object[] = [];
    let anrStackStatus = 'not-requested';
    let anrStackError: string | undefined;
    if (incidents.some(incident => incident.kind === 'anr')) {
      try {
        const dropbox = await this.run(['-s', deviceId, 'shell', 'dumpsys', 'dropbox', '--print', 'data_app_anr']);
        for (const [index, incident] of incidents.entries()) {
          const matched = matchAnrStack(dropbox, incident);
          if (!matched) continue;
          const raw = `${name}.anr-${index}.txt`;
          await writeFile(join(this.artifactsDirectory, raw), matched.raw);
          anrStacks.push({ incidentIndex: index, timestampMs: matched.timestampMs, threads: matched.threads, raw });
        }
        anrStackStatus = anrStacks.length === incidents.filter(incident => incident.kind === 'anr').length ? 'matched' : 'unavailable-or-incomplete';
      } catch (error) { anrStackStatus = 'unavailable'; anrStackError = String(error); }
    }
    const foregroundPackage = await this.getForegroundPackage(deviceId);
    let processId = '';
    try { processId = (await this.run(['-s', deviceId, 'shell', 'pidof', packageName])).trim(); }
    catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
    const result = {
      ...(foregroundPackage ? { foregroundPackage } : {}), ...(processId ? { processId } : {}),
      crashCount: incidents.filter(item => item.kind === 'crash').length,
      anrCount: incidents.filter(item => item.kind === 'anr').length,
      logPath, eventsPath, diagnosticsPath, sinceMs, malformedEvents,
    };
    await writeFile(diagnosticsPath, JSON.stringify({ version: 1, packageName, deviceId, capturedAt: new Date().toISOString(), sinceMs,
      incidents, malformedEvents, anrStacks, anrStackStatus, anrStackError, coverage: 'retained-logcat-events',
      rawCrash: `${name}.crash.txt`, rawEvents: `${name}.events.txt`,
      limitations: ['Log buffers may have rotated', 'Java stack correlation uses PID and a bounded time window', 'ANR threads depend on accessible data_app_anr DropBox entries and PID/name/time matching', 'Native tombstones are not parsed'] }, null, 2));
    return result;
  }

  public async collectNetwork(deviceId: DeviceId): Promise<{ readonly path: string; readonly capturedAt: string }> {
    await mkdir(this.artifactsDirectory, { recursive: true });
    const path = join(this.artifactsDirectory, `network-${Date.now()}.txt`);
    await writeFile(path, await this.run(["-s", deviceId, "shell", "dumpsys", "netstats"]), "utf8");
    return { path, capturedAt: new Date().toISOString() };
  }

  public async collectPerformance(deviceId: DeviceId, packageName: AppPackageName, scenario = 'uncontrolled-snapshot'): Promise<{ readonly path: string; readonly metricsPath: string; readonly summaryPath: string; readonly capturedAt: string }> {
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) throw new Error('Invalid package name');
    if (typeof scenario !== 'string' || !scenario.trim()) throw new Error('Scenario is required');
    await mkdir(this.artifactsDirectory, { recursive: true });
    const name = `performance-${Date.now()}-${randomUUID()}`;
    const path = join(this.artifactsDirectory, `${name}.txt`);
    const metricsPath = join(this.artifactsDirectory, `${name}.metrics.json`);
    const summaryPath = join(this.artifactsDirectory, `${name}.summary.json`);
    const startedAt = new Date().toISOString();
    const [cpu, mem, model, system] = await Promise.all([
      this.run(["-s", deviceId, "shell", "dumpsys", "cpuinfo"]),
      this.run(["-s", deviceId, "shell", "dumpsys", "meminfo", packageName]),
      this.run(['-s', deviceId, 'shell', 'getprop', 'ro.product.model']),
      this.run(['-s', deviceId, 'shell', 'getprop', 'ro.build.fingerprint']),
    ]);
    const raw = `# cpuinfo\n${cpu}\n# meminfo ${packageName}\n${mem}`;
    await writeFile(path, raw, 'utf8');
    const capturedAt = new Date().toISOString();
    try {
      const { processes, metrics } = parseMemoryMetrics(mem, packageName);
      const measurement = parsePerformanceDocument({ version: 2, kind: 'measurement', context: {
        platform: 'android', deviceModel: model.trim(), osVersion: system.trim(), appId: packageName, scenario,
        collector: 'adb-meminfo-app-summary', collectorVersion: '1',
        sampling: { durationMs: 0, iterations: 1, warmupIterations: 0, aggregation: 'single' },
      }, metrics }, 'measurement');
      await writeFile(metricsPath, JSON.stringify(measurement, null, 2));
      await writeFile(summaryPath, JSON.stringify({ version: 1, status: 'passed', deviceId, startedAt, capturedAt, processes,
        raw: `${name}.txt`, measurement: `${name}.metrics.json`, rawSha256: createHash('sha256').update(raw).digest('hex'),
        limitations: ['Single snapshot, not a controlled benchmark', 'RSS sum may double-count shared pages', 'CPU output retained as raw evidence only'] }, null, 2));
    } catch (error) {
      await writeFile(summaryPath, JSON.stringify({ version: 1, status: 'failed', deviceId, startedAt, capturedAt, raw: `${name}.txt`, error: String(error) }, null, 2));
      throw new Error(`Performance parsing failed; raw evidence: ${path}; ${String(error)}`);
    }
    return { path, metricsPath, summaryPath, capturedAt };
  }

  public async recordScreen(deviceId: DeviceId, durationSeconds = 5): Promise<{ readonly path: string; readonly capturedAt: string }> {
    validateDuration(durationSeconds, 180);
    return captureArtifact(this.adbPath, deviceId, this.artifactsDirectory, 'screen', durationSeconds, this.signal);
  }

  public async collectPerfetto(deviceId: DeviceId, durationSeconds = 5): Promise<{ readonly path: string; readonly capturedAt: string }> {
    validateDuration(durationSeconds, 60);
    return captureArtifact(this.adbPath, deviceId, this.artifactsDirectory, 'trace', durationSeconds, this.signal);
  }

  public async setHttpProxy(deviceId: DeviceId, proxy: string | null): Promise<void> {
    await this.run(["-s", deviceId, "shell", "settings", "put", "global", "http_proxy", proxy ?? ":0"]);
  }

  private async resolvePoint(deviceId: DeviceId, target: Target): Promise<{ readonly x: number; readonly y: number }> {
    if (target.kind === "coordinate") return { x: target.x, y: target.y };
    const observation = await this.observe(deviceId);
    if (target.kind === 'image-template') {
      if (!observation.screenshotPath) throw new Error('Screenshot was not captured');
      const templatePath = resolve(target.path), bytes = await readFile(templatePath), hash = createHash('sha256').update(bytes).digest('hex');
      await mkdir(this.artifactsDirectory, { recursive: true });
      try { await writeFile(join(this.artifactsDirectory, `visual-template-${hash}.png`), bytes, { flag: 'wx' }); }
      catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
      const matches = await findPngMatches(observation.screenshotPath, templatePath, { limit: target.occurrence === undefined ? 2 : target.occurrence + 1, ...(target.maxChannelDelta !== undefined ? { maxChannelDelta: target.maxChannelDelta } : {}), ...(target.scalePercents ? { scalePercents: target.scalePercents } : {}) });
      if (target.occurrence === undefined && matches.length > 1) throw new Error(`Image template is ambiguous: at least ${matches.length} matches`);
      const match = matches[target.occurrence ?? 0]; if (!match) throw new Error('Image template not found');
      return match.center;
    }
    if (!observation.uiTreePath) throw new Error("UI tree was not captured");
    return center(await findNode(observation.uiTreePath, target));
  }

  private async run(args: readonly string[], timeout = 20000): Promise<string> {
    this.signal?.throwIfAborted();
    const result = await execFileAsync(this.adbPath, [...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout, ...(this.signal ? { signal: this.signal } : {}) });
    return result.stdout;
  }

  private async runBinary(args: readonly string[]): Promise<Buffer> {
    this.signal?.throwIfAborted();
    const result = await execFileAsync(this.adbPath, [...args], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024, timeout: 20_000, ...(this.signal ? { signal: this.signal } : {}) });
    return result.stdout;
  }
}

function validateDuration(seconds: number, maximum: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > maximum) {
    throw new Error(`Duration must be an integer between 1 and ${maximum} seconds`);
  }
}

function parseDeviceLine(line: string): AdbDeviceLine | undefined {
  const match = /^(\S+)\s+(\S+)(?:\s+model:(\S+))?/.exec(line.trim());
  if (!match || !match[1] || !match[2] || match[2] === "offline") return undefined;
  const rawStatus = match[2];
  const status: Device["status"] = rawStatus === "unauthorized" ? "unauthorized" : rawStatus === "device" ? "online" : "busy";
  const device: AdbDeviceLine = { id: brand<string, "DeviceId">(match[1]), status };
  if (match[3]) return { ...device, model: match[3] };
  return device;
}










