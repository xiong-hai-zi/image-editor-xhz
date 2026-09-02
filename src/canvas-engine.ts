import {
  EngineCallbacks,
  EngineState,
  MosaicShape,
  PenShape,
  PolyShape,
  Pt,
  Rect,
  Shape,
  Snapshot,
  TextShape,
  ToolName,
  nextId,
} from './types';
import {
  canvasFont,
  clamp,
  clampRect,
  hexToRgba,
  normalizeRect,
  rectContains,
  roundRect,
} from './utils';

const MAX_HISTORY = 40;
const MIN_CROP = 4;
const HANDLE_HIT = 9;

type DragMode =
  | null
  | 'pan'
  | 'pan-temp'
  | 'draw'
  | 'crop-new'
  | 'crop-move'
  | 'crop-nw'
  | 'crop-n'
  | 'crop-ne'
  | 'crop-e'
  | 'crop-se'
  | 'crop-s'
  | 'crop-sw'
  | 'crop-w';

/**
 * 图片编辑引擎。
 *
 * 分层设计：
 *  - base      : 当前底图（裁剪会替换成新的 canvas）
 *  - composite : 与底图同尺寸的"成品层"，= base + 所有形状（马赛克需要读取已合成像素）
 *  - canvas    : 屏幕画布，只负责把 composite 按 zoom/pan 画出来
 *
 * 这样所有形状数据都用「图像像素坐标」保存，缩放、裁剪、导出都不会失真。
 */
export class ImageEditorEngine {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: EngineCallbacks;

  private composite: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;

  private shapes: Shape[] = [];
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  private tool: ToolName = 'pen';
  private color = '#e9372c';
  private lineWidth = 4;
  private mosaicBlock = 12;
  private fontSize = 24;
  private useFill = false;

  private zoom = 1;
  private pan: Pt = { x: 0, y: 0 };
  private fitted = false;

  private drag: DragMode = null;
  private dragStart: Pt = { x: 0, y: 0 };
  private panStart: Pt = { x: 0, y: 0 };
  private draft: Shape | null = null;
  private cropRect: Rect | null = null;
  private cropAnchor: Rect | null = null;

  private spaceDown = false;
  private dirty = false;
  private likelyTransparent = true;
  private stageBg = '#26262b';

  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  constructor(host: HTMLElement, callbacks: EngineCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;

    this.canvas = host.createEl('canvas', { cls: 'imged-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
    this.ctx = ctx;

    this.composite = document.createElement('canvas');
    this.base = document.createElement('canvas');
    const cctx = this.composite.getContext('2d');
    if (!cctx) throw new Error('无法创建合成层上下文');
    this.cctx = cctx;

    this.bindEvents();
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 载入一张新图片（会重置全部编辑状态）
   * @param likelyTransparent 图片格式是否可能带透明通道，决定要不要画棋盘格底
   */
  loadImage(img: HTMLImageElement, likelyTransparent = true): void {
    const w = img.naturalWidth;
    const h = img.naturalHeight;

    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    const bctx = this.base.getContext('2d');
    if (!bctx) throw new Error('无法创建底图上下文');
    bctx.drawImage(img, 0, 0);

    this.shapes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.cropRect = null;
    this.draft = null;
    this.dirty = false;
    this.fitted = false;
    this.tool = 'pen';
    this.likelyTransparent = likelyTransparent;
    this.stageBg = readStageBg(this.host);

    this.rebuildComposite();
    this.fit();
    this.emit();
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.remove();
  }

  /** 是否已经载入图片 */
  get ready(): boolean {
    return this.base.width > 0 && this.base.height > 0;
  }

  get imageSize(): { w: number; h: number } {
    return { w: this.base.width, h: this.base.height };
  }

  // ---------------------------------------------------------------- 事件绑定

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return;
      if (!this.fitted && this.canvas.clientWidth > 0 && this.ready) {
        this.fit();
      }
      this.render();
    });
    this.resizeObserver.observe(this.host);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.ready) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.toImage(e.clientX, e.clientY);

