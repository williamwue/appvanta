import { parseAction, type Action } from '@appvanta/core';

export function fileShareArguments(input: Extract<Action, { kind: 'share-file' }>): string[] {
  const action = parseAction(input);
  if (action.kind !== 'share-file') throw new Error('Expected share-file action');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.SEND', '-t', quote(action.mimeType),
    '-d', quote(action.uri), '--eu', 'android.intent.extra.STREAM', quote(action.uri), '--grant-read-uri-permission',
    ...(action.packageName ? ['-p', action.packageName] : [])];
}
