import { readFile } from 'node:fs/promises';
import type { Target } from '@appvanta/core';
import { parseTarget } from '@appvanta/core';

export interface ResolvedNode {
  readonly path: string;
  readonly parentPath?: string;
  readonly childPaths: string[];
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly resourceId?: string;
  readonly text?: string;
  readonly contentDescription?: string;
  readonly className?: string;
  readonly packageName?: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly clickable: boolean;
  readonly longClickable: boolean;
  readonly scrollable: boolean;
  readonly focusable: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly checkable: boolean;
  readonly checked: boolean;
  readonly password: boolean;
}
export interface UiTree { readonly roots: string[]; readonly nodes: ResolvedNode[] }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code < 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Error('Invalid XML character entity');
      return String.fromCodePoint(code);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity]!;
  });
}

/** Parses the bounded UIAutomator node vocabulary, not arbitrary XML/XPath. */
export function parseUiTree(xml: string): UiTree {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations with entities are unsupported');
  if (/<hierarchy\b/.test(xml) && !/<hierarchy\b[^>]*(?:\/>|>[\s\S]*<\/hierarchy\s*>)/.test(xml)) throw new Error('Incomplete UI hierarchy');
  const roots: string[] = [], nodes: ResolvedNode[] = [], stack: ResolvedNode[] = [];
  const tags = xml.matchAll(/<\/node\s*>|<node\b(?:[^>"']|"[^"]*"|'[^']*')*>/g);
  for (const match of tags) {
    const tag = match[0];
    if (tag.startsWith('</')) { if (!stack.pop()) throw new Error('Unbalanced UI tree'); continue; }
    const a = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1]!, decode(m[2] ?? m[3] ?? '')]));
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(a.bounds ?? '');
    if (!bounds) throw new Error('UI node has invalid bounds');
    const [left, top, right, bottom] = bounds.slice(1).map(Number) as [number, number, number, number];
    if (![left, top, right, bottom].every(Number.isSafeInteger)) throw new Error('UI node has invalid numeric bounds');
    // UIAutomator can return inverted clipped rectangles for off-screen nodes.
    // Keep their hierarchy but exclude them from visible matching and actions.
    const parent = stack.at(-1);
    const path = parent ? `${parent.path}/${parent.childPaths.length}` : `${roots.length}`;
    const node: ResolvedNode = {
      path, ...(parent ? { parentPath: parent.path } : {}), childPaths: [], bounds: { left, top, right, bottom },
      ...(a['resource-id'] ? { resourceId: a['resource-id'] } : {}), ...(a.text ? { text: a.text } : {}),
      ...(a['content-desc'] ? { contentDescription: a['content-desc'] } : {}), ...(a.class ? { className: a.class } : {}), ...(a.package ? { packageName: a.package } : {}),
      enabled: a.enabled !== 'false', visible: a['visible-to-user'] !== 'false' && right > left && bottom > top,
      clickable: a.clickable === 'true', longClickable: a['long-clickable'] === 'true', scrollable: a.scrollable === 'true',
      focusable: a.focusable === 'true', focused: a.focused === 'true', selected: a.selected === 'true',
      checkable: a.checkable === 'true', checked: a.checked === 'true', password: a.password === 'true',
    };
    if (parent) parent.childPaths.push(path); else roots.push(path);
    nodes.push(node);
    if (!/\/\s*>$/.test(tag)) stack.push(node);
  }
  if (stack.length) throw new Error('Unclosed UI node');
  if (nodes.length !== (xml.match(/<node\b/g) ?? []).length) throw new Error('Malformed UI node');
  if (!nodes.length && !/<hierarchy\b[^>]*(?:\/>|>[\s\S]*<\/hierarchy>)/.test(xml)) throw new Error('UI tree is missing');
  return { roots, nodes };
}

export function findNodes(tree: UiTree, rawTarget: Target): ResolvedNode[] {
  const target = parseTarget(rawTarget);
  if (target.kind === 'coordinate') throw new Error('Coordinates do not identify semantic nodes');
  if (target.kind === 'image-template') throw new Error('Image templates require screenshot matching');
  if (target.within && !tree.nodes.some(n => n.path === target.within)) throw new Error(`Ancestor path not found: ${target.within}`);
  return tree.nodes.filter(node => {
    if (!node.visible || target.within && !node.path.startsWith(`${target.within}/`)) return false;
    const value = target.kind === 'resource-id' ? node.resourceId : target.kind === 'text' ? node.text : target.kind === 'accessibility-label' ? node.contentDescription : node.path;
    return target.match === 'contains' ? value?.includes(target.value) === true : value === target.value;
  });
}

export async function findNode(uiTreePath: string, target: Target): Promise<ResolvedNode> {
  if (target.kind === 'image-template') throw new Error('Image templates require screenshot matching');
  const nodes = findNodes(parseUiTree(await readFile(uiTreePath, 'utf8')), target);
  if (target.kind === 'coordinate') throw new Error('Coordinates do not identify semantic nodes');
  const node = nodes[target.occurrence ?? 0];
  if (!node) throw new Error(`Target not found: ${target.kind}=${target.value}`);
  if (target.occurrence === undefined && nodes.length > 1) throw new Error(`Ambiguous target: ${nodes.length} matches; use within, occurrence or ui-path (${nodes.map(n => n.path).join(', ')})`);
  return node;
}

export function center(node: ResolvedNode): { readonly x: number; readonly y: number } {
  if (!node.visible || !node.enabled) throw new Error('Target is hidden or disabled');
  return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) };
}

export function interactionCandidates(tree: UiTree) {
  return tree.nodes.filter(node => node.visible && node.enabled && (node.clickable || node.scrollable || node.className?.endsWith('EditText'))).map(node => {
    const preferred: Target = node.resourceId ? { kind: 'resource-id', value: node.resourceId }
      : node.contentDescription ? { kind: 'accessibility-label', value: node.contentDescription }
      : node.text ? { kind: 'text', value: node.text } : { kind: 'ui-path', value: node.path };
    const target: Target = findNodes(tree, preferred).length === 1 ? preferred : { kind: 'ui-path', value: node.path };
    return { ...node, target };
  });
}