    // 中键 / 空格 / 抓手工具 → 平移视图
    if (e.button === 1 || this.spaceDown || this.tool === 'hand') {
      this.drag = 'pan';
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.panStart = { ...this.pan };
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'crop') {
      const handle = this.hitCropHandle(p);
      if (handle) {
        this.drag = handle;
        this.cropAnchor = this.cropRect ? { ...this.cropRect } : null;
      } else if (this.cropRect && rectContains(this.cropRect, p)) {
        this.drag = 'crop-move';
        this.cropAnchor = { ...this.cropRect };
      } else {
        this.drag = 'crop-new';
        this.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
      }
      this.dragStart = p;
      this.render();
      this.emit();
      return;
    }

    if (this.tool === 'text') {
      // 文本交由外部的输入框处理
      this.callbacks.onStateChange?.(this.state());
      return;
    }

    this.drag = 'draw';
    this.dragStart = p;
    this.draft = this.makeDraft(p);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.ready) return;
    const p = this.toImage(e.clientX, e.clientY);

    if (this.drag === 'pan') {
      this.pan.x = this.panStart.x + (e.clientX - this.dragStart.x);
      this.pan.y = this.panStart.y + (e.clientY - this.dragStart.y);
      this.render();
      return;
    }
    if (!this.drag) {
      if (this.tool === 'crop' && this.cropRect) {
        const h = this.hitCropHandle(p);
        this.canvas.style.cursor =
          h ?? (rectContains(this.cropRect, p) ? 'move' : 'crosshair');
      }
      return;
    }

    switch (this.drag) {
      case 'draw':
        if (this.draft) this.updateDraft(this.draft, p);
        break;
      case 'crop-new':
        if (this.cropRect) {
          const r = normalizeRect(this.dragStart, p);
          this.cropRect = clampRect(r, this.base.width, this.base.height);
        }
        break;
      case 'crop-move': {
        if (!this.cropRect || !this.cropAnchor) break;
        const dx = p.x - this.dragStart.x;
        const dy = p.y - this.dragStart.y;
        const moved = { ...this.cropAnchor, x: this.cropAnchor.x + dx, y: this.cropAnchor.y + dy };
        this.cropRect = clampRectKeepSize(moved, this.base.width, this.base.height);
        break;
      }
      default:
        if (this.drag.startsWith('crop-') && this.cropAnchor) {
          this.cropRect = this.resizeCrop(this.drag, this.cropAnchor, p);
        }
        break;
    }
    this.render();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture?.(e.pointerId);
    }

    if (this.drag === 'pan') {
      this.drag = null;
      return;
    }

    if (this.drag === 'crop-new' || this.drag?.startsWith('crop-')) {
      if (this.cropRect && (this.cropRect.w < MIN_CROP || this.cropRect.h < MIN_CROP)) {
        this.cropRect = null;
      }
      this.drag = null;
      this.render();
      this.emit();
      return;
    }

    if (this.drag === 'draw' && this.draft) {
      const shape = this.draft;
      this.draft = null;
      if (this.isValidShape(shape)) {
        this.pushUndo(this.snapshot());
        this.shapes.push(shape);
        // 必须落到合成层，否则下一次 render 只画 composite，形状就"消失"了。
        // 增量绘制即可：马赛克要读的是"当前已合成的像素"，这里刚好满足。
        this.drawShape(this.cctx, shape, true);
        this.dirty = true;
      }
    }
    this.drag = null;
    this.render();
    this.emit();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.ready) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.shiftKey && !e.ctrlKey) {
      this.pan.x -= e.deltaY || e.deltaX;
      this.render();
      return;
    }
    const factor = Math.pow(1.0018, -e.deltaY);
    const next = clamp(this.zoom * factor, 0.02, 64);
    if (next === this.zoom) return;
    const k = next / this.zoom;
    this.pan.x = sx - (sx - this.pan.x) * k;
    this.pan.y = sy - (sy - this.pan.y) * k;
    this.zoom = next;
    this.fitted = false;
    this.render();
    this.emit();
  };

  // ---------------------------------------------------------------- 坐标变换

  /** 屏幕坐标 → 图像坐标 */
  toImage(clientX: number, clientY: number): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.pan.x) / this.zoom,
      y: (clientY - rect.top - this.pan.y) / this.zoom,
    };
  }

  /** 图像坐标 → 相对 canvas 左上角的 CSS 像素坐标 */
  imageToScreen(p: Pt): Pt {
    return { x: p.x * this.zoom + this.pan.x, y: p.y * this.zoom + this.pan.y };
  }

  // ---------------------------------------------------------------- 视图控制

  fit(): void {
    if (!this.ready) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const zw = w / this.base.width;
    const zh = h / this.base.height;
    this.zoom = clamp(Math.min(zw, zh) * 0.94, 0.02, 64);
    this.center();
    this.fitted = true;
    this.render();
    this.emit();
  }

  actualSize(): void {
    if (!this.ready) return;
    this.zoom = 1;
    this.center();
    this.fitted = false;
    this.render();
    this.emit();
  }

  setZoom(z: number): void {
    if (!this.ready) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const next = clamp(z, 0.02, 64);
    const k = next / this.zoom;
    this.pan.x = cw / 2 - (cw / 2 - this.pan.x) * k;
    this.pan.y = ch / 2 - (ch / 2 - this.pan.y) * k;
    this.zoom = next;
    this.fitted = false;
    this.render();
    this.emit();
  }

  private center(): void {
    this.pan.x = (this.canvas.clientWidth - this.base.width * this.zoom) / 2;
    this.pan.y = (this.canvas.clientHeight - this.base.height * this.zoom) / 2;
  }

  // ---------------------------------------------------------------- 工具属性

  setTool(tool: ToolName): void {
    this.tool = tool;
    if (tool !== 'crop') this.cropRect = null;
    this.updateCursor();
    this.render();
    this.emit();
  }

  getTool(): ToolName {
    return this.tool;
  }

  setColor(c: string): void {
    this.color = c;
  }

  setLineWidth(w: number): void {
    this.lineWidth = clamp(w, 1, 64);
  }

  setFontSize(s: number): void {
    this.fontSize = clamp(s, 8, 200);
  }

  setFill(v: boolean): void {
    this.useFill = v;
  }

  setSpaceDown(v: boolean): void {
    this.spaceDown = v;
    this.updateCursor();
  }

  private updateCursor(): void {
    if (this.spaceDown || this.tool === 'hand') this.canvas.style.cursor = 'grab';
    else if (this.tool === 'crop' || this.tool === 'text') this.canvas.style.cursor = 'crosshair';
    else this.canvas.style.cursor = 'crosshair';
  }

  // ---------------------------------------------------------------- 编辑操作

  /** 在指定图像坐标处落一个文本标注 */
  addText(at: Pt, text: string): void {
    const trimmed = text.replace(/\s+$/g, '');
    if (!trimmed) return;
    this.pushUndo(this.snapshot());
    const shape: TextShape = {
      id: nextId(),
      type: 'text',
      at,
      text: trimmed,
      size: this.fontSize,
      color: this.color,
      width: 0,
    };
    this.shapes.push(shape);
    this.drawShape(this.cctx, shape, true);
    this.dirty = true;
    this.render();
    this.emit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.applySnapshot(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.applySnapshot(next);
  }

  clearShapes(): void {
    if (!this.shapes.length) return;
    this.pushUndo(this.snapshot());
    this.shapes = [];
    this.rebuildComposite();
    this.dirty = true;
    this.render();
    this.emit();
  }

  applyCrop(): void {
    if (!this.cropRect || this.cropRect.w < MIN_CROP || this.cropRect.h < MIN_CROP) return;
    const r = roundRect(clampRect(this.cropRect, this.base.width, this.base.height));
    if (r.w < 1 || r.h < 1) return;

    this.pushUndo(this.snapshot());

    const nb = document.createElement('canvas');
    nb.width = r.w;
    nb.height = r.h;
    const nctx = nb.getContext('2d');
    if (!nctx) return;
    nctx.drawImage(this.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    this.base = nb;

    // 已有标注跟着裁剪框平移
    this.shapes = this.shapes.map((s) => translateShape(s, -r.x, -r.y));

    this.cropRect = null;
    this.dirty = true;
    this.rebuildComposite();
    this.fit();
    this.emit();
  }

  cancelCrop(): void {
    this.cropRect = null;
    this.render();
    this.emit();
  }

  /** 裁剪框选到整幅图 */
  selectAllCrop(): void {
    if (!this.ready) return;
    this.cropRect = { x: 0, y: 0, w: this.base.width, h: this.base.height };
    this.render();
    this.emit();
  }

  // ---------------------------------------------------------------- 历史

  private snapshot(): Snapshot {
    return { base: this.base, shapes: this.shapes.slice() };
  }

  private pushUndo(s: Snapshot): void {
    this.undoStack.push(s);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private applySnapshot(s: Snapshot): void {
    this.base = s.base;
    this.shapes = s.shapes;
    this.cropRect = null;
    this.draft = null;
    this.dirty = true;
    this.rebuildComposite();
    this.render();
    this.emit();
  }

  // ---------------------------------------------------------------- 绘制

  private rebuildComposite(): void {
    if (!this.ready) return;
    if (this.composite.width !== this.base.width || this.composite.height !== this.base.height) {
      this.composite.width = this.base.width;
      this.composite.height = this.base.height;
    }
    const c = this.cctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.composite.width, this.composite.height);
    c.drawImage(this.base, 0, 0);
    for (const s of this.shapes) this.drawShape(c, s, true);
  }

  render(): void {
    if (this.destroyed || !this.ready) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.stageBg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    // 透明底（PNG）用棋盘格示意；不透明格式直接跳过，省下大量 fillRect
    if (this.likelyTransparent) {
      drawChecker(ctx, this.base.width, this.base.height, this.zoom);
    }

    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.composite, 0, 0);

    if (this.draft) {
      if (this.draft.type === 'mosaic') this.drawMosaicDraft(ctx, this.draft);
      else this.drawShape(ctx, this.draft, false);
    }

    if (this.tool === 'crop') this.drawCropOverlay(ctx);

    ctx.restore();
  }

  private drawShape(ctx: CanvasRenderingContext2D, s: Shape, onComposite: boolean): void {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (s.type) {
      case 'pen':
        this.drawPen(ctx, s);
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.b.x, s.b.y);
        ctx.stroke();
        break;
      case 'arrow':
        this.drawArrow(ctx, s);
        break;
      case 'rect':
        this.drawRect(ctx, s);
        break;
      case 'ellipse':
        this.drawEllipse(ctx, s);
        break;
      case 'text':
        this.drawText(ctx, s);
        break;
      case 'mosaic':
        if (onComposite) this.drawMosaic(ctx, s);
        else this.drawMosaicDraft(ctx, s);
        break;
    }
    ctx.restore();
  }

  private drawPen(ctx: CanvasRenderingContext2D, s: PenShape): void {
    const pts = s.points;
    if (!pts.length) return;
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  private drawArrow(ctx: CanvasRenderingContext2D, s: PolyShape): void {
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
    const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    const len = Math.max(10, s.width * 3.6);
    const spread = Math.PI / 7;
    ctx.beginPath();
    ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - len * Math.cos(ang - spread), s.b.y - len * Math.sin(ang - spread));
    ctx.lineTo(s.b.x - len * Math.cos(ang + spread), s.b.y - len * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
  }

  private drawRect(ctx: CanvasRenderingContext2D, s: PolyShape): void {
    const r = normalizeRect(s.a, s.b);
    if (s.fill) {
      ctx.fillStyle = hexToRgba(s.color, 0.25);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = s.color;
    }
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  private drawEllipse(ctx: CanvasRenderingContext2D, s: PolyShape): void {
    const r = normalizeRect(s.a, s.b);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    if (s.fill) {
      ctx.fillStyle = hexToRgba(s.color, 0.25);
      ctx.fill();
      ctx.fillStyle = s.color;
    }
    ctx.stroke();
  }

  private drawText(ctx: CanvasRenderingContext2D, s: TextShape): void {
    ctx.font = canvasFont(s.size);
    ctx.textBaseline = 'top';
    const lines = s.text.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, s.at.x, s.at.y + i * s.size * 1.35);
    });
  }

  /** 马赛克：把区域缩小再放大，得到像素块效果（只能作用在合成层上） */
  private drawMosaic(ctx: CanvasRenderingContext2D, s: MosaicShape): void {
    const r = normalizeRect(s.a, s.b);
    if (r.w < 2 || r.h < 2) return;
    const bw = Math.max(1, Math.round(r.w / s.block));
    const bh = Math.max(1, Math.round(r.h / s.block));
    const tmp = document.createElement('canvas');
    tmp.width = bw;
    tmp.height = bh;
    const t = tmp.getContext('2d');
    if (!t) return;
    t.imageSmoothingEnabled = true;
    t.imageSmoothingQuality = 'high';
    t.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, bw, bh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, bw, bh, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /** 拖拽过程中的马赛克只画一个提示框 */
  private drawMosaicDraft(ctx: CanvasRenderingContext2D, s: MosaicShape): void {
    const r = normalizeRect(s.a, s.b);
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1 / this.zoom;
    ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  private drawCropOverlay(ctx: CanvasRenderingContext2D): void {
    const W = this.base.width;
    const H = this.base.height;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    if (this.cropRect) {
      const r = this.cropRect;
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fill('evenodd');

      // 三分参考线
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / this.zoom;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(r.x + (r.w * i) / 3, r.y);
        ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
        ctx.moveTo(r.x, r.y + (r.h * i) / 3);
        ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
      }
      ctx.stroke();

      // 选框
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      // 手柄
      const hs = 9 / this.zoom;
      ctx.fillStyle = '#ffffff';
      for (const h of HANDLES) {
        const p = handlePoint(r, h);
        ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1 / this.zoom;
        ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      }
    } else {
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 草稿形状

  private makeDraft(p: Pt): Shape | null {
    const common = { id: nextId(), color: this.color, width: this.lineWidth };
    switch (this.tool) {
      case 'pen':
        return { ...common, type: 'pen', points: [p] };
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        return { ...common, type: this.tool, a: p, b: p, fill: this.useFill };
      case 'mosaic':
        return { ...common, type: 'mosaic', a: p, b: p, block: this.mosaicBlock };
      default:
        return null;
    }
  }

  private updateDraft(s: Shape, p: Pt): void {
    switch (s.type) {
      case 'pen':
        s.points.push(p);
        break;
      case 'mosaic':
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse':
        s.b = p;
        break;
      default:
        break;
    }
  }

  private isValidShape(s: Shape): boolean {
    switch (s.type) {
      case 'pen':
        // 单击一下也应该留下一个圆点
        return s.points.length >= 1;
      case 'text':
        return s.text.trim().length > 0;
      default: {
        const r = normalizeRect(s.a, s.b);
        return r.w > 1 || r.h > 1;
      }
    }
  }

  // ---------------------------------------------------------------- 裁剪框

  private hitCropHandle(p: Pt): DragMode {
    if (!this.cropRect) return null;
    const tol = HANDLE_HIT / this.zoom;
    for (const h of HANDLES) {
      const hp = handlePoint(this.cropRect, h);
      if (Math.abs(p.x - hp.x) <= tol && Math.abs(p.y - hp.y) <= tol) {
        return `crop-${h}` as DragMode;
      }
    }
    return null;
  }

  private resizeCrop(mode: string, anchor: Rect, p: Pt): Rect {
    const dir = mode.replace('crop-', '');
    let left = anchor.x;
    let top = anchor.y;
    let right = anchor.x + anchor.w;
    let bottom = anchor.y + anchor.h;
    // 方向名由 n/s/e/w 组合而成，逐边判断即可
    if (dir.includes('w')) left = p.x;
    if (dir.includes('e')) right = p.x;
    if (dir.includes('n')) top = p.y;
    if (dir.includes('s')) bottom = p.y;
    const r = normalizeRect({ x: left, y: top }, { x: right, y: bottom });
    return clampRect(r, this.base.width, this.base.height);
  }

  // ---------------------------------------------------------------- 状态与导出

  state(): EngineState {
    return {
      dirty: this.dirty,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      zoom: this.zoom,
      tool: this.tool,
      cropActive: this.tool === 'crop',
      hasCropRect:
        !!this.cropRect && this.cropRect.w >= MIN_CROP && this.cropRect.h >= MIN_CROP,
    };
  }

  getZoom(): number {
    return this.zoom;
  }

  private emit(): void {
    this.callbacks.onStateChange?.(this.state());
  }

  markSaved(): void {
    this.dirty = false;
    this.emit();
  }

  /** 导出为 PNG Blob */
  exportBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.composite.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('图片导出失败'))),
        'image/png'
      );
    });
  }

  async exportArrayBuffer(): Promise<ArrayBuffer> {
    const blob = await this.exportBlob();
    return await blob.arrayBuffer();
  }
}

