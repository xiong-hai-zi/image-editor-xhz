import { Pt, Rect } from './types';

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把任意两点拖拽出的区域规整成正向矩形 */
export function normalizeRect(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** 把矩形裁剪到 [0,0,W,H] 范围内 */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const x1 = clamp(r.x, 0, W);
  const y1 = clamp(r.y, 0, H);
  const x2 = clamp(r.x + r.w, 0, W);
  const y2 = clamp(r.y + r.h, 0, H);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 矩形取整，避免裁剪时出现半像素 */
export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const x2 = Math.round(r.x + r.w);
  const y2 = Math.round(r.y + r.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

export function rectContains(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hex;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** canvas 的 font 属性不支持 CSS 变量，这里固定一套字体栈 */
export function canvasFont(size: number, bold = false): string {
  const stack =
    '-apple-system, "Segoe UI", "Segoe UI Emoji", "Microsoft YaHei", "PingFang SC", sans-serif';
  return `${bold ? 'bold ' : ''}${size}px ${stack}`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
