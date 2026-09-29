import { fixturePathPattern } from '@appvanta/core';
type Schema = Record<string, unknown>;
const string = { type: 'string', minLength: 1, pattern: '\\S' };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const variant = (kind: string, properties: Record<string, unknown> = {}, required = Object.keys(properties)) => object({ kind: { const: kind }, ...properties }, ['kind', ...required]);
const semantic = ['resource-id', 'accessibility-label', 'text', 'ui-path'].map(kind => variant(kind, {
  value: kind === 'ui-path' ? { type: 'string', pattern: '^\\d+(/\\d+)*$' } : string,
  match: { enum: kind === 'resource-id' || kind === 'ui-path' ? ['exact'] : ['exact', 'contains'] },
  occurrence: integer(0, 100000), within: { type: 'string', pattern: '^\\d+(/\\d+)*$' },
}, ['value']));
semantic.push(variant('image-template', { path: { type: 'string', minLength: 1, maxLength: 4096 }, occurrence: integer(0, 100000), maxChannelDelta: integer(0, 255), scalePercents: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: integer(50, 200) } }, ['path']));
const point = object({ x: integer(0, 100000), y: integer(0, 100000) });
const stroke = object({ points: { type: 'array', minItems: 2, maxItems: 50, items: point } });
const hardwareButton = { enum: ['home', 'back', 'power', 'volume-up', 'volume-down', 'mute', 'app-switch', 'enter', 'menu', 'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'dpad-center'] };
const orientation = { enum: ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right'] };
const packageName = { type: 'string', pattern: '^[A-Za-z0-9_.]+$' };
const conditions = [
  ...['text-visible', 'text-absent'].map(kind => variant(kind, { text: string })),
  ...['target-visible', 'target-absent'].map(kind => variant(kind, { target: ref('semanticTarget') })),
  variant('app-running', { packageName }),
  variant('screen-stable', { stableMs: integer(100, 3600000), channelThreshold: integer(0, 255), maxMismatchRatio: { type: 'number', minimum: 0, maximum: 1 }, ignoreRegions: { type: 'array', maxItems: 100, items: object({ x: integer(0, 100000), y: integer(0, 100000), width: integer(1, 100000), height: integer(1, 100000) }) } }, ['stableMs']),
];
const present = (names: string[]) => ({ anyOf: names.map(name => ({ required: [name] })) });
const stepProperties = {
  when: { oneOf: conditions.filter(condition => (condition.properties as Record<string, { const?: string }>).kind?.const !== 'screen-stable') },
  description: string, action: ref('action'), launchPackage: packageName,
  openUrl: { type: 'string', format: 'http-url' },
  echo: { type: 'string', minLength: 1, maxLength: 10000 }, assertText: string, assertTarget: ref('semanticTarget'), timeoutMs: integer(1, 3600000), recovery: ref('recovery'),
};
const step = (legacy = false) => ({ ...object(stepProperties, legacy ? [] : ['description']), ...present(['action', 'launchPackage', 'openUrl', 'assertText', 'assertTarget', 'echo']),
  if: { required: ['recovery'] }, then: present(['assertText', 'assertTarget']) });
export const definitions = {
  semanticTarget: { oneOf: semantic },
  target: { oneOf: [...semantic, variant('coordinate', { x: integer(0, 100000), y: integer(0, 100000) })] },
  condition: { oneOf: [...conditions, variant('ui-changed')] },
  action: { oneOf: [variant('back'), variant('button', { button: hardwareButton }), variant('rotate', { orientation }), variant('tap', { target: ref('target') }), variant('long-press', { target: ref('target'), durationMs: integer(200, 60000) }), variant('input', { target: ref('target'), text: { type: 'string' } }), variant('set-clipboard', { text: { type: 'string', maxLength: 24000 } }), variant('paste', { target: ref('target') }),
    variant('share-text', { text: { ...string, maxLength: 8192 }, subject: { ...string, maxLength: 1024 }, packageName }, ['text']),
    variant('shake', { axis: { enum: ['x', 'y', 'z'] }, amplitude: integer(1, 30), cycles: integer(1, 20), intervalMs: integer(50, 1000) }),
    variant('swipe', { from: point, to: point, durationMs: integer(1, 60000) }), variant('pinch', { center: point, startSpan: integer(2, 10000), endSpan: integer(2, 10000), durationMs: integer(100, 60000) }), variant('rotate-gesture', { center: point, radius: integer(1, 10000), degrees: { oneOf: [integer(-360, -1), integer(1, 360)] }, durationMs: integer(100, 60000) }), variant('multi-touch', { strokes: { type: 'array', minItems: 2, maxItems: 10, items: stroke }, durationMs: integer(100, 60000) }), variant('wait', { condition: ref('condition'), timeoutMs: integer(1, 3600000) })] },
  recovery: object({ maxAttempts: integer(1, 3), rules: { type: 'array', minItems: 1, maxItems: 10, items: {
    ...object({ description: string, when: { oneOf: conditions }, action: ref('action'), launchPackage: packageName }, ['description', 'when']),
    oneOf: [{ required: ['action'] }, { required: ['launchPackage'] }],
  } } }),
  step: step(), legacyStep: step(true),
  network: object({ python: string, mitmdump: string, port: integer(1024, 65535), mapRemote: string, upstreamCa: string }, ['python', 'mitmdump']),
  diagnostics: object({ packages: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: packageName } }),
  capture: { ...object({ screenSeconds: integer(1, 3600), screenSegmentSeconds: integer(5, 180), perfettoSeconds: integer(1, 60) }, []), ...present(['screenSeconds', 'perfettoSeconds']), dependencies: { screenSegmentSeconds: ['screenSeconds'] } },
  flow: object({ appOps: { type: 'array', minItems: 1, maxItems: 20, items: object({ packageName, operation: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' }, mode: { enum: ['allow', 'ignore', 'deny', 'default'] } }) }, permissions: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: object({ packageName, permission: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$' }, state: { enum: ['grant', 'deny'] } }) }, inputMethod: { type: 'string', pattern: '^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$' }, files: { type: 'array', minItems: 1, maxItems: 20, items: object({ path: { type: 'string', pattern: fixturePathPattern }, content: { type: 'string', maxLength: 1000000 } }) }, applications: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: packageName }, resetApplications: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: packageName }, version: { const: 1 }, name: string, description: string, network: ref('network'), capture: ref('capture'), diagnostics: ref('diagnostics'), steps: { type: 'array', minItems: 1, items: ref('step') } }, ['name', 'steps']),
};

