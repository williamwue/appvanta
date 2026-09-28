import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { emitTaskCompletion, validateWebhookSigningSecret, validateWebhookUrl } from '../dist/index.js';

const event = { version: 1, type: 'task.completed', taskId: 'task-test', status: 'passed', finishedAt: '2026-09-23T00:00:00.000Z' };
test('completion events always persist locally and webhooks require exact allowlisted origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-notify-'));
  try {
    const local = await emitTaskCompletion(join(root, 'local'), event);
    assert.equal(local.delivery, 'local');
    assert.equal(local.attemptCount, 0); assert.match(local.eventId, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(local.path)).event.taskId, event.taskId);
    assert.throws(() => validateWebhookUrl('http://127.0.0.1/private', ['https://hooks.example.test']), /not allowed/);
    assert.throws(() => validateWebhookUrl('https://hooks.example.test/callback?token=secret', ['https://hooks.example.test']), /query/);
    let request;
    const secret = 'test-secret-with-at-least-32-bytes-long';
    const delivered = await emitTaskCompletion(join(root, 'delivered'), event, { webhookUrl: 'https://hooks.example.test/appvanta', allowedOrigins: ['https://hooks.example.test'], signingSecret: secret, send: async (url, body, signal, headers) => { request = { url, body, aborted: signal.aborted, headers }; return { ok: true, status: 204 }; } });
    assert.equal(delivered.delivery, 'delivered'); assert.equal(delivered.responseStatus, 204);
    assert.deepEqual(JSON.parse(request.body), event); assert.equal(request.aborted, false);
    assert.equal(request.headers['x-appvanta-event-id'], delivered.eventId);
    assert.equal(request.headers['x-appvanta-signature'], `sha256=${createHmac('sha256', secret).update(`${request.headers['x-appvanta-timestamp']}.${request.body}`).digest('hex')}`);
    const outcomes = [503, new Error('connection reset'), 204], sleeps = [];
    const retried = await emitTaskCompletion(join(root, 'retried'), event, { webhookUrl: 'https://hooks.example.test/appvanta', allowedOrigins: ['https://hooks.example.test'], retryDelaysMs: [10, 20], sleep: async milliseconds => { sleeps.push(milliseconds); }, send: async () => { const outcome = outcomes.shift(); if (outcome instanceof Error) throw outcome; return { ok: outcome === 204, status: outcome }; } });
    assert.equal(retried.delivery, 'delivered'); assert.equal(retried.attemptCount, 3); assert.deepEqual(sleeps, [10, 20]);
    const failed = await emitTaskCompletion(join(root, 'failed'), event, { webhookUrl: 'https://hooks.example.test/appvanta', allowedOrigins: ['https://hooks.example.test'], send: async () => ({ ok: false, status: 404 }) });
    assert.equal(failed.delivery, 'failed'); assert.equal(failed.responseStatus, 404); assert.equal(failed.attemptCount, 1);
    assert.throws(() => validateWebhookSigningSecret('short'), /32 to 4096/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default webhook transport retries a transient HTTP failure with stable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-notify-http-')), requests = [];
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      requests.push({ headers: request.headers, body }); response.statusCode = requests.length === 1 ? 503 : 204; response.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const result = await emitTaskCompletion(root, event, { webhookUrl: `${origin}/completed`, allowedOrigins: [origin], signingSecret: 'integration-secret-with-at-least-32-bytes', maxAttempts: 2, retryDelaysMs: [0] });
    assert.equal(result.delivery, 'delivered'); assert.equal(result.attemptCount, 2); assert.equal(requests.length, 2);
    assert.equal(requests[0].headers['x-appvanta-event-id'], requests[1].headers['x-appvanta-event-id']);
    assert.equal(requests[0].headers['x-appvanta-signature'], requests[1].headers['x-appvanta-signature']);
    assert.deepEqual(JSON.parse(requests[1].body), event);
  } finally {
    server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true });
  }
});
