import { brand } from './domain.js';
import { parseVisualIgnoreRegions } from './visual-diff.js';
import type { Action, Condition, Target } from './domain.js';

export interface AppOpFixture { readonly packageName: string; readonly operation: string; readonly mode: 'allow' | 'ignore' | 'deny' | 'default' }
export interface PermissionFixture { readonly packageName: string; readonly permission: string; readonly state: 'grant' | 'deny' }
export interface FileFixture { readonly path: string; readonly content: string }
export const fixturePathPattern = "^/storage/emulated/0/(?:[A-Za-z0-9_-][A-Za-z0-9_. -]*/)*[A-Za-z0-9_-][A-Za-z0-9_. -]*$";
export interface DiagnosticsConfig { readonly packages: readonly string[] }
export interface CaptureConfig { readonly screenSeconds?: number; readonly screenSegmentSeconds?: number; readonly perfettoSeconds?: number }
export interface NetworkConfig { readonly python: string; readonly mitmdump: string; readonly port?: number; readonly mapRemote?: string; readonly upstreamCa?: string }
export interface RecoveryRule { readonly description: string; readonly when: Condition; readonly action?: Action; readonly launchPackage?: string }
export interface RecoveryPolicy { readonly maxAttempts: number; readonly rules: readonly RecoveryRule[] }
export interface FlowStep {
  readonly branch?: { readonly key: string; readonly when: Condition; readonly equals: boolean; readonly resolved?: boolean };
  readonly when?: Condition;
  readonly recovery?: RecoveryPolicy;
  readonly description: string;
  readonly action?: Action;
  readonly launchPackage?: string;
  readonly openUrl?: string;
  readonly assertText?: string;
  readonly assertTarget?: Target;
  readonly timeoutMs?: number;
  readonly echo?: string;
}
export interface FlowDefinition { readonly version: 1; readonly applications?: readonly string[]; readonly resetApplications?: readonly string[]; readonly files?: readonly FileFixture[]; readonly inputMethod?: string; readonly permissions?: readonly PermissionFixture[]; readonly appOps?: readonly AppOpFixture[]; readonly name: string; readonly description?: string; readonly network?: NetworkConfig; readonly capture?: CaptureConfig; readonly diagnostics?: DiagnosticsConfig; readonly steps: readonly FlowStep[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a non-empty string');
  return value;
}
function packageName(value: unknown): string {
  const name = text(value);
  if (!/^[A-Za-z0-9_.]+$/.test(name)) throw new Error('Invalid package name');
  return name;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Expected integer between ${min} and ${max}`);
  return value;
}
function point(value: unknown) { const p = object(value); keys(p, ['x', 'y']); return { x: number(p.x, 0, 100000), y: number(p.y, 0, 100000) }; }
function nonzeroInteger(value: unknown, min: number, max: number): number {
  const result = number(value, min, max);
  if (result === 0) throw new Error('Expected a non-zero integer');
  return result;
}
export function parseTarget(value: unknown): Target {
  const t = object(value);
  if (t.kind === 'coordinate') { keys(t, ['kind', 'x', 'y']); return { kind: t.kind, ...point({ x: t.x, y: t.y }) }; }
  if (t.kind === 'image-template') {
    keys(t, ['kind', 'path', 'occurrence', 'maxChannelDelta', 'scalePercents']);
    const path = text(t.path); if (path.includes('\0') || path.length > 4096) throw new Error('Invalid image template path');
    let scalePercents: number[] | undefined;
    if (t.scalePercents !== undefined) {
      if (!Array.isArray(t.scalePercents) || t.scalePercents.length < 1 || t.scalePercents.length > 5) throw new Error('Image template scalePercents requires 1 to 5 values');
      scalePercents = t.scalePercents.map(value => number(value, 50, 200));
      if (new Set(scalePercents).size !== scalePercents.length) throw new Error('Image template scalePercents must be unique');
    }
    return { kind: t.kind, path, ...(t.occurrence !== undefined ? { occurrence: number(t.occurrence, 0, 100000) } : {}), ...(t.maxChannelDelta !== undefined ? { maxChannelDelta: number(t.maxChannelDelta, 0, 255) } : {}), ...(scalePercents ? { scalePercents } : {}) };
  }
  keys(t, ['kind', 'value', 'match', 'occurrence', 'within']);
  if (t.kind !== 'resource-id' && t.kind !== 'accessibility-label' && t.kind !== 'text' && t.kind !== 'ui-path') throw new Error('Unsupported semantic target kind');
  if (t.match !== undefined && t.match !== 'exact' && t.match !== 'contains') throw new Error('Invalid target match mode');
  if ((t.kind === 'resource-id' || t.kind === 'ui-path') && t.match === 'contains') throw new Error('Resource IDs and UI paths require exact matching');
  const valueText = text(t.value);
  const path = (value: unknown) => { const p = text(value); if (!/^\d+(\/\d+)*$/.test(p)) throw new Error('Invalid UI path'); return p; };
  if (t.kind === 'ui-path') path(valueText);
  return { kind: t.kind, value: valueText, ...(t.match !== undefined ? { match: t.match } : {}), ...(t.occurrence !== undefined ? { occurrence: number(t.occurrence, 0, 100000) } : {}), ...(t.within !== undefined ? { within: path(t.within) } : {}) };
}
export function parseCondition(value: unknown): Condition {
  const c = object(value);
  if (c.kind === 'ui-changed') { keys(c, ['kind']); return { kind: c.kind }; }
  if (c.kind === 'screen-stable') {
    keys(c, ['kind', 'stableMs', 'channelThreshold', 'maxMismatchRatio', 'ignoreRegions']);
    if (c.maxMismatchRatio !== undefined && (typeof c.maxMismatchRatio !== 'number' || !Number.isFinite(c.maxMismatchRatio) || c.maxMismatchRatio < 0 || c.maxMismatchRatio > 1)) throw new Error('Invalid stability mismatch ratio');
    return { kind: c.kind, stableMs: number(c.stableMs, 100, 3600000),
      ...(c.channelThreshold !== undefined ? { channelThreshold: number(c.channelThreshold, 0, 255) } : {}),
      ...(c.maxMismatchRatio !== undefined ? { maxMismatchRatio: c.maxMismatchRatio as number } : {}),
      ...(c.ignoreRegions !== undefined ? { ignoreRegions: parseVisualIgnoreRegions(c.ignoreRegions) } : {}) };
  }
  if (c.kind === 'text-visible' || c.kind === 'text-absent') { keys(c, ['kind', 'text']); return { kind: c.kind, text: text(c.text) }; }
  if (c.kind === 'target-visible' || c.kind === 'target-absent') {
    keys(c, ['kind', 'target']); const target = parseTarget(c.target);
    if (target.kind === 'coordinate') throw new Error('Visibility requires a semantic target');
    return { kind: c.kind, target };
  }
  if (c.kind === 'app-running') { keys(c, ['kind', 'packageName']); return { kind: c.kind, packageName: brand<string, 'AppPackageName'>(packageName(c.packageName)) }; }
  throw new Error('Unsupported condition');
}
export function parseAction(value: unknown): Action {
  const a = object(value);
  switch (a.kind) {
    case 'back': keys(a, ['kind']); return { kind: a.kind };
    case 'shake': {
      keys(a, ['kind', 'axis', 'amplitude', 'cycles', 'intervalMs']);
      if (!['x', 'y', 'z'].includes(a.axis as string)) throw new Error('Unsupported shake axis');
      return { kind: a.kind, axis: a.axis as 'x' | 'y' | 'z', amplitude: number(a.amplitude, 1, 30), cycles: number(a.cycles, 1, 20), intervalMs: number(a.intervalMs, 50, 1000) };
    }
    case 'button': {
      keys(a, ['kind', 'button']);
      const buttons = ['home', 'back', 'power', 'volume-up', 'volume-down', 'mute', 'app-switch', 'enter', 'menu', 'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'dpad-center'] as const;
      if (!buttons.includes(a.button as typeof buttons[number])) throw new Error('Unsupported hardware button');
      return { kind: a.kind, button: a.button as typeof buttons[number] };
    }
    case 'rotate': {
      keys(a, ['kind', 'orientation']);
      const orientations = ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right'] as const;
      if (!orientations.includes(a.orientation as typeof orientations[number])) throw new Error('Unsupported orientation');
      return { kind: a.kind, orientation: a.orientation as typeof orientations[number] };
    }
    case 'tap': keys(a, ['kind', 'target']); return { kind: a.kind, target: parseTarget(a.target) };
    case 'long-press': keys(a, ['kind', 'target', 'durationMs']); return { kind: a.kind, target: parseTarget(a.target), durationMs: number(a.durationMs, 200, 60000) };
    case 'input':
      keys(a, ['kind', 'target', 'text']);
      if (typeof a.text !== 'string') throw new Error('Input requires string text');
      return { kind: a.kind, target: parseTarget(a.target), text: a.text };
    case 'set-clipboard':
      keys(a, ['kind', 'text']);
      if (typeof a.text !== 'string') throw new Error('Clipboard requires string text');
      if (Buffer.byteLength(a.text, 'utf8') > 24000 || a.text.includes('\0')) throw new Error('Clipboard text must be valid Unicode without NUL, at most 24000 UTF-8 bytes');
      return { kind: a.kind, text: a.text };
    case 'paste': keys(a, ['kind', 'target']); return { kind: a.kind, target: parseTarget(a.target) };
    case 'share-text': {
      keys(a, ['kind', 'text', 'subject', 'packageName']);
      const shared = text(a.text);
      if (Buffer.byteLength(shared, 'utf8') > 8192 || shared.includes('\0')) throw new Error('Shared text must be at most 8192 UTF-8 bytes without NUL');
      const subject = a.subject === undefined ? undefined : text(a.subject);
      if (subject !== undefined && (Buffer.byteLength(subject, 'utf8') > 1024 || subject.includes('\0'))) throw new Error('Invalid share subject');
      return { kind: a.kind, text: shared, ...(subject !== undefined ? { subject } : {}), ...(a.packageName !== undefined ? { packageName: packageName(a.packageName) } : {}) };
    }
    case 'swipe': keys(a, ['kind', 'from', 'to', 'durationMs']); return { kind: a.kind, from: point(a.from), to: point(a.to), durationMs: number(a.durationMs, 1, 60000) };
    case 'pinch': {
      keys(a, ['kind', 'center', 'startSpan', 'endSpan', 'durationMs']);
      const center = point(a.center), startSpan = number(a.startSpan, 2, 10000), endSpan = number(a.endSpan, 2, 10000);
      if (startSpan === endSpan) throw new Error('Pinch startSpan and endSpan must differ');
      if (center.x - Math.max(startSpan, endSpan) / 2 < 0 || center.x + Math.max(startSpan, endSpan) / 2 > 100000) throw new Error('Pinch extends outside the coordinate space');
      return { kind: a.kind, center, startSpan, endSpan, durationMs: number(a.durationMs, 100, 60000) };
    }
    case 'rotate-gesture': {
      keys(a, ['kind', 'center', 'radius', 'degrees', 'durationMs']);
      const center = point(a.center), radius = number(a.radius, 1, 10000);
      if (center.x - radius < 0 || center.y - radius < 0 || center.x + radius > 100000 || center.y + radius > 100000) throw new Error('Rotate gesture extends outside the coordinate space');
      return { kind: a.kind, center, radius, degrees: nonzeroInteger(a.degrees, -360, 360), durationMs: number(a.durationMs, 100, 60000) };
    }
    case 'multi-touch': {
      keys(a, ['kind', 'strokes', 'durationMs']);
      if (!Array.isArray(a.strokes) || a.strokes.length < 2 || a.strokes.length > 10) throw new Error('Multi-touch requires 2 to 10 strokes');
      const strokes = a.strokes.map(value => {
        const stroke = object(value); keys(stroke, ['points']);
        if (!Array.isArray(stroke.points) || stroke.points.length < 2 || stroke.points.length > 50) throw new Error('Multi-touch stroke requires 2 to 50 points');
        return { points: stroke.points.map(point) };
      });
      return { kind: a.kind, strokes, durationMs: number(a.durationMs, 100, 60000) };
    }
    case 'wait': {
      keys(a, ['kind', 'condition', 'timeoutMs']);
      const condition = parseCondition(a.condition), timeoutMs = number(a.timeoutMs, 1, 3600000);
      if (condition.kind === 'screen-stable' && condition.stableMs > timeoutMs) throw new Error('screen-stable duration cannot exceed wait timeout');
      return { kind: a.kind, condition, timeoutMs };
    }
    default: throw new Error(`Unsupported action: ${String(a.kind)}`);
  }
}
export function parseNetworkConfig(value: unknown): NetworkConfig | undefined {
  if (value === undefined) return undefined;
  const n = object(value); keys(n, ['python', 'mitmdump', 'port', 'mapRemote', 'upstreamCa']);
  return { python: text(n.python), mitmdump: text(n.mitmdump), ...(n.port !== undefined ? { port: number(n.port, 1024, 65535) } : {}), ...(n.mapRemote !== undefined ? { mapRemote: text(n.mapRemote) } : {}), ...(n.upstreamCa !== undefined ? { upstreamCa: text(n.upstreamCa) } : {}) };
}
export function parseFlow(value: unknown): FlowDefinition {
  const f = object(value); keys(f, ['version', 'appOps', 'permissions', 'inputMethod', 'files', 'applications', 'resetApplications', 'name', 'description', 'network', 'capture', 'diagnostics', 'steps']);
  if (f.version !== undefined && f.version !== 1) throw new Error('Unsupported Flow version');
  if (!Array.isArray(f.steps) || !f.steps.length) throw new Error('Flow requires non-empty steps');
  const steps = f.steps.map((value): FlowStep => {
    const s = object(value); keys(s, ['description', 'action', 'launchPackage', 'openUrl', 'assertText', 'assertTarget', 'timeoutMs', 'recovery', 'echo', 'when', 'branch']);
    let branch: FlowStep['branch'];
    if (s.branch !== undefined) {
      const b = object(s.branch); keys(b, ['key', 'when', 'equals', 'resolved']);
      if (typeof b.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(b.key) || typeof b.equals !== 'boolean'
        || (b.resolved !== undefined && typeof b.resolved !== 'boolean')) throw new Error('Invalid branch selector');
      const condition = parseCondition(b.when);
      if (condition.kind === 'ui-changed' || condition.kind === 'screen-stable') throw new Error('Branch requires a point-in-time condition');
      branch = { key: b.key, when: condition, equals: b.equals, ...(b.resolved !== undefined ? { resolved: b.resolved } : {}) };
    }
    const when = s.when === undefined ? undefined : parseCondition(s.when);
    if (when?.kind === 'ui-changed' || when?.kind === 'screen-stable') throw new Error('Step condition requires a point-in-time application state');
    if (!['action', 'launchPackage', 'openUrl', 'assertText', 'assertTarget', 'echo'].some(k => s[k] !== undefined)) throw new Error('Empty Flow step');
    const openUrl = s.openUrl !== undefined ? text(s.openUrl) : undefined;
    if (openUrl && !['http:', 'https:'].includes(new URL(openUrl).protocol)) throw new Error('openUrl requires HTTP(S)');
    const assertTarget = s.assertTarget !== undefined ? parseTarget(s.assertTarget) : undefined;
    if (assertTarget?.kind === 'coordinate') throw new Error('Assertions require a semantic target');
    const recovery = s.recovery === undefined ? undefined : parseRecovery(s.recovery);
    if (recovery && s.assertText === undefined && s.assertTarget === undefined) throw new Error('Recovery requires a step checkpoint');
    const echo = s.echo === undefined ? undefined : text(s.echo);
    if (echo && Buffer.byteLength(echo, 'utf8') > 10000) throw new Error('Echo must be at most 10000 UTF-8 bytes');
    return { ...(branch ? { branch } : {}), ...(when ? { when } : {}), ...(recovery ? { recovery } : {}), description: text(s.description), ...(s.action !== undefined ? { action: parseAction(s.action) } : {}), ...(s.launchPackage !== undefined ? { launchPackage: packageName(s.launchPackage) } : {}), ...(openUrl ? { openUrl } : {}), ...(echo ? { echo } : {}), ...(s.assertText !== undefined ? { assertText: text(s.assertText) } : {}), ...(assertTarget ? { assertTarget } : {}), ...(s.timeoutMs !== undefined ? { timeoutMs: number(s.timeoutMs, 1, 3600000) } : {}) };
  });
  const branches = new Map<string, string>();
  for (const step of steps) if (step.branch) {
    const signature = JSON.stringify({ when: step.branch.when, resolved: step.branch.resolved });
    if (branches.has(step.branch.key) && branches.get(step.branch.key) !== signature) throw new Error('Branch key has inconsistent conditions or resolved values');
    branches.set(step.branch.key, signature);
  }
  let appOps: AppOpFixture[] | undefined;
  if (f.appOps !== undefined) {
    if (!Array.isArray(f.appOps) || !f.appOps.length || f.appOps.length > 20) throw new Error('appOps requires 1 to 20 settings');
    appOps = f.appOps.map(value => {
      const op = object(value); keys(op, ['packageName', 'operation', 'mode']);
      if (typeof op.operation !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(op.operation)) throw new Error('Invalid AppOps operation');
      if (op.mode !== 'allow' && op.mode !== 'ignore' && op.mode !== 'deny' && op.mode !== 'default') throw new Error('Invalid AppOps mode');
      return { packageName: packageName(op.packageName), operation: op.operation, mode: op.mode };
    });
    if (new Set(appOps.map(op => `${op.packageName}/${op.operation}`)).size !== appOps.length) throw new Error('Duplicate AppOps settings');
  }
  let permissions: PermissionFixture[] | undefined;
  if (f.permissions !== undefined) {
    if (!Array.isArray(f.permissions) || !f.permissions.length || f.permissions.length > 20) throw new Error('permissions requires 1 to 20 settings');
    permissions = f.permissions.map(value => {
      const item = object(value); keys(item, ['packageName', 'permission', 'state']);
      const permission = text(item.permission);
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(permission)) throw new Error('Invalid runtime permission name');
      if (item.state !== 'grant' && item.state !== 'deny') throw new Error('Invalid runtime permission state');
      return { packageName: packageName(item.packageName), permission, state: item.state };
    });
    if (new Set(permissions.map(item => `${item.packageName}/${item.permission}`)).size !== permissions.length) throw new Error('Duplicate runtime permissions');
  }
  let inputMethod: string | undefined;
  if (f.inputMethod !== undefined) {
    inputMethod = text(f.inputMethod);
    if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(inputMethod)) throw new Error('Invalid input method component');
  }
  let files: FileFixture[] | undefined;
  if (f.files !== undefined) {
    if (!Array.isArray(f.files) || !f.files.length || f.files.length > 20) throw new Error('files requires 1 to 20 fixtures');
    files = f.files.map(value => {
      const file = object(value); keys(file, ['path', 'content']);
      const path = text(file.path);
      if (!new RegExp(fixturePathPattern).test(path)) throw new Error('Fixture path must be a regular shared-storage path');
      if (typeof file.content !== 'string' || file.content.length > 1000000) throw new Error('Fixture content must be a string of at most 1000000 characters');
      return { path, content: file.content };
    });
    if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate fixture paths');
  }
  let applications: string[] | undefined;
  if (f.applications !== undefined) {
    if (!Array.isArray(f.applications) || !f.applications.length || f.applications.length > 20) throw new Error('applications requires 1 to 20 packages');
    applications = f.applications.map(packageName);
    if (new Set(applications).size !== applications.length) throw new Error('Duplicate applications');
  }
  let resetApplications: string[] | undefined;
  if (f.resetApplications !== undefined) {
    if (!Array.isArray(f.resetApplications) || !f.resetApplications.length || f.resetApplications.length > 20) throw new Error('resetApplications requires 1 to 20 packages');
    resetApplications = f.resetApplications.map(packageName);
    if (new Set(resetApplications).size !== resetApplications.length) throw new Error('Duplicate reset applications');
  }
  let diagnostics: DiagnosticsConfig | undefined;
  if (f.diagnostics !== undefined) {
    const d = object(f.diagnostics); keys(d, ['packages']);
    if (!Array.isArray(d.packages) || d.packages.length < 1 || d.packages.length > 20) throw new Error('Diagnostics requires 1 to 20 packages');
    const packages = d.packages.map(packageName);
    if (new Set(packages).size !== packages.length) throw new Error('Duplicate diagnostics packages');
    diagnostics = { packages };
  }
  let capture: CaptureConfig | undefined;
  if (f.capture !== undefined) {
    const c = object(f.capture); keys(c, ['screenSeconds', 'screenSegmentSeconds', 'perfettoSeconds']);
    if (c.screenSeconds === undefined && c.perfettoSeconds === undefined) throw new Error('Capture requires at least one collector');
    if (c.screenSegmentSeconds !== undefined && c.screenSeconds === undefined) throw new Error('Screen segment duration requires screen capture');
    capture = { ...(c.screenSeconds !== undefined ? { screenSeconds: number(c.screenSeconds, 1, 3600) } : {}), ...(c.screenSegmentSeconds !== undefined ? { screenSegmentSeconds: number(c.screenSegmentSeconds, 5, 180) } : {}), ...(c.perfettoSeconds !== undefined ? { perfettoSeconds: number(c.perfettoSeconds, 1, 60) } : {}) };
  }
  const network = parseNetworkConfig(f.network);
  return { version: 1, name: text(f.name), steps, ...(appOps ? { appOps } : {}), ...(permissions ? { permissions } : {}), ...(inputMethod ? { inputMethod } : {}), ...(files ? { files } : {}), ...(applications ? { applications } : {}), ...(resetApplications ? { resetApplications } : {}), ...(f.description !== undefined ? { description: text(f.description) } : {}), ...(network ? { network } : {}), ...(capture ? { capture } : {}), ...(diagnostics ? { diagnostics } : {}) };
}

function parseRecovery(value: unknown): RecoveryPolicy {
  const r = object(value); keys(r, ['maxAttempts', 'rules']);
  if (!Array.isArray(r.rules) || r.rules.length < 1 || r.rules.length > 10) throw new Error('Recovery requires 1 to 10 rules');
  return { maxAttempts: number(r.maxAttempts, 1, 3), rules: r.rules.map(value => {
    const rule = object(value); keys(rule, ['description', 'when', 'action', 'launchPackage']);
    if ((rule.action !== undefined) === (rule.launchPackage !== undefined)) throw new Error('Recovery rule requires exactly one operation');
    const when = parseCondition(rule.when);
    if (when.kind === 'ui-changed') throw new Error('Recovery guard requires a current-state condition');
    return { description: text(rule.description), when, ...(rule.action !== undefined ? { action: parseAction(rule.action) } : {}), ...(rule.launchPackage !== undefined ? { launchPackage: packageName(rule.launchPackage) } : {}) };
  }) };
}
