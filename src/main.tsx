import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './runtime/motionforge-runtime.js';
import { chromaScreenBlob } from './ai/imagePipeline';
import { extractFrames } from './ai/videoFrames';
import { App } from './App';
import { SessionProvider } from './lib/session';
import './styles.css';

window.__mfTools = { extractFrames, chromaScreenBlob };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
