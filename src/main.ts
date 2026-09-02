import {
  App,
  FuzzySuggestModal,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from 'obsidian';
import { ImageEditorView, VIEW_TYPE_IMAGE_EDITOR } from './editor-view';
import { iconSvg } from './icons';
import { isImageFile, resolveImageAt, resolveImageAtCursor } from './image-resolver';
import { ToolName } from './types';

export interface ImageEditorSettings {
  defaultTool: ToolName;
  defaultColor: string;
  defaultLineWidth: number;
  defaultFontSize: number;
  closeAfterSave: boolean;
  deleteOriginalAfterConvert: boolean;
  fallbackContextMenu: boolean;
}

export const DEFAULT_SETTINGS: ImageEditorSettings = {
  defaultTool: 'pen',
  defaultColor: '#e9372c',
  defaultLineWidth: 4,
  defaultFontSize: 24,
  closeAfterSave: false,
  deleteOriginalAfterConvert: false,
  fallbackContextMenu: true,
};

const TOOL_LABELS: Record<ToolName, string> = {
  hand: '抓手',
  pen: '画笔',
  line: '直线',
  arrow: '箭头',
  rect: '矩形',
  ellipse: '椭圆',
  text: '文本',
  mosaic: '马赛克',
  crop: '裁剪',
};

export default class ImageEditorPlugin extends Plugin {
  settings: ImageEditorSettings = { ...DEFAULT_SETTINGS };

  /** 最近一次右键的现场，供 editor-menu 使用 */
  private lastCtx: { target: EventTarget | null; evt: MouseEvent; time: number } | null = null;
  /** 等待兜底处理的右键请求 */
  private pendingCtx: { file: TFile; time: number } | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_IMAGE_EDITOR, (leaf) => new ImageEditorView(leaf, this));

    // 捕获阶段先记下右键现场，Obsidian 稍后触发 editor-menu 时才能拿到元素
    const onCtxCapture = (evt: MouseEvent) => {
      this.lastCtx = { target: evt.target, evt, time: Date.now() };
    };
    document.addEventListener('contextmenu', onCtxCapture, true);
    this.register(() => document.removeEventListener('contextmenu', onCtxCapture, true));

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, _editor, view) => {
        const mdView = view instanceof MarkdownView ? view : null;
        if (this.tryAddMenuItem(menu, mdView)) this.pendingCtx = null;
      })
    );

    // 阅读模式下 Obsidian 不一定触发 editor-menu，这里兜底往原生菜单里插一项
    const onCtxBubble = (evt: MouseEvent) => {
      if (this.pendingCtx && Date.now() - this.pendingCtx.time < 400) return;
      const file = resolveImageAt(
        this.app,
        evt.target,
        evt,
        this.app.workspace.getActiveViewOfType(MarkdownView)
      );
      if (!file) return;
      this.pendingCtx = { file, time: Date.now() };
      if (!this.settings.fallbackContextMenu) return;
      window.setTimeout(() => this.injectFallbackItem(), 40);
    };
    document.addEventListener('contextmenu', onCtxBubble, false);
    this.register(() => document.removeEventListener('contextmenu', onCtxBubble, false));

    // 文件管理器里右键图片文件
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (file instanceof TFile && isImageFile(file) && file.extension !== 'svg') {
          menu.addItem((item) =>
            item
              .setTitle('编辑图片')
              .setIcon('pencil')
              .onClick(() => void this.openImage(file))
          );
        }
      })
    );

    this.addCommand({
      id: 'edit-image-at-cursor',
      name: '编辑光标处的图片',
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        const file = resolveImageAtCursor(this.app, view);
        if (!file) return false;
        if (!checking) void this.openImage(file);
        return true;
      },
    });

    this.addCommand({
      id: 'edit-image-pick',
      name: '打开图片进行编辑…',
      callback: () => new ImagePickerModal(this.app, this).open(),
    });

    this.addSettingTab(new ImageEditorSettingTab(this.app, this));
  }

  onunload(): void {
    this.pendingCtx = null;
    this.lastCtx = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---------------------------------------------------------------- 菜单

  /** 给 editor-menu 添加「编辑图片」，返回是否命中图片 */
  private tryAddMenuItem(menu: Menu, view: MarkdownView | null): boolean {
    const ctx = this.lastCtx;
    if (!ctx || Date.now() - ctx.time > 1500) return false;
    const file = resolveImageAt(this.app, ctx.target, ctx.evt, view);
    if (!file) return false;
    menu.addItem((item) =>
      item
        .setTitle('编辑图片')
        .setIcon('pencil')
        .onClick(() => void this.openImage(file))
    );
    return true;
  }

  /** 兜底：往已经渲染出来的 Obsidian 菜单 DOM 里追加一项 */
  private injectFallbackItem(): void {
    const pending = this.pendingCtx;
    if (!pending) return;
    const menus = Array.from(document.querySelectorAll<HTMLElement>('.menu'));
    const menu = menus[menus.length - 1];
    if (!menu) return;
    if (menu.querySelector('.imged-menu-item')) return;
    if (Array.from(menu.querySelectorAll('.menu-item-title')).some((e) => e.textContent === '编辑图片')) {
      return;
    }

    const item = document.createElement('div');
    item.className = 'menu-item imged-menu-item';
    const icon = document.createElement('div');
    icon.className = 'menu-item-icon';
    icon.innerHTML = iconSvg('pencil', 16);
    const title = document.createElement('div');
    title.className = 'menu-item-title';
    title.textContent = '编辑图片';
    item.appendChild(icon);
    item.appendChild(title);
    item.addEventListener('click', () => {
      document.body.click();
      void this.openImage(pending.file);
    });
    menu.appendChild(item);
  }

  // ---------------------------------------------------------------- 打开编辑器

  async openImage(file: TFile): Promise<void> {
    if (file.extension.toLowerCase() === 'svg') {
      new Notice('SVG 暂不支持编辑，请先转换为 PNG');
      return;
    }
    if (!isImageFile(file)) {
      new Notice('这不是受支持的图片格式');
      return;
    }

    // 同一张图已开着就直接切过去，避免两份编辑互相覆盖
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_IMAGE_EDITOR)
      .find((l) => (l.view as ImageEditorView | null)?.file?.path === file.path);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }

    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_IMAGE_EDITOR,
      active: true,
      state: { file: file.path },
    });
    const view = leaf.view;
    if (view instanceof ImageEditorView && view.file?.path !== file.path) {
      await view.loadFile(file);
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

// -------------------------------------------------------------------- 选择器

class ImagePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private plugin: ImageEditorPlugin) {
    super(app);
    this.setPlaceholder('选择要编辑的图片');
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => isImageFile(f) && f.extension.toLowerCase() !== 'svg');
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    void this.plugin.openImage(f);
  }
}

