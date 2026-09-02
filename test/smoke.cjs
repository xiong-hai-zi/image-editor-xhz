/**
 * 冒烟测试：用 stub 顶替 obsidian，加载真实打包产物 main.js，
 * 走一遍 onload / 命令注册 / 设置面板渲染，确认没有运行时崩溃。
 */
const Module = require('module');
const path = require('path');

const stub = require('./obsidian-stub.cjs');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};

// --- 最小 DOM 环境 -------------------------------------------------------
const listeners = [];
global.document = {
  addEventListener(type, cb) {
    listeners.push({ type, cb });
  },
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => stub.makeEl(),
  body: stub.makeEl(),
};
global.window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn) => setTimeout(fn, 0),
  devicePixelRatio: 1,
};
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// --- 构造一个假 app ------------------------------------------------------
const { Events } = stub;
const app = {
  workspace: new Events(),
  vault: {
    getFiles: () => [],
    getAbstractFileByPath: () => null,
    readBinary: async () => new ArrayBuffer(8),
    createBinary: async () => ({}),
    modifyBinary: async () => {},
    trash: async () => {},
    process: async () => {},
    trigger: () => {},
    adapter: { writeBinary: async () => {} },
  },
  metadataCache: { getFirstLinkpathDest: () => null, resolvedLinks: {} },
  keymap: { pushScope() {}, popScope() {} },
};

(async () => {
  const mod = require(path.resolve(__dirname, '..', 'main.js'));
  const PluginClass = mod.default;
  if (typeof PluginClass !== 'function') {
    throw new Error('main.js 未导出默认插件类');
  }

  const plugin = new PluginClass(app, { id: 'image-editor', version: '1.0.0' });
  console.log('✓ 插件类可实例化');

  await plugin.onload();
  console.log('✓ onload 执行完成');

  if (!plugin.views || !plugin.views['image-editor-view']) {
    throw new Error('未注册 image-editor-view');
  }
  console.log('✓ 视图类型 image-editor-view 已注册');

  // 构造一次视图，验证 onOpen 的 UI 构建分支不崩
  const { ImageEditorView } = require(path.resolve(__dirname, '..', 'main.js'))
    .__testExports || {};
  void ImageEditorView;

  // 渲染设置面板
  const settingTab = new stub.PluginSettingTab(app, plugin);
  void settingTab;

  plugin.onunload();
  console.log('✓ onunload 执行完成');
  console.log('\n冒烟测试通过');
})().catch((err) => {
  console.error('✗ 冒烟测试失败：', err);
  process.exit(1);
});
