import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brand } from './domain.js';
import type { Observation } from './domain.js';
import type { FlowDriver } from './flow.js';
import type { RecoveryPolicy } from './flow-schema.js';
import type { RunContext } from './run.js';

/** Only explicitly declared operations may run. The failed operation is never replayed. */
export async function recoverStep(options: {
  context: RunContext; driver: FlowDriver; policy: RecoveryPolicy; step: number;
  signal?: AbortSignal | undefined; verify: () => Promise<void>;
  observe: (observation: Observation) => void;
}): Promise<number> {
  const { context, driver, policy, step, signal } = options;
  const deviceId = context.device.id;
  const record = async (event: object) => {
    await writeFile(join(context.rootDirectory, 'recovery.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), step, ...event }) + '\n', { flag: 'a' });
  };
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    signal?.throwIfAborted();
    await record({ attempt, phase: 'observing' });
    // A failed capture or guard evaluation aborts recovery; stale state cannot authorize an action.
    const observation = await driver.observe(deviceId);
    options.observe(observation);
    await context.evidence.saveObservation(`recovery-${step}-${attempt}`, observation);
    let selected;
    for (const [index, rule] of policy.rules.entries()) {
      signal?.throwIfAborted();
      const matches = await driver.checkCondition(deviceId, rule.when, observation);
      await record({ attempt, phase: 'guard', rule: index + 1, matches });
      if (matches) { selected = { rule, index }; break; }
    }
    if (!selected) throw new Error('No recovery rule matched the fresh observation');
    const { rule, index } = selected;
    signal?.throwIfAborted();
    await record({ attempt, phase: 'selected', rule: index + 1, operation: rule });
    try {
      if (rule.launchPackage) await driver.launch(deviceId, brand(rule.launchPackage));
      if (rule.action) {
        const result = await driver.execute(deviceId, rule.action);
        if (!result.success) throw new Error(result.message ?? 'Recovery action failed');
      }
      signal?.throwIfAborted();
      await options.verify();
      signal?.throwIfAborted();
      await record({ attempt, phase: 'passed', rule: index + 1 });
      return attempt;
    } catch (error) {
      await record({ attempt, phase: signal?.aborted ? 'cancelled' : 'failed', rule: index + 1, message: String(error) });
      if (signal?.aborted || attempt === policy.maxAttempts) throw error;
    }
  }
  throw new Error('Recovery attempts exhausted');
}
