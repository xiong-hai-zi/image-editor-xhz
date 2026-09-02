/** 支持的标注工具 */
export type ToolName =
  | 'hand'
  | 'pen'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'mosaic'
  | 'crop';

/** 图像坐标系中的点（单位 = 原始图片像素） */
export interface Pt {
  x: number;
  y: number;
}

/** 图像坐标系中的矩形 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShapeBase {
  id: string;
  color: string;
  width: number;
}

/** 自由画笔 */
export interface PenShape extends ShapeBase {
  type: 'pen';
  points: Pt[];
}

/** 两点式图形：直线 / 箭头 / 矩形 / 椭圆 */
export interface PolyShape extends ShapeBase {
  type: 'line' | 'arrow' | 'rect' | 'ellipse';
  a: Pt;
  b: Pt;
  fill: boolean;
}

/** 文本 */
export interface TextShape extends ShapeBase {
  type: 'text';
  at: Pt;
  text: string;
  size: number;
}

/** 马赛克 */
export interface MosaicShape extends ShapeBase {
  type: 'mosaic';
  a: Pt;
  b: Pt;
  block: number;
}

export type Shape = PenShape | PolyShape | TextShape | MosaicShape;

/** 一次操作前的完整状态快照 */
export interface Snapshot {
  base: HTMLCanvasElement;
  shapes: Shape[];
}

/** 引擎向外回调的运行时状态 */
export interface EngineState {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  tool: ToolName;
  cropActive: boolean;
  hasCropRect: boolean;
}

export interface EngineCallbacks {
  onStateChange?: (state: EngineState) => void;
}

let uid = 0;
export function nextId(): string {
  uid += 1;
  return `s${uid}_${Math.random().toString(36).slice(2, 7)}`;
}

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
  'avif',
];
