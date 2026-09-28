import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const url = path => path.split('/').map(encodeURIComponent).join('/');
const normalize = path => path.replaceAll('\\', '/');
const document = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"><title>${escape(title)}</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px;color:#172033}a{color:#175ec7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6fa;padding:1rem}li{margin:.4rem 0}</style><body>${body}</body></html>`;

/** Read-only presentation: original bytes and their embedded hashes remain intact. */
export async function buildArchiveViewer(root, files, emit) {
  const paths = files.map(file => file.path);
  const known = new Map(paths.map(path => [normalize(resolve(root, path)), path]));
  const views = new Map(paths.filter(path => /\.jsonl?$/.test(path)).map((path, index) => [path, `.appvanta-view/${index}.html`]));
  const target = (value, source) => {
    const direct = known.get(normalize(value)) ?? known.get(normalize(resolve(root, dirname(source), value))) ?? known.get(normalize(resolve(root, value)));
    if (direct) return direct;
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) {
      const candidates = paths.filter(path => normalize(value).endsWith('/' + path));
      if (candidates.length === 1) return candidates[0];
    }
  };
  const render = (value, source, level = 0) => {
    if (level > 40) return escape(JSON.stringify(value));
    if (typeof value === 'string') {
      const path = target(value, source);
      return path ? `<a href="../${url(views.get(path) ?? path)}">${escape(JSON.stringify(path))}</a>` : escape(JSON.stringify(value));
    }
    if (Array.isArray(value)) return '[\n' + value.map(item => '  '.repeat(level + 1) + render(item, source, level + 1)).join(',\n') + '\n' + '  '.repeat(level) + ']';
    if (value && typeof value === 'object') return '{\n' + Object.entries(value).map(([key, item]) => '  '.repeat(level + 1) + escape(JSON.stringify(key)) + ': ' + render(item, source, level + 1)).join(',\n') + '\n' + '  '.repeat(level) + '}';
    return escape(JSON.stringify(value));
  };
  for (const [path, view] of views) {
    const raw = await readFile(resolve(root, path), 'utf8');
    let body;
    const renderJson = text => { try { return render(JSON.parse(text), path); } catch { return escape(text); } };
    body = path.endsWith('.jsonl') ? raw.split(/\r?\n/).map(renderJson).join('\n\n') : renderJson(raw);
    await emit(view, document(path, `<p><a href="../index.html">Evidence index</a> · <a href="../${url(path)}">Original file</a></p><h1>${escape(path)}</h1><pre>${body}</pre>`));
  }
  const rows = paths.map(path => `<li><a href="${url(views.get(path) ?? path)}">${escape(path)}</a></li>`).join('\n');
  await emit('index.html', document('AppVanta evidence', `<h1>AppVanta evidence</h1><p>Offline archive. JSON and JSONL views resolve included evidence with relative links. Original evidence is unchanged. External or excluded references remain plain text.</p><p><a href="manifest.json">Integrity manifest</a></p><ul>${rows}</ul>`));
}
