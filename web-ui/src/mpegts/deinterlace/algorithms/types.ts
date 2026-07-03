/**
 * Pluggable deinterlacing algorithm interface.
 *
 * The heuristic detector decides *which* algorithm fits the content (e.g. plain
 * combing → bob, telecine → field matching in the future) and the renderer looks
 * the implementation up in the registry by name. Algorithms are pure GPU passes:
 * they receive the current frame texture (plus optional history frames) and draw
 * the deinterlaced result to the currently bound framebuffer (the canvas).
 */

export interface FrameParams {
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

export interface DeinterlaceAlgorithm {
  readonly name: string;
  /**
   * Number of previous frames the algorithm needs in addition to the current one
   * (bob = 0; a future motion-adaptive filter would need 1-2).
   */
  readonly historyFrames: number;
  /** Compile shaders / allocate GL resources. Called once per GL context. */
  init(gl: WebGL2RenderingContext): void;
  /**
   * Draw the deinterlaced frame to the bound framebuffer.
   * `textures[0]` is the current frame, `textures[1..]` are history frames
   * (most recent first), at most `historyFrames` of them.
   */
  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: FrameParams): void;
  /** Release GL resources. The context may already be lost; guard accordingly. */
  destroy(gl: WebGL2RenderingContext): void;
}

export type AlgorithmFactory = () => DeinterlaceAlgorithm;

const registry = new Map<string, AlgorithmFactory>();

export function registerAlgorithm(name: string, factory: AlgorithmFactory): void {
  registry.set(name, factory);
}

export function createAlgorithm(name: string): DeinterlaceAlgorithm | undefined {
  return registry.get(name)?.();
}
