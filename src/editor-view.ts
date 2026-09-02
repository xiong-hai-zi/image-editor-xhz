import { ItemView, Notice, Scope, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { ImageEditorEngine } from './canvas-engine';
import type ImageEditorPlugin from './main';
import { iconSvg } from './icons';
import { decodeImage, mimeOf } from './image-loader';
import { isImageFile } from './image-resolver';
import { EngineState, ToolName } from './types';
import { escapeRegExp } from './utils';

export const VIEW_TYPE_IMAGE_EDITOR = 'image-editor-view';

interface ToolDef {
  id: ToolName;
  icon: string;
  label: string;
  hotkey?: string;
}

const TOOLS: ToolDef[] = [
  { id: 'hand', icon: 'move', label: '抓手：拖动视图，滚轮缩放', hotkey: 'H' },
  { id: 'pen', icon: 'pencil', label: '自由画笔', hotkey: 'P' },
  { id: 'line', icon: 'minus', label: '直线', hotkey: 'L' },
  { id: 'arrow', icon: 'arrow', label: '箭头', hotkey: 'A' },
  { id: 'rect', icon: 'square', label: '矩形', hotkey: 'R' },
  { id: 'ellipse', icon: 'circle', label: '椭圆', hotkey: 'O' },
  { id: 'text', icon: 'type', label: '文本：点击图片后输入', hotkey: 'T' },
  { id: 'mosaic', icon: 'mosaic', label: '马赛克：拖出区域', hotkey: 'M' },
  { id: 'crop', icon: 'crop', label: '裁剪：拖出区域后点应用', hotkey: 'C' },
];

const PALETTE = [
  '#e9372c',
  '#f59f00',
  '#f2d600',
  '#2f9e44',
  '#1971c2',
  '#6741d9',
  '#ffffff',
  '#212529',
];

const FONT_SIZES = [14, 18, 24, 32, 44, 64];

/** 可能带透明通道的格式，需要画棋盘格底 */
const TRANSPARENT_EXTENSIONS = ['png', 'webp', 'gif', 'avif'];

export class ImageEditorView extends ItemView {
  plugin: ImageEditorPlugin;
  file: TFile | null = null;

  private engine: ImageEditorEngine | null = null;
  private stage: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private cropGroup: HTMLElement | null = null;
  private styleGroup: HTMLElement | null = null;
  private toolButtons = new Map<ToolName, HTMLElement>();
  private undoBtn: HTMLElement | null = null;
  private redoBtn: HTMLElement | null = null;
  private applyCropBtn: HTMLElement | null = null;
  private clearBtn: HTMLElement | null = null;
  private fillBtn: HTMLElement | null = null;
  private colorInput: HTMLInputElement | null = null;
  private widthInput: HTMLInputElement | null = null;
  private widthLabel: HTMLElement | null = null;
  private sizeSelect: HTMLSelectElement | null = null;
  private textInput: HTMLTextAreaElement | null = null;

  // 注意：View 基类已有 `scope` 属性，这里必须换名
  private keyScope: Scope;
  private scopePushed = false;
  private loadingPath: string | null = null;
  private dirty = false;
  private built = false;

  constructor(leaf: WorkspaceLeaf, plugin: ImageEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.keyScope = new Scope();
  }

  // ------------------------------------------------------------ 视图基本属性

  getViewType(): string {
    return VIEW_TYPE_IMAGE_EDITOR;
  }

  getDisplayText(): string {
    return this.file ? this.file.name : '图片编辑器';
  }

  getIcon(): string {
    return 'image';
  }

  async onOpen(): Promise<void> {
    this.buildUi();
    this.registerScopeKeys();
    this.syncScope();
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.syncScope())
    );
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) this.engine?.setSpaceDown(true);
    });
    this.registerDomEvent(document, 'keyup', (e: KeyboardEvent) => {
      if (e.code === 'Space') this.engine?.setSpaceDown(false);
    });
  }

  async onClose(): Promise<void> {
    if (this.dirty && this.file) {
      new Notice(`「${this.file.name}」的修改尚未保存`, 6000);
    }
    this.closeTextInput();
    if (this.scopePushed) {
      this.app.keymap.popScope(this.keyScope);
      this.scopePushed = false;
    }
    this.engine?.destroy();
    this.engine = null;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const path = (state as { file?: unknown } | null)?.file;
    if (typeof path === 'string' && path) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.loadFile(f);
    }
    await super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  // ------------------------------------------------------------ 载入图片

  async loadFile(file: TFile): Promise<boolean> {
    if (this.loadingPath === file.path) return false;
    if (file.extension.toLowerCase() === 'svg') {
      new Notice('暂不支持编辑 SVG（请先转成 PNG）');
      return false;
    }
    if (!isImageFile(file)) return false;

    this.loadingPath = file.path;
    try {
      const data = await this.app.vault.readBinary(file);
      const img = await decodeImage(data, mimeOf(file));
      this.buildUi();
      this.file = file;
      this.engine?.loadImage(
        img,
        TRANSPARENT_EXTENSIONS.includes(file.extension.toLowerCase())
      );
      this.applyDefaults();
      this.dirty = false;
      this.updateHeader();
      this.updateStatus(this.engine?.state() ?? null);
      this.emptyEl?.addClass('is-hidden');
      if (file.extension.toLowerCase() === 'gif') {
        new Notice('GIF 只会编辑第一帧', 4000);
      }
      return true;
    } catch (err) {
      new Notice(`图片加载失败：${(err as Error).message}`);
      return false;
    } finally {
      this.loadingPath = null;
    }
  }

  private applyDefaults(): void {
    const s = this.plugin.settings;
    this.engine?.setColor(s.defaultColor);
    this.engine?.setLineWidth(s.defaultLineWidth);
    this.engine?.setFontSize(s.defaultFontSize);
    this.engine?.setTool(s.defaultTool);
    if (this.colorInput) this.colorInput.value = s.defaultColor;
    if (this.widthInput) {
      this.widthInput.value = String(s.defaultLineWidth);
      if (this.widthLabel) this.widthLabel.textContent = `${s.defaultLineWidth}px`;
    }
  }

  // ------------------------------------------------------------ 界面构建

  private buildUi(): void {
    if (this.built) return;
    this.built = true;

    const root = this.contentEl;
    root.empty();
    root.addClass('imged-root');

    // ---- 工具栏
    const bar = root.createDiv({ cls: 'imged-toolbar' });

    const toolGroup = bar.createDiv({ cls: 'imged-group' });
    for (const t of TOOLS) {
      const btn = toolGroup.createEl('button', {
        cls: 'imged-btn',
        attr: { type: 'button', 'aria-label': t.label },
      });
      btn.innerHTML = iconSvg(t.icon);
      btn.title = t.hotkey ? `${t.label}（${t.hotkey}）` : t.label;
      btn.addEventListener('click', () => this.setTool(t.id));
      this.toolButtons.set(t.id, btn);
    }

    // ---- 样式
    this.styleGroup = bar.createDiv({ cls: 'imged-group imged-style' });

    for (const c of PALETTE) {
      const sw = this.styleGroup.createEl('button', {
        cls: 'imged-swatch',
        attr: { type: 'button', 'aria-label': `颜色 ${c}` },
      });
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', () => this.setColor(c));
    }
    const colorWrap = this.styleGroup.createDiv({ cls: 'imged-color-pick' });
    this.colorInput = colorWrap.createEl('input', {
      cls: 'imged-color-input',
      attr: { type: 'color' },
    });
    this.colorInput.title = '自定义颜色';
    this.colorInput.addEventListener('input', () => this.setColor(this.colorInput!.value));

    const widthWrap = this.styleGroup.createDiv({ cls: 'imged-width' });
    this.widthInput = widthWrap.createEl('input', {
      cls: 'imged-range',
      attr: { type: 'range', min: '1', max: '24', step: '1' },
    });
    this.widthLabel = widthWrap.createSpan({ cls: 'imged-width-label', text: '4px' });
    this.widthInput.addEventListener('input', () => {
      const v = Number(this.widthInput!.value);
      this.engine?.setLineWidth(v);
      if (this.widthLabel) this.widthLabel.textContent = `${v}px`;
    });

    this.fillBtn = this.styleGroup.createEl('button', {
      cls: 'imged-btn',
      attr: { type: 'button', 'aria-label': '矩形/椭圆半透明填充' },
    });
    this.fillBtn.innerHTML = iconSvg('fill');
    this.fillBtn.title = '矩形 / 椭圆填充';
    let filled = false;
    this.fillBtn.addEventListener('click', () => {
      filled = !filled;
      this.fillBtn?.toggleClass('is-active', filled);
      this.engine?.setFill(filled);
    });

    const sizeSel = this.styleGroup.createEl('select', { cls: 'imged-select' });
    sizeSel.title = '文本字号';
    for (const s of FONT_SIZES) {
      const opt = sizeSel.createEl('option', { text: `${s}`, value: String(s) });
      if (s === this.plugin.settings.defaultFontSize) opt.selected = true;
    }
    sizeSel.addEventListener('change', () => this.engine?.setFontSize(Number(sizeSel.value)));
    this.sizeSelect = sizeSel;

    // ---- 历史 / 视图
    const histGroup = bar.createDiv({ cls: 'imged-group' });
    this.undoBtn = makeBtn(histGroup, 'undo', '撤销 (Ctrl+Z)', () => this.engine?.undo());
    this.redoBtn = makeBtn(histGroup, 'redo', '重做 (Ctrl+Shift+Z)', () => this.engine?.redo());
    this.clearBtn = makeBtn(histGroup, 'eraser', '清空所有标注', () => this.engine?.clearShapes());
    makeBtn(histGroup, 'fit', '适应窗口', () => this.engine?.fit());
    makeBtn(histGroup, 'actual', '1:1 实际大小', () => this.engine?.actualSize());

    // ---- 裁剪专用
    this.cropGroup = bar.createDiv({ cls: 'imged-group imged-crop-group is-hidden' });
    makeBtn(this.cropGroup, 'selectAll', '全选整幅图', () => this.engine?.selectAllCrop());
    this.applyCropBtn = this.cropGroup.createEl('button', {
      cls: 'imged-btn imged-btn-accent',
      attr: { type: 'button' },
    });
    this.applyCropBtn.innerHTML = `${iconSvg('check')}<span>应用裁剪</span>`;
    this.applyCropBtn.title = '应用裁剪 (Enter)';
    this.applyCropBtn.addEventListener('click', () => this.engine?.applyCrop());
    makeBtn(this.cropGroup, 'close', '退出裁剪 (Esc)', () => this.setTool('pen'));

    // ---- 右侧操作
    const actions = bar.createDiv({ cls: 'imged-group imged-actions' });
    const saveCopyBtn = actions.createEl('button', { cls: 'imged-btn', attr: { type: 'button' } });
    saveCopyBtn.innerHTML = `${iconSvg('copy')}<span>另存为</span>`;
    saveCopyBtn.title = '保存为新 PNG 文件，不动原图';
    saveCopyBtn.addEventListener('click', () => void this.save(true));

    const saveBtn = actions.createEl('button', {
      cls: 'imged-btn imged-btn-primary',
      attr: { type: 'button' },
    });
    saveBtn.innerHTML = `${iconSvg('save')}<span>完成</span>`;
    saveBtn.title = '保存并替换原图 (Ctrl+S)';
    saveBtn.addEventListener('click', () => void this.save(false));

    // ---- 画布区
    const stage = root.createDiv({ cls: 'imged-stage' });
    this.stage = stage;
    stage.addEventListener('pointerdown', (e) => this.onStagePointerDown(e));

    this.engine = new ImageEditorEngine(stage, {
      onStateChange: (st) => this.updateStatus(st),
    });

    this.emptyEl = stage.createDiv({ cls: 'imged-empty' });
    this.emptyEl.setText(this.file ? '正在载入…' : '没有正在编辑的图片');

    // ---- 状态栏
    this.statusEl = root.createDiv({ cls: 'imged-status' });
  }

  // ------------------------------------------------------------ 交互

  private onStagePointerDown(e: PointerEvent): void {
    if (!this.engine || !this.engine.ready) return;
    if (this.engine.getTool() === 'text' && e.button === 0 && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.openTextInput(e.clientX, e.clientY);
    }
  }

  private openTextInput(clientX: number, clientY: number): void {
    const stage = this.stage;
    const engine = this.engine;
    if (!stage || !engine) return;
    this.closeTextInput();

    const rect = stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const zoom = engine.getZoom();

    const ta = stage.createEl('textarea', { cls: 'imged-text-input' });
    ta.style.left = `${x}px`;
    ta.style.top = `${y}px`;
    ta.style.fontSize = `${Math.max(10, this.plugin.settings.defaultFontSize * zoom)}px`;
    ta.style.color = this.plugin.settings.defaultColor;
    ta.placeholder = '输入文字后按 Ctrl+Enter 确认，Esc 取消';
    ta.rows = 1;
    this.textInput = ta;

    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.commitTextInput(clientX, clientY);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.closeTextInput();
      }
    });
    ta.addEventListener('blur', () => {
      const value = ta.value.trim();
      if (value) this.commitTextInput(clientX, clientY);
      else this.closeTextInput();
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    });

    window.setTimeout(() => ta.focus(), 0);
  }

  private commitTextInput(clientX: number, clientY: number): void {
    const engine = this.engine;
    const ta = this.textInput;
    if (!engine || !ta) return;
    const value = ta.value;
    this.closeTextInput();
    if (!value.trim()) return;
    const p = engine.toImage(clientX, clientY);
    engine.addText(p, value);
  }

  private closeTextInput(): void {
    const ta = this.textInput;
    if (!ta) return;
    this.textInput = null;
    ta.remove();
  }

  private setTool(t: ToolName): void {
    this.closeTextInput();
    this.engine?.setTool(t);
  }

  private setColor(c: string): void {
    this.engine?.setColor(c);
    if (this.colorInput) this.colorInput.value = c;
  }

  // ------------------------------------------------------------ 键盘

  private registerScopeKeys(): void {
    const s = this.keyScope;
    s.register(['Mod'], 'z', () => {
      this.engine?.undo();
      return false;
    });
    s.register(['Mod', 'Shift'], 'z', () => {
      this.engine?.redo();
      return false;
    });
    s.register(['Mod'], 'y', () => {
      this.engine?.redo();
      return false;
    });
    s.register(['Mod'], 's', () => {
      void this.save(false);
      return false;
    });
    s.register([], 'Enter', () => {
      const st = this.engine?.state();
      if (st?.cropActive && st.hasCropRect) this.engine?.applyCrop();
      return false;
    });
    s.register([], 'Escape', () => {
      if (this.textInput) this.closeTextInput();
      else if (this.engine?.state().cropActive) this.setTool('pen');
      return false;
    });
    for (const t of TOOLS) {
      if (!t.hotkey) continue;
      s.register([], t.hotkey.toLowerCase(), () => {
        if (this.textInput) return true;
        this.setTool(t.id);
        return false;
      });
    }
  }

  /** 只在本视图处于活动状态时才接管快捷键 */
  private syncScope(): void {
    const active = this.app.workspace.getActiveViewOfType(ImageEditorView) === this;
    if (active && !this.scopePushed) {
      this.app.keymap.pushScope(this.keyScope);
      this.scopePushed = true;
    } else if (!active && this.scopePushed) {
      this.app.keymap.popScope(this.keyScope);
      this.scopePushed = false;
    }
  }

  // ------------------------------------------------------------ 状态同步

  private updateStatus(st: EngineState | null): void {
    if (!st) return;
    this.dirty = st.dirty;

    for (const [id, btn] of this.toolButtons) {
      btn.toggleClass('is-active', id === st.tool);
    }
    this.undoBtn?.toggleClass('is-disabled', !st.canUndo);
    this.redoBtn?.toggleClass('is-disabled', !st.canRedo);
    this.clearBtn?.toggleClass('is-disabled', !st.canUndo);
    this.cropGroup?.toggleClass('is-hidden', !st.cropActive);
    if (this.applyCropBtn) this.applyCropBtn.toggleClass('is-disabled', !st.hasCropRect);
    if (this.styleGroup) {
      const textTool = st.tool === 'text';
      this.styleGroup.toggleClass('is-dim', textTool);
    }

    const size = this.engine?.imageSize ?? { w: 0, h: 0 };
    if (this.statusEl && this.file) {
      this.statusEl.empty();
      this.statusEl.createSpan({
        cls: 'imged-status-name',
        text: `${this.dirty ? '● ' : ''}${this.file.path}`,
      });
      this.statusEl.createSpan({ cls: 'imged-status-dim', text: `${size.w} × ${size.h}` });
      this.statusEl.createSpan({
        cls: 'imged-status-zoom',
        text: `${Math.round(st.zoom * 100)}%`,
      });
      this.statusEl.createSpan({
        cls: 'imged-status-tip',
        text: st.cropActive ? '拖出选区后按 Enter 应用裁剪' : '滚轮缩放 · 空格拖动 · Ctrl+Z 撤销',
      });
    }
    this.updateHeader();
  }

  /** ItemView 没有 titleEl，直接改标签头里的标题节点 */
  private updateHeader(): void {
    const name = this.file ? `${this.dirty ? '*' : ''}${this.file.name}` : '图片编辑器';
    const el = this.containerEl.querySelector<HTMLElement>('.view-header-title');
    if (el) {
      el.textContent = name;
      el.setAttribute('aria-label', name);
    }
  }

  // ------------------------------------------------------------ 保存

  async save(asCopy: boolean): Promise<void> {
    const engine = this.engine;
    const file = this.file;
    if (!engine || !file || !engine.ready) return;
    this.closeTextInput();

    try {
      const buf = await engine.exportArrayBuffer();
      if (asCopy) {
        const target = this.uniquePath(file.path.replace(/\.[^.]+$/, '') + '-edited.png');
        await this.app.vault.createBinary(target, buf);
        new Notice(`已另存为 ${target}`, 5000);
        return;
      }

      if (file.extension.toLowerCase() === 'png') {
        await this.app.vault.modifyBinary(file, buf);
        new Notice(`已替换原图：${file.name}`, 4000);
      } else {
        const newPath = file.path.replace(/\.[^.]+$/, '') + '.png';
        let target = this.app.vault.getAbstractFileByPath(newPath);
        if (target instanceof TFile) {
          await this.app.vault.modifyBinary(target, buf);
        } else {
          target = await this.app.vault.createBinary(newPath, buf);
        }
        const changed = await this.relinkImages(file, target as TFile);
        new Notice(
          `原图非 PNG，已另存为 ${(target as TFile).name} 并更新 ${changed} 处链接`,
          8000
        );
        if (this.plugin.settings.deleteOriginalAfterConvert) {
          await this.app.vault.trash(file, false);
        }
        this.file = target as TFile;
        await this.loadFile(this.file);
      }

      engine.markSaved();
      this.dirty = false;
      this.updateHeader();
      if (this.plugin.settings.closeAfterSave) {
        this.leaf.detach();
      }
    } catch (err) {
      console.error(err);
      new Notice(`保存失败：${(err as Error).message}`, 8000);
    }
  }

  private uniquePath(base: string): string {
    const dot = base.lastIndexOf('.');
    const stem = base.slice(0, dot);
    const ext = base.slice(dot);
    let p = base;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(p)) {
      p = `${stem}-${i}${ext}`;
      i += 1;
    }
    return p;
  }

  /** 把全库里指向 oldFile 的图片链接改指向 newFile */
  private async relinkImages(oldFile: TFile, newFile: TFile): Promise<number> {
    const sources = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const [src, targets] of Object.entries(resolved)) {
      if (Object.prototype.hasOwnProperty.call(targets, oldFile.path)) sources.add(src);
    }
    sources.add(oldFile.path);

    let changed = 0;
    for (const src of sources) {
      const f = this.app.vault.getAbstractFileByPath(src);
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      let did = false;
      await this.app.vault.process(f, (data) => {
        const next = replaceImageLinks(data, oldFile, newFile);
        if (next !== data) did = true;
        return next;
      });
      if (did) changed += 1;
    }
    return changed;
  }
}

