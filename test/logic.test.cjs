/**
 * 逻辑测试：链接替换正则、路径解析、canvas 引擎交互流程。
 * 运行前先执行 test/bundle 构建（见 package.json 的 test 脚本）。
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const stub = require('./obsidian-stub.cjs');

// --- 带 canvas 能力的 DOM 环境 -------------------------------------------
function makeCtx(canvasNode) {
  // 记录所有被调用过的方法名，用来断言"到底有没有画东西"
  const store = { __calls: [] };
  return new Proxy(store, {
    get(t, k) {
      if (k === 'canvas') return canvasNode;
      if (k in t) return t[k];
      return () => {
        t.__calls.push(String(k));
        return { width: 10, height: 10 };
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

function makeEl() {
  const node = stub.makeEl();
  let cachedCtx = null;
  // 同一个 canvas 复用同一个 ctx，测试才能追踪它的调用记录
  node.getContext = () => {
    if (!cachedCtx) cachedCtx = makeCtx(node);
    return cachedCtx;
  };
  node.toBlob = (cb) => cb(new Blob(['png-bytes'], { type: 'image/png' }));
  // 子元素也要具备 canvas 能力
  node.createEl = () => makeEl();
  node.createDiv = () => makeEl();
  node.createSpan = () => makeEl();
  return node;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};

global.document = {
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  body: makeEl(),
};
global.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const lib = require(path.resolve(__dirname, 'logic.cjs'));

// ==========================================================================
/** 会被视作"真的画了东西"的 canvas 方法 */
const DRAW_CALLS = ['stroke', 'fill', 'strokeRect', 'fillRect', 'fillText', 'drawImage'];

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\n[1] 路径清洗');
check('去掉 app:// 前缀与查询串', () => {
  assert.strictEqual(lib.cleanLinkpath('app://local/abc123/img/pic.png?1'), 'img/pic.png');
});
check('去掉 #尺寸 与 |尺寸', () => {
  assert.strictEqual(lib.cleanLinkpath('img/pic.png#300|200'), 'img/pic.png');
});
check('URL 解码', () => {
  assert.strictEqual(lib.cleanLinkpath('img/my%20photo.png'), 'img/my photo.png');
});

console.log('\n[2] 链接替换（非 PNG 转 PNG 后同步 md 引用）');
{
  const oldF = new stub.TFile('imgs/photo.jpg');
  const newF = new stub.TFile('imgs/photo.png');
  check('wikilink 全路径', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![[imgs/photo.jpg]]', oldF, newF),
      '![[imgs/photo.png]]'
    );
  });
  check('wikilink 短名（basename）', () => {
    assert.strictEqual(lib.replaceImageLinks('![[photo]]', oldF, newF), '![[imgs/photo.png]]');
  });
  check('wikilink 带尺寸参数', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![[imgs/photo.jpg|300]]', oldF, newF),
      '![[imgs/photo.png|300]]'
    );
  });
  check('wikilink 带锚点与参数', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![[imgs/photo.jpg#center|400]]', oldF, newF),
      '![[imgs/photo.png#center|400]]'
    );
  });
  check('markdown 链接', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![](imgs/photo.jpg)', oldF, newF),
      '![](imgs/photo.png)'
    );
  });
  check('markdown 链接带标题', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![说明](imgs/photo.jpg "备注")', oldF, newF),
      '![说明](imgs/photo.png "备注")'
    );
  });
  check('一行内的多处引用都替换', () => {
    assert.strictEqual(
      lib.replaceImageLinks('a ![[photo]] b ![[imgs/photo.jpg]]', oldF, newF),
      'a ![[imgs/photo.png]] b ![[imgs/photo.png]]'
    );
  });
  check('同名不同目录的链接不受影响', () => {
    const src = '![[photos/photo.jpg]]';
    assert.strictEqual(lib.replaceImageLinks(src, oldF, newF), src);
  });
  check('无关图片不受影响', () => {
    const src = '![[imgs/other.png]]';
    assert.strictEqual(lib.replaceImageLinks(src, oldF, newF), src);
  });

  const spOld = new stub.TFile('imgs/my photo.jpg');
  const spNew = new stub.TFile('imgs/my photo.png');
  check('含空格：已编码的 URL 保持编码', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![](imgs/my%20photo.jpg)', spOld, spNew),
      '![](imgs/my%20photo.png)'
    );
  });
  check('含空格：未编码的 URL 保持原样', () => {
    assert.strictEqual(
      lib.replaceImageLinks('![](imgs/my photo.jpg)', spOld, spNew),
      '![](imgs/my photo.png)'
    );
  });
}

console.log('\n[3] 几何工具');
check('normalizeRect 反向拖拽', () => {
  const r = lib.normalizeRect({ x: 10, y: 10 }, { x: 2, y: 4 });
  assert.deepStrictEqual(r, { x: 2, y: 4, w: 8, h: 6 });
});
check('clampRect 不越界', () => {
  const r = lib.clampRect({ x: -5, y: -5, w: 20, h: 20 }, 10, 10);
  assert.deepStrictEqual(r, { x: 0, y: 0, w: 10, h: 10 });
});
check('roundRect 取整', () => {
  const r = lib.roundRect({ x: 1.6, y: 2.4, w: 9.5, h: 8.5 });
  assert.deepStrictEqual(r, { x: 2, y: 2, w: 9, h: 9 });
});
check('hexToRgba', () => {
  assert.strictEqual(lib.hexToRgba('#ffffff', 0.5), 'rgba(255, 255, 255, 0.5)');
});

