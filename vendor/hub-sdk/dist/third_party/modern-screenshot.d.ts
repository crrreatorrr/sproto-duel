// Types for the part of the vendored modern-screenshot 4.7.0 that feedback.ts uses.
export interface DomToCanvasOptions {
  width?: number;
  height?: number;
  scale?: number;
  backgroundColor?: string | null;
  style?: Partial<CSSStyleDeclaration> | null;
  filter?: ((node: Node) => boolean) | null;
  timeout?: number;
  onCloneEachNode?: ((cloned: Node) => void | Promise<void>) | null;
}
export function domToCanvas(node: Node, options?: DomToCanvasOptions): Promise<HTMLCanvasElement>;