/** The advertised schema is also the schema enforced before any tool dispatch. */
export function toolSchema(name: string, original: Schema): Schema {
  const properties = { ...(original.properties as Record<string, Schema>) };
  for (const [key, value] of Object.entries(properties)) {
    if (value.type === 'string') properties[key] = { ...string, ...value };
  }
  if (properties.packageName) properties.packageName = packageName;
  if (properties.permission) properties.permission = { type: 'string', pattern: '^[A-Za-z0-9_.:]+$' };
  if (name === 'compare_screenshots') {
    properties.ignoreRegions = { type: 'array', maxItems: 100, items: object({ x: integer(0, 100000), y: integer(0, 100000), width: integer(1, 100000), height: integer(1, 100000) }) };
    properties.maxAlignmentShift = integer(0, 16);
    properties.minSsim = { type: 'number', minimum: 0, maximum: 1 };
  }
  if (properties.action) properties.action = ref('action');
  if (properties.instruction) properties.instruction = ref('step');
  if (name === 'continue_task' || name === 'start_task_continuation') properties.checkpoint = { oneOf: conditions.filter(condition => (condition.properties as Record<string, { const?: string }>).kind?.const !== 'screen-stable') };
  if (properties.flow) properties.flow = ref('flow');
  if (properties.steps) properties.steps = { type: 'array', minItems: 1, items: ref('legacyStep') };
  if (properties.deviceIds) properties.deviceIds = { ...properties.deviceIds, type: 'array', minItems: 1, uniqueItems: true, items: string };
  if (properties.durationSeconds) properties.durationSeconds = integer(1, name === 'record_screen' ? 180 : 60);
  const schema: Schema = { ...original, properties, additionalProperties: false, ...(properties.action || properties.instruction || properties.flow || properties.steps || properties.checkpoint ? { $defs: definitions } : {}) };
  if (properties.flow && properties.steps) {
    delete schema.anyOf;
    schema.oneOf = [{ required: ['flow'] }, { required: ['steps'] }];
  }
  return schema;
}
