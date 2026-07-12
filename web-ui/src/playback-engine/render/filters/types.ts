/**
 * Pluggable WebGL video filter interface.
 *
 * Filters are pure GPU passes. They receive the current decoded video frame
 * texture plus any history frames they requested, then draw to the currently
 * bound framebuffer. The renderer owns upload, frame history, intermediate
 * targets, and final presentation to the canvas.
 */

export interface RenderParams {
  /** Source frame width in pixels. */
  width: number;
  /** Source frame height in pixels. */
  height: number;
  /** Which field to keep: 0 = top field (even lines), 1 = bottom field (odd lines). */
  keepField: 0 | 1;
  /**
   * Whether this render is the temporally second field of the frame. Decides
   * which neighboring frames hold the temporally adjacent fields (independent
   * of keepField now that field order can be TFF or BFF).
   */
  isSecondField: boolean;
  /**
   * The texture ring does not hold real history yet (just started / primed
   * while paused) — temporal filtering would see duplicated frames and
   * degenerate to weave. Algorithms must fall back to spatial-only
   * interpolation of the current frame.
   */
  spatialOnly: boolean;
}

export interface VideoFilter {
  readonly name: string;
  /**
   * Number of previous frames the algorithm needs in addition to the current one
   * (passthrough = 0; bwdif = 2).
   */
  readonly historyFrames: number;
  /** Compile shaders / allocate GL resources. Called once per GL context. */
  init(gl: WebGL2RenderingContext): void;
  /**
   * Draw the filtered frame to the bound framebuffer.
   * `textures[0]` is the current frame, `textures[1..]` are history frames
   * (most recent first), at most `historyFrames` of them.
   */
  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: RenderParams): void;
  /** Release GL resources. The context may already be lost; guard accordingly. */
  destroy(gl: WebGL2RenderingContext): void;
}

export type FilterFactory = () => VideoFilter;

const registry = new Map<string, FilterFactory>();

export function registerFilter(name: string, factory: FilterFactory): void {
  registry.set(name, factory);
}

export function createFilter(name: string): VideoFilter | undefined {
  return registry.get(name)?.();
}
