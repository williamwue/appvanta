import { readFileSync } from 'node:fs';
const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export class ParameterError extends Error {}
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

export function protocolSession(tools: unknown[], call: (name: string | undefined, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) {
  const active = new Map<string | number, AbortController>();
  let state: 'new' | 'initializing' | 'ready' = 'new';
  return async (line: string): Promise<unknown | undefined> => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    let id: string | number | null = null;
    let notification = false;
    try {
      if (object(value) && validId(value.id)) id = value.id;
      if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method || (Object.hasOwn(value, 'id') && !validId(value.id))) throw new RpcError(-32600, 'Invalid request');
      notification = !Object.hasOwn(value, 'id');
      id = notification ? null : value.id as string | number;
      if (notification) {
        if (value.method === 'notifications/cancelled' && object(value.params) && validId(value.params.requestId) && (value.params.reason === undefined || typeof value.params.reason === 'string')) {
          active.get(value.params.requestId)?.abort(new Error(typeof value.params.reason === 'string' ? value.params.reason : 'Request cancelled'));
        }
        // Unknown notifications are ignored; notifications never dispatch tools.
        if (value.method === 'notifications/initialized' && state === 'initializing' && (value.params === undefined || object(value.params))) state = 'ready';
        return undefined;
      }
      if (active.has(id!)) throw new RpcError(-32600, 'Request ID is already in progress');
      const response = (result: unknown) => ({ jsonrpc: '2.0', id, result });
      if (value.params !== undefined && !object(value.params)) throw new ParameterError('params must be an object');
      const params = (value.params ?? {}) as Record<string, unknown>;
      if (value.method === 'ping') return response({});
      if (value.method === 'initialize') {
        if (state !== 'new') throw new RpcError(-32600, 'Session already initialized');
        if (typeof params.protocolVersion !== 'string' || !params.protocolVersion || !object(params.capabilities) || !object(params.clientInfo)
          || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version) throw new ParameterError('initialize requires protocolVersion, capabilities and clientInfo');
        state = 'initializing';
        // If the requested version is unsupported, advertise the version we implement.
        return response({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'appvanta', version: packageVersion } });
      }
      if (state !== 'ready') throw new RpcError(-32002, 'Initialize and send notifications/initialized before tool requests');
      if (value.method === 'tools/list') {
        if (params.cursor !== undefined) throw new ParameterError('This tool list has no pagination cursor');
        return response({ tools });
      }
      if (value.method === 'tools/call') {
        if (typeof params.name !== 'string' || !params.name) throw new ParameterError('Tool name is required');
        if (params.arguments !== undefined && !object(params.arguments)) throw new ParameterError('Tool arguments must be an object');
        const controller = new AbortController();
        active.set(id!, controller);
        try {
          const result = await call(params.name, (params.arguments ?? {}) as Record<string, unknown>, controller.signal);
          if (controller.signal.aborted) return undefined;
          return response({ content: [{ type: 'text', text: JSON.stringify(result) }] });
        } catch (error) {
          if (controller.signal.aborted) return undefined;
          if (error instanceof ParameterError) throw error;
          return response({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] });
        } finally { active.delete(id!); }
      }
      throw new RpcError(-32601, `Method not found: ${value.method}`);
    } catch (error) {
      if (notification) return undefined;
      return { jsonrpc: '2.0', id, error: { code: error instanceof ParameterError ? -32602 : error instanceof RpcError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}
