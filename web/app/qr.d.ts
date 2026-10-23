// Types for qr.js, so TypeScript tests can import it. The browser loads qr.js itself.
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export function qrMatrix(text: string): QrMatrix;
export function qrMatrixWithMask(text: string, mask: number): QrMatrix;
export function qrSvgPath(text: string, options?: { margin?: number }): { size: number; d: string };