// -------------------------------------------------------------------- 设置页

class ImageEditorSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ImageEditorPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('默认工具').addDropdown((d) => {
      for (const [key, label] of Object.entries(TOOL_LABELS)) {
        d.addOption(key, label);
      }
      d.setValue(this.plugin.settings.defaultTool);
      d.onChange((v) => {
        this.plugin.settings.defaultTool = v as ToolName;
        void this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName('默认标注颜色')
      .setDesc('工具栏色板会同步显示该颜色')
      .addColorPicker((c) => {
        c.setValue(this.plugin.settings.defaultColor);
        c.onChange((v) => {
          this.plugin.settings.defaultColor = v;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName('默认线宽').addSlider((s) => {
      s.setLimits(1, 24, 1);
      s.setValue(this.plugin.settings.defaultLineWidth);
      s.setDynamicTooltip();
      s.onChange((v) => {
        this.plugin.settings.defaultLineWidth = v;
        void this.plugin.saveSettings();
      });
    });

    new Setting(containerEl).setName('默认文本字号').addSlider((s) => {
      s.setLimits(12, 72, 2);
      s.setValue(this.plugin.settings.defaultFontSize);
      s.setDynamicTooltip();
      s.onChange((v) => {
        this.plugin.settings.defaultFontSize = v;
        void this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName('保存后自动关闭编辑器')
      .setDesc('点击「完成」替换原图后关闭该标签页')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.closeAfterSave);
        t.onChange((v) => {
          this.plugin.settings.closeAfterSave = v;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('转换格式后删除原图')
      .setDesc('原图不是 PNG 时会另存为 PNG 并更新链接，开启后把原图移入回收站')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.deleteOriginalAfterConvert);
        t.onChange((v) => {
          this.plugin.settings.deleteOriginalAfterConvert = v;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('阅读模式右键菜单兜底')
      .setDesc('阅读模式下 Obsidian 可能不广播右键事件，开启此项会以追加方式补一个「编辑图片」')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.fallbackContextMenu);
        t.onChange((v) => {
          this.plugin.settings.fallbackContextMenu = v;
          void this.plugin.saveSettings();
        });
      });
  }
}
