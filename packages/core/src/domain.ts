export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type DeviceId = Brand<string, "DeviceId">;
export type RunId = Brand<string, "RunId">;
export type AppPackageName = Brand<string, "AppPackageName">;

export type Platform = "android" | "ios" | "desktop" | "web";
export type DeviceKind = "physical" | "emulator" | "simulator" | "desktop" | "browser";
export type DeviceStatus = "online" | "offline" | "unauthorized" | "busy";

export interface Device {
  readonly id: DeviceId;
  readonly platform: Platform;
  readonly kind: DeviceKind;
  readonly status: DeviceStatus;
  readonly name: string;
  readonly model?: string;
  readonly osVersion?: string;
  readonly capabilities: readonly string[];
}

export interface AppArtifact {
  readonly path: string;
  readonly format: "apk" | "ipa" | "desktop" | "web";
  readonly packageName?: AppPackageName;
  readonly versionName?: string;
  readonly sha256?: string;
}

export interface TargetOptions {
  readonly match?: 'exact' | 'contains';
  readonly occurrence?: number;
  readonly within?: string;
}
export type Target =
  | ({ readonly kind: "resource-id"; readonly value: string } & TargetOptions)
  | ({ readonly kind: "accessibility-label"; readonly value: string } & TargetOptions)
  | ({ readonly kind: "text"; readonly value: string } & TargetOptions)
  | ({ readonly kind: "ui-path"; readonly value: string } & TargetOptions)
  | { readonly kind: 'image-template'; readonly path: string; readonly occurrence?: number; readonly maxChannelDelta?: number; readonly scalePercents?: readonly number[] }
  | { readonly kind: "coordinate"; readonly x: number; readonly y: number };

export type Action =
  | { readonly kind: "tap"; readonly target: Target }
  | { readonly kind: "long-press"; readonly target: Target; readonly durationMs: number }
  | { readonly kind: "input"; readonly target: Target; readonly text: string }
  | { readonly kind: 'set-clipboard'; readonly text: string }
  | { readonly kind: 'share-text'; readonly text: string; readonly subject?: string; readonly packageName?: string }
  | { readonly kind: 'share-file'; readonly uri: string; readonly mimeType: string; readonly packageName?: string }
  | { readonly kind: 'paste'; readonly target: Target }
  | { readonly kind: "swipe"; readonly from: Point; readonly to: Point; readonly durationMs: number }
  | { readonly kind: 'pinch'; readonly center: Point; readonly startSpan: number; readonly endSpan: number; readonly durationMs: number }
  | { readonly kind: 'rotate-gesture'; readonly center: Point; readonly radius: number; readonly degrees: number; readonly durationMs: number }
  | { readonly kind: 'multi-touch'; readonly strokes: readonly { readonly points: readonly Point[] }[]; readonly durationMs: number }
  | { readonly kind: "back" }
  | { readonly kind: "button"; readonly button: HardwareButton }
    | { readonly kind: "rotate"; readonly orientation: Orientation }
    | { readonly kind: 'shake'; readonly axis: 'x' | 'y' | 'z'; readonly amplitude: number; readonly cycles: number; readonly intervalMs: number }
  | { readonly kind: "wait"; readonly condition: Condition; readonly timeoutMs: number }
  | { readonly kind: "restart-app" };

export interface Point { readonly x: number; readonly y: number }
export type HardwareButton = 'home' | 'back' | 'power' | 'volume-up' | 'volume-down' | 'mute' | 'app-switch' | 'enter' | 'menu' | 'dpad-up' | 'dpad-down' | 'dpad-left' | 'dpad-right' | 'dpad-center';
export type Orientation = 'portrait' | 'landscape-left' | 'portrait-upside-down' | 'landscape-right';

export type Condition =
  | { readonly kind: "text-visible"; readonly text: string }
  | { readonly kind: "text-absent"; readonly text: string }
  | { readonly kind: "target-visible"; readonly target: Target }
  | { readonly kind: "target-absent"; readonly target: Target }
  | { readonly kind: 'ui-changed' }
  | { readonly kind: 'screen-stable'; readonly stableMs: number; readonly channelThreshold?: number; readonly maxMismatchRatio?: number; readonly ignoreRegions?: readonly import('./visual-diff.js').VisualIgnoreRegion[] }
  | { readonly kind: "app-running"; readonly packageName: AppPackageName };

export interface Observation {
  readonly capturedAt: string;
  readonly screenshotPath?: string;
  readonly uiTreePath?: string;
  readonly uiDescriptionPath?: string;
  readonly foregroundApp?: AppPackageName;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ActionResult {
  readonly success: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly message?: string;
  readonly observation?: Observation;
}

export interface Checkpoint {
  readonly id: string;
  readonly description: string;
  readonly condition: Condition;
}

export interface DeviceDriver {
  readonly name: string;
  listDevices(): Promise<readonly Device[]>;
  install(deviceId: DeviceId, artifact: AppArtifact): Promise<void>;
  launch(deviceId: DeviceId, packageName: AppPackageName): Promise<void>;
  observe(deviceId: DeviceId): Promise<Observation>;
  execute(deviceId: DeviceId, action: Action): Promise<ActionResult>;
  collectLogs(deviceId: DeviceId, since?: string): Promise<LogArtifact>;
}

export interface LogArtifact { readonly path: string; readonly lines: number; readonly capturedAt: string }

export type RunStatus = "planned" | "running" | "passed" | "failed" | "blocked" | "cancelled";
export interface RunMetadata { readonly runId: RunId; readonly startedAt: string; readonly status: RunStatus; readonly driver: string }

export function brand<T, Name extends string>(value: T): Brand<T, Name> { return value as Brand<T, Name>; }
