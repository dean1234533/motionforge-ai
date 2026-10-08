import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './runtime/motionforge-runtime.js';
import { App } from './App';
import { SessionProvider } from './lib/session';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
