import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { parseFlow, type FlowDefinition } from '@appvanta/core';

export async function readFlowFile(path: string): Promise<FlowDefinition> {
  const absolute = resolve(path), extension = extname(absolute).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(extension)) throw new Error('Flow file must use .json, .yaml or .yml');
  const source = await readFile(absolute, 'utf8');
  if (extension === '.json') return parseFlow(JSON.parse(source));
  if (extension === '.yaml' || extension === '.yml') {
    try {
      const document = parseDocument(source, { uniqueKeys: true });
      const firstError = document.errors[0];
      if (firstError) {
        const summary = (firstError.message.split('\n', 1)[0] ?? 'parsing failed').slice(0, 200);
        throw new Error(`Invalid YAML Flow: ${summary}`);
      }
      return parseFlow(document.toJS({ maxAliasCount: 100 }));
    } catch (error) {
      if (error instanceof RangeError) throw new Error('Invalid YAML Flow: nesting exceeds parser capacity');
      throw error;
    }
  }
  throw new Error('Unsupported Flow file');
}
