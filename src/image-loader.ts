import { TFile } from 'obsidian';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  avif: 'image/avif',
};

export function mimeOf(file: TFile): string {
  return MIME[file.extension.toLowerCase()] ?? 'application/octet-stream';
}

/** 把 vault 里的二进制图片解码成 <img>（便于绘制到 canvas） */
export function decodeImage(data: ArrayBuffer, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败，可能是损坏或不受支持的格式'));
    };
    img.src = url;
  });
}
