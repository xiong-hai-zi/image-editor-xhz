import { App, Editor, MarkdownView, TFile } from 'obsidian';
import { IMAGE_EXTENSIONS } from './types';

export function isImageFile(f: TFile | null): f is TFile {
  return !!f && IMAGE_EXTENSIONS.includes(f.extension.toLowerCase());
}

/** 把 img src / embed src 洗成可用于 getFirstLinkpathDest 的链接路径 */
export function cleanLinkpath(raw: string): string {
  let s = (raw || '').trim();
  // Obsidian 的 app://local/<vault-id>/path/to/img.png
  s = s.replace(/^app:\/\/local\/[^/]+\//i, '');
  s = s.replace(/^app:\/\//i, '');
  // 去掉尺寸参数与查询串：#100 / ?1 / |300
  s = s.split('#')[0].split('?')[0].split('|')[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 保持原样 */
  }
  return s.replace(/^\/+/, '');
}

/** 外链 / data URI 不支持编辑 */
function isRemoteOrInline(src: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(src.trim());
}

/** 由链接文本解析出 vault 里的图片文件 */
export function resolveLinkToImage(
  app: App,
  raw: string,
  sourcePath: string
): TFile | null {
  if (!raw || isRemoteOrInline(raw)) return null;
  const linkpath = cleanLinkpath(raw);
  if (!linkpath) return null;

  let file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (!isImageFile(file)) {
    // 兜底：链接写法比较特殊时，按文件名在库里找同名图片
    const name = linkpath.split('/').pop() ?? linkpath;
    file =
      app.vault
        .getFiles()
        .find((f) => f.basename === name || f.name === name) ?? null;
  }
  return isImageFile(file) ? file : null;
}

/** 从 DOM 元素向上找图片节点并解析 */
function resolveFromDom(
  app: App,
  target: EventTarget | null,
  sourcePath: string
): TFile | null {
  let el = target as HTMLElement | null;
  let guard = 0;
  while (el && guard++ < 12) {
    if (el instanceof HTMLElement) {
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') ?? '';
        const f = resolveLinkToImage(app, src, sourcePath);
        if (f) return f;
      }
      // 阅读模式下的内嵌图片节点
      if (el.classList && el.classList.contains('internal-embed')) {
        const src = el.getAttribute('src') ?? el.getAttribute('alt') ?? '';
        const f = resolveLinkToImage(app, src, sourcePath);
        if (f) return f;
      }
    }
    el = el?.parentElement ?? null;
  }
  return null;
}

const EMBED_RE = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;

/**
 * 实时预览（Live Preview）下 DOM 未必能拿到干净的链接，
 * 这条路径直接从 markdown 源码里找鼠标所在位置的 embed 语法。
 */
function resolveFromSource(
  app: App,
  editor: Editor,
  evt: MouseEvent,
  sourcePath: string
): TFile | null {
  // posAtMouse 是 CodeMirror 编辑器上的实例方法，官方 d.ts 未声明
  const withMouse = editor as unknown as {
    posAtMouse?: (e: MouseEvent) => { line: number; ch: number } | null;
  };
  if (typeof withMouse.posAtMouse !== 'function') return null;

  let pos: { line: number; ch: number } | null = null;
  try {
    pos = withMouse.posAtMouse.call(editor, evt);
  } catch {
    return null;
  }
  if (!pos) return null;

  const line = editor.getLine(pos.line);
  if (line == null) return null;

  EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_RE.exec(line))) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (pos.ch >= start && pos.ch <= end) {
      const raw = (m[1] ?? m[2] ?? '').trim();
      const f = resolveLinkToImage(app, raw, sourcePath);
      if (f) return f;
    }
  }
  return null;
}

/** 综合两条路径，尽量准确地判断右键点击的是哪张图片 */
export function resolveImageAt(
  app: App,
  target: EventTarget | null,
  evt: MouseEvent | null,
  view: MarkdownView | null
): TFile | null {
  const sourcePath = view?.file?.path ?? '';

  const fromDom = resolveFromDom(app, target, sourcePath);
  if (fromDom) return fromDom;

  if (evt && view) {
    const editor: Editor | null = view.editor ?? null;
    if (editor) return resolveFromSource(app, editor, evt, sourcePath);
  }
  return null;
}

/** 光标（或选区起点）所在行的图片 embed，用于命令面板入口 */
export function resolveImageAtCursor(
  app: App,
  view: MarkdownView | null
): TFile | null {
  const editor = view?.editor;
  if (!editor) return null;
  const sourcePath = view?.file?.path ?? '';
  const pos = editor.getCursor('from');
  const line = editor.getLine(pos.line);
  if (line == null) return null;

  EMBED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const candidates: { raw: string; dist: number }[] = [];
  while ((m = EMBED_RE.exec(line))) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    const center = m.index + m[0].length / 2;
    candidates.push({ raw, dist: Math.abs(center - pos.ch) });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    const f = resolveLinkToImage(app, c.raw, sourcePath);
    if (f) return f;
  }
  return null;
}
