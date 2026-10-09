import { planFromPrompt } from '../../src/ai/localPlanner';

export type JobKind = 'motion' | 'image-gen' | 'upscale' | 'design';

/** Canvas shape for Brand Studio designs: logos are square, flyers portrait, banners landscape. */
export type Aspect = 'square' | 'portrait' | 'landscape';
export const ASPECTS: Aspect[] = ['square', 'portrait', 'landscape'];

export const MOTION_STAGES = [
  'Analysing prompt',
  'Preparing image',
  'Removing background',
  'Generating motion',
  'Processing frames',
  'Optimising assets',
  'Building preview',
] as const;
export const STAGES = MOTION_STAGES;

export const stagesFor = (kind: JobKind): readonly string[] =>
  kind === 'image-gen'
    ? ['Preparing image', 'Generating image', 'Optimising assets']
    : kind === 'design'
      ? ['Preparing brief', 'Designing', 'Optimising assets']
      : kind === 'upscale'
      ? ['Preparing image', 'Upscaling', 'Optimising assets']
      : MOTION_STAGES;

export type Mode = 'free' | 'fast' | 'professional' | 'byok';

export const MODES: Record<Mode, { label: string; cost: number }> = {
  free: { label: 'Free', cost: 2 },
  fast: { label: 'Fast', cost: 10 },
  professional: { label: 'Professional', cost: 40 },
  byok: { label: 'Bring your own key', cost: 0 },
};

/** One-off tools. With your own key the platform charges no credits. */
export const TOOLS: Record<Exclude<JobKind, 'motion'>, { label: string; cost: number }> = {
  'image-gen': { label: 'Image generation', cost: 4 },
  upscale: { label: 'Upscale', cost: 6 },
  design: { label: 'Brand design', cost: 6 },
};

export interface StepContext {
  kind: JobKind;
  input: {
    prompt: string;
    keyProvider?: string;
    assetId?: string;
    sourceName?: string;
    scale?: number;
    /** Brand Studio only. */
    aspect?: Aspect;
    transparent?: boolean;
    title?: string;
  };
  state: Record<string, unknown>;
  /** Decrypted user key (when the job uses the user's own key). Providers must never log or return it. */
  apiKey?: string;
  assets: {
    read(assetId: string): Promise<{ bytes: Uint8Array; type: string } | null>;
    putJobFile(name: string, bytes: Uint8Array, type: string): Promise<void>;
    /** Adds an image to the job's project. `hd` marks upscaled images. */
    saveAsset(assetId: string, name: string, bytes: Uint8Array, hd?: boolean): Promise<void>;
  };
}

/** Thrown by a step that has started remote work which is not finished yet. The job is resumed later. */
export class PendingError extends Error {
  constructor(public statePatch: Record<string, unknown> = {}) {
    super('pending');
  }
}

/** One unit of server-side work per stage. Results are merged into the job's saved state. */
export interface ServerProvider {
  id: string;
  /** Which stored key providers this adapter can use for "your own key" jobs. Omit to allow any. */
  keyProviders?: string[];
  /** True when the provider animates or enlarges one of the project's uploaded images. */
  needsImage?: boolean;
  /** True when the server owns a key for this provider, so credits can pay for it. */
  platformKey?: boolean;
  /** Can generate new subject poses, rather than only plan a scroll path. */
  generatesMotion?: boolean;
  step(stage: string, ctx: StepContext): Promise<Record<string, unknown> | void>;
}

/** Free mode: rule-based planning on the server. Image work for this mode runs in the browser. */
export const localRulesProvider: ServerProvider = {
  id: 'local-rules',
  platformKey: true,
  async step(stage, ctx) {
    if (stage === 'Analysing prompt') return { plan: planFromPrompt(ctx.input.prompt) };
  },
};

export type ProviderRegistry = Partial<Record<Mode, ServerProvider>>;
export type ToolRegistry = Partial<Record<Exclude<JobKind, 'motion'>, ServerProvider>>;
export interface Registry {
  modes: ProviderRegistry;
  tools: ToolRegistry;
}

export const defaultProviders: ProviderRegistry = { free: localRulesProvider };
