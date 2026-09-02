/**
 * 内联 SVG 图标（stroke 风格，24x24）。
 * 不依赖 lucide 图标集，避免不同 Obsidian 版本图标缺失。
 */
const P: Record<string, string> = {
  move:
    '<path d="M5 9 2 12l3 3"/><path d="M9 5l3-3 3 3"/><path d="M19 9l3 3-3 3"/><path d="M9 19l3 3 3-3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  pencil:
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  minus: '<path d="M5 12h14"/>',
  arrow: '<path d="M7 17h10V7"/><path d="M7 17 17 7"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  mosaic:
    '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  fill:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M21 3v18H3z" fill="currentColor" stroke="none" opacity=".5"/>',
  undo:
    '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo:
    '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>',
  fit: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  actual:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  eraser:
    '<path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.9l9.6-9.6a2 2 0 0 1 2.9 0l5.6 5.6a2 2 0 0 1 0 2.9L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  save:
    '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  copy:
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  selectAll:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>',
};

export function iconSvg(name: keyof typeof P | string, size = 18): string {
  const body = P[name] ?? '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
