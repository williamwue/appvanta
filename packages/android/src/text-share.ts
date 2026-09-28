import { parseAction, type Action } from '@appvanta/core';

export function textShareArguments(input: Extract<Action, { kind: 'share-text' }>): string[] {
  const action = parseAction(input);
  if (action.kind !== 'share-text') throw new Error('Expected share-text action');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.SEND', '-t', 'text/plain',
    '--es', 'android.intent.extra.TEXT', quote(action.text),
    ...(action.subject !== undefined ? ['--es', 'android.intent.extra.SUBJECT', quote(action.subject)] : []),
    ...(action.packageName ? ['-p', action.packageName] : [])];
}
