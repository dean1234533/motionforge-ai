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
}

export interface MFController {
  update(scene: unknown): void;
  getProgress(): number;
  destroy(): void;
}

export interface MFApi {
  mount(
    host: HTMLElement,
    config: { scene: unknown; assets: Record<string, string[]> },
    options?: { stageHeight?: string },
  ): MFController;
  evaluate(obj: unknown, progress: number): MFPose;
  samplePath(path: MFKeyframe[], t: number): { x: number; y: number };
  sampleArray(a: number[], t: number): number;
  easings: Record<string, (t: number) => number>;
}

declare global {
  interface Window {
    MotionForge: MFApi;
  }
}
