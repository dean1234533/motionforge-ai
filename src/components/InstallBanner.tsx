import { useEffect, useState } from 'react';
import { canPromptInstall, isInstalled, onInstallChange, platform, promptInstall } from '../lib/install';

const DISMISSED = 'mf-install-dismissed';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

/** Shown after sign-in: how to install MotionForge as an app on this device. */
export function InstallBanner() {
  const [hidden, setHidden] = useState(() => isInstalled() || wasDismissed());
  const [canPrompt, setCanPrompt] = useState(canPromptInstall);
  useEffect(() => onInstallChange(() => {
    setCanPrompt(canPromptInstall());
    if (isInstalled()) setHidden(true);
  }), []);
  if (hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // private browsing: it just shows again next time
    }
    setHidden(true);
  };
  const install = async () => {
    if (await promptInstall()) setHidden(true);
  };

  const p = platform();
  let how: React.ReactNode;
  if (canPrompt) how = 'Install it on this device for one-tap access, full screen, like any other app.';
  else if (p === 'ios') how = <>In Safari, tap the <b>Share</b> button (the square with an arrow), then <b>Add to Home Screen</b>.</>;
  else if (p === 'android') how = <>Open your browser menu (<b>⋮</b>) and choose <b>Install app</b> or <b>Add to Home screen</b>.</>;
  else if (p === 'mac-safari') how = <>In Safari, choose <b>File → Add to Dock</b>.</>;
  else how = <>In Chrome or Edge, click the <b>install</b> icon at the right of the address bar, or open the browser menu and choose <b>Install MotionForge</b>.</>;

  return (
    <aside className="install-banner" aria-label="Install the app">
      <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" width={44} height={44} />
      <div>
        <b>Get the MotionForge app</b>
        <p>{how}</p>
      </div>
      <div className="install-actions">
        {canPrompt && <button type="button" className="btn primary small" onClick={() => void install()}>Install</button>}
        <button type="button" className="btn ghost small" onClick={dismiss}>{canPrompt ? 'Not now' : 'Got it'}</button>
      </div>
    </aside>
  );
}
