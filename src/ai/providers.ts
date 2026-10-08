import type { SceneObject } from '../scene/schema';

/**
 * Provider-adapter interfaces. The editor only talks to these, so a hosted
 * provider (OpenAI, Replicate, fal, Runway, ...) can replace a local one without
 * touching the editor. Hosted providers must run server-side so API keys never
 * reach the browser; that server is not part of this MVP.
 */

export type PlanPatch = Partial<Omit<SceneObject, 'id' | 'assetId'>>;

export interface ScenePlan {
  patch: PlanPatch;
  scrollLength?: number;
  summary: string;
}

export interface ScenePlanner {
  id: string;
  plan(prompt: string): Promise<ScenePlan>;
}

export interface BackgroundRemover {
  id: string;
  /** Returns a canvas with transparency applied. */
  remove(source: HTMLCanvasElement): Promise<{ canvas: HTMLCanvasElement; changed: boolean }>;
}

export interface MotionFrameGenerator {
  id: string;
  /** Returns `count` transparent frames as canvases, all the same size. */
  generate(base: HTMLCanvasElement, count: number): Promise<HTMLCanvasElement[]>;
}

export interface ImageGenerator {
  id: string;
  generate(prompt: string): Promise<HTMLCanvasElement>;
}

export interface ImageToVideoGenerator {
  id: string;
  generate(base: HTMLCanvasElement, prompt: string): Promise<HTMLCanvasElement[]>;
}

export interface Upscaler {
  id: string;
  upscale(source: HTMLCanvasElement, factor: number): Promise<HTMLCanvasElement>;
}

export type GenerationMode = 'free' | 'fast' | 'professional' | 'byok';

export interface ProviderSet {
  mode: GenerationMode;
  label: string;
  available: boolean;
  /** Shown to the user when a mode is not available in this build. */
  unavailableReason?: string;
  planner: ScenePlanner;
  backgroundRemover: BackgroundRemover;
  motionFrames: MotionFrameGenerator;
  imageGenerator?: ImageGenerator;
  imageToVideo?: ImageToVideoGenerator;
  upscaler?: Upscaler;
}
