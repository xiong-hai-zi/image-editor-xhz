/* 用于在 Node 里冒烟测试打包产物：最小可用的 obsidian API 替身 */

function el() {
  const node = {
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    className: '',
    rows: 1,
    value: '',
    scrollHeight: 20,
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    appendChild(c) {
      return c;
    },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createDiv: () => el(),
    createSpan: () => el(),
    createEl: () => el(),
    empty() {},
    addClass() {},
    removeClass() {},
    toggleClass() {},
    hasClass: () => false,
    setText() {},
    setAttr() {},
    focus() {},
    click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => null,
  };
  return node;
}

const noop = () => {};

class Events {
  on() {
    return { id: 1 };
  }
  off() {}
  offref() {}
  trigger() {}
  getActiveViewOfType() {
    return null;
  }
  getLeavesOfType() {
    return [];
  }
  getLeaf() {
    return {
      view: null,
      setViewState: async () => {},
      detach: noop,
    };
  }
  setActiveLeaf() {}
  getActiveFile() {
    return null;
  }
  iterateAllLeaves() {}
}

class Component {
  register(cb) {
    this._cbs = this._cbs || [];
    this._cbs.push(cb);
  }
  registerEvent(evt) {
    return evt;
  }
  registerDomEvent() {}
  onload() {}
  onunload() {}
}

class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = el();
    this.contentEl = el();
  }
  getViewType() {
    return 'view';
  }
  getDisplayText() {
    return 'view';
  }
  getIcon() {
    return 'view';
  }
  async onOpen() {}
  async onClose() {}
  async setState() {}
  getState() {
    return {};
  }
}

class ItemView extends View {
  addAction() {
    return el();
  }
}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  addCommand() {
    return {};
  }
  addRibbonIcon() {
    return el();
  }
  addSettingTab() {}
  registerView(type, factory) {
    this.views = this.views || {};
    this.views[type] = factory;
  }
  async loadData() {
    return {};
  }
  async saveData() {
    await Promise.resolve();
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = el();
  }
  display() {}
}

class Setting {
  constructor(el2) {
    this.containerEl = el2;
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addDropdown(cb) {
    cb({
      addOption() {
        return this;
      },
      setValue() {
        return this;
      },
      onChange: noop,
    });
    return this;
  }
  addColorPicker(cb) {
    cb({
      setValue() {
        return this;
      },
      onChange: noop,
    });
    return this;
  }
  addSlider(cb) {
    cb({
      setLimits() {
        return this;
      },
      setValue() {
        return this;
      },
      setDynamicTooltip() {
        return this;
      },
      onChange: noop,
    });
    return this;
  }
  addToggle(cb) {
    cb({
      setValue() {
        return this;
      },
      onChange: noop,
    });
    return this;
  }
}

class FuzzySuggestModal {
  constructor(app) {
    this.app = app;
  }
  open() {}
  close() {}
  setPlaceholder() {}
}

class Notice {
  constructor(msg) {
    console.log('[Notice]', msg);
  }
}

class Menu {
  addItem(cb) {
    cb({
      setTitle() {
        return this;
      },
      setIcon() {
        return this;
      },
      setSection() {
        return this;
      },
      onClick: noop,
    });
    return this;
  }
}

class Scope {
  register() {}
}

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = (this.name.split('.').pop() || '').toLowerCase();
  }
}

class TFolder {}

class MarkdownView extends ItemView {}

class Modal {
  constructor(app) {
    this.app = app;
  }
  open() {}
  close() {}
}

module.exports = {
  Component,
  View,
  ItemView,
  FileView: ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  FuzzySuggestModal,
  SuggestModal: FuzzySuggestModal,
  Modal,
  Notice,
  Menu,
  Scope,
  TFile,
  TFolder,
  MarkdownView,
  Events,
  setIcon: noop,
  normalizePath: (p) => p,
  Platform: { isDesktop: true },
  makeEl: el,
};
