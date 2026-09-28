import { AuditLog } from './audit.js';

export async function auditedStateChange<T>(options: {
  readonly log: AuditLog;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly read: () => Promise<T>;
  readonly apply: () => Promise<void>;
  readonly verify?: (after: T) => void;
  readonly serialize?: (value: T) => string;
}): Promise<{ before: T; after: T }> {
  const serialize = options.serialize ?? (value => typeof value === 'string' ? value : JSON.stringify(value));
  let before: T | undefined;
  await options.log.append({ timestamp: new Date().toISOString(), actor: options.actor, action: options.action, target: options.target, outcome: 'started' });
  try {
    before = await options.read();
    await options.apply();
    const after = await options.read();
    options.verify?.(after);
    await options.log.append({ timestamp: new Date().toISOString(), actor: options.actor, action: options.action, target: options.target, outcome: 'passed', metadata: { before: serialize(before), after: serialize(after) } });
    return { before, after };
  } catch (error) {
    await options.log.append({ timestamp: new Date().toISOString(), actor: options.actor, action: options.action, target: options.target, outcome: 'failed', metadata: { ...(before !== undefined ? { before: serialize(before) } : {}), error: String(error) } });
    throw error;
  }
}