// ---------------------------------------------------------------- 工具函数

function makeBtn(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void
): HTMLElement {
  const btn = parent.createEl('button', {
    cls: 'imged-btn',
    attr: { type: 'button', 'aria-label': label },
  });
  btn.innerHTML = iconSvg(icon);
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** 替换 markdown 里指向 oldFile 的 wikilink / markdown link */
export function replaceImageLinks(data: string, oldFile: TFile, newFile: TFile): string {
  const oldPath = oldFile.path;
  const oldBase = oldFile.basename;
  const newPath = newFile.path;
  const alt = `(?:${escapeRegExp(oldPath)}|${escapeRegExp(oldBase)})`;

  // ![[path]] / ![[path|300]] / ![[path#center]] / [[path]]
  const wl = new RegExp(`(!?\\[\\[)\\s*${alt}\\s*((?:[#|][^\\]]*)?\\]\\])`, 'gi');
  let out = data.replace(wl, (_m, pre: string, suffix: string) => `${pre}${newPath}${suffix}`);

  // ![](path) / ![](<path>) / ![](path "title")
  // URL 里可能含空格（未编码），所以先把整段括号内容取出来再解析
  const ml = /(!?\[[^\]]*\]\()([^)]*)(\))/g;
  out = out.replace(ml, (m, pre: string, inner: string, close: string) => {
    const parsed = splitLinkInner(inner);
    if (!parsed) return m;
    const decoded = safeDecode(parsed.url);
    if (decoded !== oldPath && decoded !== oldBase) return m;
    const rep = parsed.url.includes('%') ? encodePath(newPath) : newPath;
    const body = parsed.bracketed ? `<${rep}>` : rep;
    const title = parsed.title ? ` ${parsed.title}` : '';
    return `${pre}${body}${title}${close}`;
  });
  return out;
}

/** 解析 markdown 链接括号内内容：URL + 可选标题，支持 <带空格路径> 写法 */
function splitLinkInner(
  inner: string
): { url: string; title: string; bracketed: boolean } | null {
  let s = inner.trim();
  let title = '';
  const tm = s.match(/\s+("[^"]*"|'[^']*')$/);
  if (tm) {
    title = tm[1];
    s = s.slice(0, tm.index);
  }
  s = s.trim();
  if (!s) return null;
  let bracketed = false;
  if (s.startsWith('<') && s.endsWith('>')) {
    bracketed = true;
    s = s.slice(1, -1);
  }
  return { url: s, title, bracketed };
}