// ==========================================================================
console.log('\n[4] Canvas 引擎');
{
  const host = makeEl();
  const engine = new lib.ImageEditorEngine(host, {});
  engine.loadImage({ naturalWidth: 800, naturalHeight: 600 });

  check('载入后尺寸正确', () => {
    assert.deepStrictEqual(engine.imageSize, { w: 800, h: 600 });
  });
  check('坐标变换可逆', () => {
    const p = engine.toImage(123, 45);
    const back = engine.imageToScreen(p);
    assert.ok(Math.abs(back.x - 123) < 0.001 && Math.abs(back.y - 45) < 0.001);
  });

  const ev = (x, y, extra) => ({
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerId: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    deltaY: 0,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  });

  check('拖拽绘制矩形 → 产生一条历史', () => {
    engine.setTool('rect');
    engine.onPointerDown(ev(100, 100));
    engine.onPointerMove(ev(200, 200));
    engine.onPointerUp(ev(200, 200));
    assert.strictEqual(engine.state().canUndo, true, '应当可撤销');
    assert.strictEqual(engine.state().dirty, true);
  });
  // 关键回归用例：形状必须真的画进合成层，否则下一次 render 就消失了
  check('画笔笔迹写入合成层', () => {
    const cctx = engine.composite.getContext('2d');
    cctx.__calls.length = 0;
    engine.setTool('pen');
    engine.onPointerDown(ev(120, 120));
    engine.onPointerMove(ev(160, 150));
    engine.onPointerMove(ev(200, 190));
    engine.onPointerUp(ev(200, 190));
    assert.ok(
      cctx.__calls.some((c) => DRAW_CALLS.includes(c)),
      `合成层应收到画笔绘制调用，实际：${[...new Set(cctx.__calls)].join(',') || '（无）'}`
    );
  });
  check('箭头 / 矩形 / 椭圆 / 直线都写入合成层', () => {
    for (const tool of ['arrow', 'rect', 'ellipse', 'line']) {
      const cctx = engine.composite.getContext('2d');
      cctx.__calls.length = 0;
      engine.setTool(tool);
      engine.onPointerDown(ev(100, 100));
      engine.onPointerMove(ev(220, 200));
      engine.onPointerUp(ev(220, 200));
      assert.ok(
        cctx.__calls.some((c) => DRAW_CALLS.includes(c)),
        `${tool} 未写入合成层，实际：${[...new Set(cctx.__calls)].join(',') || '（无）'}`
      );
    }
  });
  check('画笔单击也留下圆点', () => {
    const cctx = engine.composite.getContext('2d');
    cctx.__calls.length = 0;
    engine.setTool('pen');
    engine.onPointerDown(ev(320, 260));
    engine.onPointerUp(ev(320, 260));
    assert.ok(
      cctx.__calls.includes('fill'),
      `单击应写入一个圆点，实际：${[...new Set(cctx.__calls)].join(',') || '（无）'}`
    );
  });
  check('撤销 / 重做切换正常', () => {
    const canUndoBefore = engine.state().canUndo;
    engine.undo();
    assert.strictEqual(engine.state().canRedo, true, '撤销后应可重做');
    engine.redo();
    assert.strictEqual(engine.state().canUndo, canUndoBefore);
    assert.strictEqual(engine.state().canRedo, false);
  });
  check('小于阈值的拖拽不产生形状', () => {
    const before = engine.state().canUndo;
    engine.setTool('rect');
    engine.onPointerDown(ev(100, 100));
    engine.onPointerUp(ev(100, 100));
    assert.strictEqual(engine.state().canUndo, before);
  });
  check('文本标注计入历史', () => {
    engine.addText({ x: 10, y: 10 }, 'hello');
    assert.strictEqual(engine.state().canUndo, true);
  });
  check('裁剪后底图尺寸改变', () => {
    engine.setTool('crop');
    engine.onPointerDown(ev(100, 100));
    engine.onPointerMove(ev(300, 260));
    engine.onPointerUp(ev(300, 260));
    const before = engine.imageSize;
    engine.applyCrop();
    const after = engine.imageSize;
    assert.ok(after.w < before.w && after.h < before.h, `裁剪后应变小：${after.w}x${after.h}`);
    assert.ok(after.w > 0 && after.h > 0);
  });
  check('裁剪可撤销回原尺寸', () => {
    engine.undo();
    assert.deepStrictEqual(engine.imageSize, { w: 800, h: 600 });
  });
  check('滚轮缩放改变 zoom', () => {
    const z0 = engine.getZoom();
    engine.onWheel(ev(400, 300, { deltaY: -240 }));
    assert.ok(engine.getZoom() > z0, 'zoom 应变大');
  });
  check('导出返回 Promise', () => {
    assert.ok(engine.exportArrayBuffer() instanceof Promise);
  });
}

// 异步断言单独跑一次，前面的 check 无法 await
(async () => {
  const host = makeEl();
  const engine = new lib.ImageEditorEngine(host, {});
  engine.loadImage({ naturalWidth: 400, naturalHeight: 300 });
  const buf = await engine.exportArrayBuffer();
  assert.ok(buf instanceof ArrayBuffer && buf.byteLength > 0);
  console.log('  ✓ 导出为 PNG ArrayBuffer（异步）');
  passed += 1;

  console.log(`\n逻辑测试完成：${passed} 项通过`);
  if (process.exitCode) process.exit(process.exitCode);
})().catch((err) => {
  console.error('  ✗ 异步用例失败：', err.message);
  process.exit(1);
});
