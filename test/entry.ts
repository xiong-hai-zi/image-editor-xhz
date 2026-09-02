// 仅供测试打包使用：把内部符号暴露出来
export { replaceImageLinks, ImageEditorView, VIEW_TYPE_IMAGE_EDITOR } from '../src/editor-view';
export { ImageEditorEngine } from '../src/canvas-engine';
export { cleanLinkpath, resolveLinkToImage, isImageFile } from '../src/image-resolver';
export { normalizeRect, clampRect, roundRect, hexToRgba, clamp } from '../src/utils';