// -------------------------------------------------------------------- 辅助

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

function handlePoint(r: Rect, h: (typeof HANDLES)[number]): Pt {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  switch (h) {
    case 'nw':
      return { x: r.x, y: r.y };
    case 'n':
      return { x: cx, y: r.y };
    case 'ne':
      return { x: x2, y: r.y };
    case 'e':
      return { x: x2, y: cy };
    case 'se':
      return { x: x2, y: y2 };
    case 's':
      return { x: cx, y: y2 };
    case 'sw':
      return { x: r.x, y: y2 };
    case 'w':
      return { x: r.x, y: cy };
  }
}

function clampRectKeepSize(r: Rect, W: number, H: number): Rect {
  const x = clamp(r.x, 0, Math.max(0, W - r.w));
  const y = clamp(r.y, 0, Math.max(0, H - r.h));
  return { x, y, w: r.w, h: r.h };
}

function translateShape(s: Shape, dx: number, dy: number): Shape {
  const t = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  switch (s.type) {
    case 'pen':
      return { ...s, points: s.points.map(t) };
    case 'text':
      return { ...s, at: t(s.at) };
    default:
      return { ...s, a: t(s.a), b: t(s.b) };
  }
}

/** 读取画布背景色（主题切换后重新载入图片时会刷新） */
function readStageBg(host: HTMLElement): string {
  const v = getComputedStyle(host).getPropertyValue('--imged-stage-bg').trim();
  return v || '#26262b';
}

/**
 * 透明区域的棋盘格背景。
 * 格子数设了上限，避免大图高倍缩放时每帧画上万个 fillRect。
 */
function drawChecker(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  zoom: number
): void {
  const MAX_CELLS = 80;
  const size = Math.max(8 / zoom, w / MAX_CELLS, h / MAX_CELLS, 0.5);
  const cols = Math.ceil(w / size);
  const rows = Math.ceil(h / size);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d2d2d7';
  for (let j = 0; j < rows; j++) {
    for (let i = j % 2; i < cols; i += 2) {
      ctx.fillRect(
        i * size,
        j * size,
        Math.min(size, w - i * size),
        Math.min(size, h - j * size)
      );
    }
  }
  ctx.restore();
}
