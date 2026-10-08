import { localBackgroundRemover, localMotionFrames } from './imagePipeline';
import { planFromPrompt } from './localPlanner';
import type { GenerationMode, ProviderSet, ScenePlanner } from './providers';

const localPlanner: ScenePlanner = {
  id: 'local-rules',
  plan: async (prompt) => planFromPrompt(prompt),
};

const NEEDS_SERVER = 'Needs the MotionForge server (accounts, encrypted keys, job queue), which is not part of this version.';

const local = { planner: localPlanner, backgroundRemover: localBackgroundRemover, motionFrames: localMotionFrames };

export const PROVIDER_SETS: Record<GenerationMode, ProviderSet> = {
  free: { mode: 'free', label: 'Free', available: true, ...local },
  fast: { mode: 'fast', label: 'Fast', available: false, unavailableReason: NEEDS_SERVER, ...local },
  professional: { mode: 'professional', label: 'Professional', available: false, unavailableReason: NEEDS_SERVER, ...local },
  byok: { mode: 'byok', label: 'Bring your own key', available: false, unavailableReason: NEEDS_SERVER, ...local },
};

export function getProviders(mode: GenerationMode): ProviderSet {
  const set = PROVIDER_SETS[mode];
  return set.available ? set : PROVIDER_SETS.free;
}
