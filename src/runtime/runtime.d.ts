export interface MFKeyframe {
  progress: number;
  x: number;
  y: number;
}

export interface MFPose {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
  blur: number;
  phase: number;
  cycle: number;
  /** Eased progress through this object's own start/end range (0-1). */
  t: number;
}

export interface MFController {
  update(scene: unknown): void;
  getProgress(): number;
  /** Which renderer is drawing particle effects. */
  info(): { effects: 'webgl' | 'canvas2d'; shapes: 'html' | null; lines: 'svg' | null };
  destroy(): void;
}

export interface MFApi {
  mount(
    host: HTMLElement,
    config: { scene: unknown; assets: Record<string, string[]> },
    options?: { stageHeight?: string; renderer?: 'auto' | 'canvas2d'; preview?: boolean },
  ): MFController;
  evaluate(obj: unknown, progress: number, lookup?: (id: string) => unknown): MFPose;
  samplePath(path: MFKeyframe[], t: number): { x: number; y: number };
  sampleArray(a: number[], t: number): number;
  sampleFrameIndex(phase: number, count: number, playback?: 'once' | 'loop'): number;
  easings: Record<string, (t: number) => number>;
  computeParticles(effect: unknown, pose: MFPose, w: number, h: number, mobileScale?: number): Float32Array;
  chooseRenderer(scene: unknown, glAvailable: boolean): 'webgl' | 'canvas2d';
}

declare global {
  interface Window {
    MotionForge: MFApi;
  }
}
