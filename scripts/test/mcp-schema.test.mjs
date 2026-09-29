import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parseFlow } from '../../packages/core/dist/index.js';

test('MCP publishes executable schemas and rejects invalid calls before acquiring device locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-schema-'));
  try {
    const cases = [
      ...[{ uri: 'file:///sdcard/a' }, { mimeType: '*/*' }, { unknown: true }].map(patch => ['execute_action', { deviceId: 'emulator-5554', action: { kind: 'share-file', uri: 'content://app.files/a', mimeType: 'application/octet-stream', ...patch } }]),
      ...[
        { extract: { name: 'x', target: { kind: 'image-template', path: 'x.png' }, attribute: 'text' } },
        { extract: { name: 'x', target: { kind: 'text', value: 'x' }, attribute: 'text' }, action: { kind: 'back' } },
        { inputValue: { name: '../x', target: { kind: 'text', value: 'x' } } },
      ].map(step => ['run_flow', { deviceId: 'emulator-5554', flow: { name: 'Invalid value', steps: [{ description: 'invalid', ...step }] } }]),
      ...[{ cycles: 1.5 }, { axis: 'w' }, { amplitude: 31 }, { intervalMs: 0 }].map(patch => ['execute_action', { deviceId: 'emulator-5554', action: { kind: 'shake', axis: 'x', amplitude: 12, cycles: 2, intervalMs: 150, ...patch } }]),
      ...['bad-token', '', 42, null].map(transferRetryToken => ['continue_adjudicated_task', {
        taskId: 'task-00000000-0000-0000-0000-000000000000', transferRetryToken,
        receipt: { decisionId: '00000000-0000-0000-0000-000000000000', preparationId: '00000000-0000-0000-0000-000000000000', leaseToken: '00000000-0000-0000-0000-000000000000', preparationDigestSha256: 'a'.repeat(64), previewDigestSha256: 'b'.repeat(64) },
      }]),
      ['restart_adjudicated_task', { predecessorTaskId: '../escape' }],
      ...['ui-changed', 'screen-stable'].map(kind => ['restart_adjudicated_task', {
        predecessorTaskId: 'task-00000000-0000-0000-0000-000000000000', successorTaskId: 'task-11111111-1111-1111-1111-111111111111',
        receipt: { decisionId: '00000000-0000-0000-0000-000000000000', preparationId: '00000000-0000-0000-0000-000000000000', leaseToken: '00000000-0000-0000-0000-000000000000', preparationDigestSha256: 'a'.repeat(64), previewDigestSha256: 'b'.repeat(64) },
        leaseToken: '11111111-1111-1111-1111-111111111111', checkpoint: { kind, ...(kind === 'screen-stable' ? { stableMs: 500 } : {}) },
      }]),
      ['adjudicate_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', decision: { expectedPreviewDigestSha256: 'a'.repeat(64), expectedLeaseToken: '00000000-0000-0000-0000-000000000000', operator: 'test', reason: 'unknown', verdict: 'unresolved', postconditionCheckpoint: { kind: 'text-visible', text: 'Ready' } } }],
      ['preview_uncertain_task', { taskId: '../escape' }],
      ['adjudicate_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', decision: { expectedPreviewDigestSha256: 'a'.repeat(64), expectedLeaseToken: '00000000-0000-0000-0000-000000000000', operator: 'test', reason: 'observed', verdict: 'postcondition-verified-skip' } }],
      ...['ui-changed', 'screen-stable'].map(kind => ['adjudicate_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', decision: { expectedPreviewDigestSha256: 'a'.repeat(64), expectedLeaseToken: '00000000-0000-0000-0000-000000000000', operator: 'test', reason: 'observed', verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind, ...(kind === 'screen-stable' ? { stableMs: 500 } : {}) } } }]),
      ['prepare_adjudicated_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', expectation: {} }],
      ...['reserve_adjudicated_task', 'continue_adjudicated_task'].map(name => [name, { taskId: 'task-00000000-0000-0000-0000-000000000000', receipt: {} }]),
      ['execute_action', { deviceId: 'fake', action: { kind: 'share-text', text: 'hello', packageName: 'app.test;bad' } }],
      ['execute_action', { deviceId: 'fake', action: { kind: 'share-text', text: '' } }],
      ['start_avd', { name: 'Test', port: 5555 }],
      ['start_avd', { name: 'bad name' }],
      ['start_avd', { name: 'Test', timeoutMs: 0 }],
      ['start_avd', { name: 'Test', gpu: 'bad;mode' }],
      ['compare_screenshots', { baselinePath: 'a.png', currentPath: 'b.png', diffPath: 'diff.png', ignoreRegions: [{ x: 0, y: 0, width: 0, height: 10 }] }],
      ['compare_screenshots', { baselinePath: 'a.png', currentPath: 'b.png', diffPath: 'diff.png', ignoreRegions: [{ x: -1, y: 0, width: 10, height: 10 }] }],
      ['inspect_task_progress', { taskId: '../escape' }],
      ['continue_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', leaseToken: 'invalid', checkpoint: { kind: 'text-visible', text: 'Ready' } }],
      ...['ui-changed', 'screen-stable'].map(kind => ['continue_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', leaseToken: '00000000-0000-0000-0000-000000000000', checkpoint: { kind, ...(kind === 'screen-stable' ? { stableMs: 500 } : {}) } }]),
      ['recover_flow', { deviceId: 'fake' }],
      ['recover_flow', { deviceId: 'fake', leaseToken: 'invalid' }],
      ['inspect_device_lock', { deviceId: ' ', force: true }],
      ['execute_action', { deviceId: 'fake', action: { kind: 'tap', target: { kind: 'text', value: 'OK', occurrence: -1 } } }],
      ['execute_action', { deviceId: 'fake', action: { kind: 'button', button: 'factory-reset' } }],
      ['execute_action', { deviceId: 'fake', action: { kind: 'long-press', target: { kind: 'coordinate', x: 1, y: 1 }, durationMs: 50 } }],
      ['record_screen', { deviceId: 'fake', durationSeconds: '5' }],
      ['collect_perfetto', { deviceId: 'fake', durationSeconds: 61 }],
      ['stop_app', { deviceId: 'fake', packageName: 'app.test; echo bad' }],
      ['observe_app', { deviceId: 'fake', unexpected: true }],
      ['diagnose_runtime', { deviceId: 'fake', packageName: 'app.test', since: 42 }],
      ['run_flow', { deviceId: 'fake', flow: { name: 'test', steps: [{ description: 'bad', recovery: { maxAttempts: 4, rules: [] } }] } }],
      ['run_flow', { deviceId: 'fake', flow: {}, steps: [] }],
      ['run_flows', { deviceIds: ['fake', 'fake'], flow: {} }],
      ['start_flows', { deviceIds: ['fake', 'fake'], flow: { name: 'test', steps: [{ description: 'back', action: { kind: 'back' } }] } }],
      ['get_batch', { batchId: 'bad' }],
      ['start_monitor', { deviceId: 'fake', intervalMs: 100, durationMs: 1000 }],
      ['start_monitor', { deviceId: 'fake', intervalMs: 1000, durationMs: 500 }],
      ['get_monitor', { monitorId: 'bad' }],
      ['pause_task', { taskId: 'bad' }],
      ['resume_task', { taskId: '../escape' }],
      ['start_interaction_recording', { deviceId: 'fake', packages: [] }],
      ['start_interaction_recording', { deviceId: 'fake', packages: ['bad;package'] }],
      ['stop_interaction_recording', { deviceId: 'fake', recordingId: 'bad' }],
      ['steer_task', { taskId: 'bad', instruction: { description: 'back', action: { kind: 'back' } } }],
      ['steer_task', { taskId: 'task-00000000-0000-0000-0000-000000000000', instruction: { description: 'bad', action: { kind: 'button', button: 'factory-reset' } } }],
      ['start_flow', { deviceId: 'fake', flow: { name: 'test', steps: [{ description: 'back', action: { kind: 'back' } }] }, completionWebhook: 'https://not-allowed.example.test/callback' }],
      ['list_devices', null], ['list_devices', []], ['record_flow', {}],
    ];
    const requests = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ...cases.map(([name, args], i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name, arguments: args } }))];
    const result = spawnSync(process.execPath, ['packages/mcp/dist/index.js'], { input: [{ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, ...requests].map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 30000, env: { ...process.env, APPVANTA_LOCK_DIRECTORY: root, PATH: '' }, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split('\n').map(JSON.parse).filter(item => item.id !== 'init');
    assert.equal(responses.length, requests.length);
    for (const response of responses.slice(1)) assert.equal(response.error?.code, -32602, JSON.stringify(response));
    assert.deepEqual(await readdir(root), []);
    const tools = responses[0].result.tools;
    const schema = tools.find(tool => tool.name === 'run_flow').inputSchema;
    const ajv = new Ajv({ strict: false });
    ajv.addFormat('http-url', value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } });
    const validate = ajv.compile(schema);
    const valid = { name: 'test', steps: [{ description: 'wait', action: { kind: 'wait', condition: { kind: 'target-absent', target: { kind: 'text', value: 'Busy', match: 'contains' } }, timeoutMs: 2000 }, assertText: 'Ready', recovery: { maxAttempts: 2, rules: [{ description: 'dismiss', when: { kind: 'text-visible', text: 'Dialog' }, action: { kind: 'back' } }] } }] };
    const hardware = { name: 'hardware', steps: [{ description: 'home', action: { kind: 'button', button: 'home' } }, { description: 'rotate', action: { kind: 'rotate', orientation: 'portrait' } }, { description: 'hold', action: { kind: 'long-press', target: { kind: 'text', value: 'Item' }, durationMs: 500 } }, { description: 'visual', action: { kind: 'tap', target: { kind: 'image-template', path: 'fixtures/icon.png', occurrence: 0, maxChannelDelta: 8, scalePercents: [100, 125] } } }, { description: 'clipboard', action: { kind: 'set-clipboard', text: '中文' } }, { description: 'paste', action: { kind: 'paste', target: { kind: 'text', value: 'Editor' } } }, { description: 'pinch', action: { kind: 'pinch', center: { x: 500, y: 500 }, startSpan: 300, endSpan: 100, durationMs: 500 } }, { description: 'gesture rotate', action: { kind: 'rotate-gesture', center: { x: 500, y: 500 }, radius: 100, degrees: 90, durationMs: 500 } }, { description: 'multi', action: { kind: 'multi-touch', durationMs: 500, strokes: [{ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }, { points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] }] } }, { description: 'stable', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 500 }, timeoutMs: 1000 } }] };
    const corpus = [valid, { name: 'echo', steps: [{ description: 'note', echo: 'hello' }] }, { ...valid, appOps: [{ packageName: "app.test", operation: "CAMERA", mode: "ignore" }] }, { ...valid, appOps: [{ packageName: "app.test", operation: "CAMERA;bad", mode: "allow" }] }, { ...valid, appOps: [] }, { ...valid, inputMethod: "app.test/.Ime" }, { ...valid, inputMethod: "app.test/.Ime;echo bad" }, { ...valid, files: [{ path: "/storage/emulated/0/Download/test.txt", content: "中文\nnext" }] }, { ...valid, files: [{ path: "/storage/emulated/0/../private", content: "" }] }, { ...valid, files: [] }, { ...valid, applications: ["app.test"] }, { ...valid, applications: [] }, { ...valid, applications: ["bad;name"] }, { ...valid, applications: ["app.test", "app.test"] }, { ...valid, diagnostics: { packages: ["app.test"] } }, { ...valid, diagnostics: { packages: [] } }, { ...valid, diagnostics: { packages: ["app.test", "app.test"] } }, { ...valid, diagnostics: { packages: ["app;bad"] } }, { ...valid, capture: { screenSeconds: 180, perfettoSeconds: 60 } }, { ...valid, capture: {} }, { ...valid, capture: { screenSeconds: 181 } }, { ...valid, capture: { perfettoSeconds: "5" } }, { ...valid, version: 2 }, { ...valid, steps: [] }, { ...valid, extra: 1 }, { name: 'url', steps: [{ description: 'open', openUrl: 'https://example.com' }] }, { name: 'bad url', steps: [{ description: 'open', openUrl: 'file:///tmp/a' }] }];
    corpus.push(hardware,
      ...[{ screenSeconds: 3600, screenSegmentSeconds: 60 }, { screenSeconds: 3601 }, { screenSeconds: 300, screenSegmentSeconds: 4 }, { perfettoSeconds: 10, screenSegmentSeconds: 10 }].map(capture => ({ ...valid, capture })),
      { ...valid, resetApplications: ['app.test'] },
      { ...valid, resetApplications: [] },
      { ...valid, resetApplications: ['app.test', 'app.test'] },
      { ...valid, resetApplications: ['bad;package'] },
      { ...valid, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }] },
      { ...valid, permissions: [] },
      { ...valid, permissions: [{ packageName: 'app.test', permission: 'CAMERA;bad', state: 'grant' }] },
      { ...valid, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'allow' }] },
      { ...valid, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }, { packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }] });
    for (const flow of corpus) {
      let parsed = true; try { parseFlow(flow); } catch { parsed = false; }
      assert.equal(validate({ deviceId: 'fake', flow }), parsed, JSON.stringify(validate.errors));
    }
    assert.equal(validate({ deviceId: 'fake', steps: [{ action: { kind: 'back' } }] }), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
