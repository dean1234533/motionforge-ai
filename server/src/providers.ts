import { planFromPrompt } from '../../src/ai/localPlanner';

export const STAGES = [
  'Analysing prompt',
  'Preparing image',
  'Removing background',
  'Generating motion',
  'Processing frames',
  'Optimising assets',
  'Building preview',
] as const;

export type Mode = 'free' | 'fast' | 'professional' | 'byok';

export const MODES: Record<Mode, { label: string; cost: number }> = {
  free: { label: 'Free', cost: 2 },
  fast: { label: 'Fast', cost: 10 },
  professional: { label: 'Professional', cost: 40 },
  byok: { label: 'Bring your own key', cost: 0 },
};

export interface StepContext {
  input: { prompt: string; keyProvider?: string; assetId?: string };
  state: Record<string, unknown>;
  /** Decrypted user key (bring-your-own-key mode only). Providers must never log or return it. */
  apiKey?: string;
  assets: {
    read(assetId: string): Promise<{ bytes: Uint8Array; type: string } | null>;
    putJobFile(name: string, bytes: Uint8Array, type: string): Promise<void>;
  };
}

/** Thrown by a step that has started remote work which is not finished yet. The job is resumed later. */
export class PendingError extends Error {
  constructor(public statePatch: Record<string, unknown> = {}) {
    super('pending');
  }
}

/** One unit of server-side generation work per stage. Results are merged into the job's saved state. */
export interface ServerProvider {
  id: string;
  /** For bring-your-own-key mode: which stored key providers this adapter can use. Omit to allow any. */
  keyProviders?: string[];
  /** True when the provider animates one of the project's uploaded images. */
  needsImage?: boolean;
  step(stage: (typeof STAGES)[number], ctx: StepContext): Promise<Record<string, unknown> | void>;
}

/** Free mode: rule-based planning on the server. Image work for this mode runs in the browser. */
export const localRulesProvider: ServerProvider = {
  id: 'local-rules',
  async step(stage, ctx) {
    if (stage === 'Analysing prompt') return { plan: planFromPrompt(ctx.input.prompt) };
  },
};

export type ProviderRegistry = Partial<Record<Mode, ServerProvider>>;

export const defaultProviders: ProviderRegistry = { free: localRulesProvider };
