import type { chromaScreenBlob } from './ai/imagePipeline';
import type { extractFrames } from './ai/videoFrames';

declare global {
  /** Short commit id of the build, or "dev". */
  const __BUILD_ID__: string;
  interface Window {
    /** Exposed so browser tests can exercise the video pipeline directly. */
    __mfTools?: { extractFrames: typeof extractFrames; chromaScreenBlob: typeof chromaScreenBlob };
  }
}

export {};
