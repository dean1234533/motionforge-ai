import { useEffect, useRef, useState } from 'react';
import { useSession } from '../lib/session';

export function AppNav({ current }: { current: 'dashboard' | 'teams' | 'settings' | 'billing' }) {
  const { user, credits, logout } = useSession();
  // On phones the links fold into a dropdown behind the Menu button; on wider screens they always show.
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const link = (id: typeof current, href: string, label: string) => (
    <a href={href} aria-current={current === id ? 'page' : undefined} className={current === id ? 'is-current' : ''} onClick={() => setOpen(false)}>{label}</a>
  );
  return (
    <header className="nav appnav" ref={root}>
      <a className="brand" href="#/">MotionForge <span>AI</span></a>
      <button type="button" className="btn small appnav-toggle" aria-expanded={open} aria-controls="appnav-menu" onClick={() => setOpen((o) => !o)}>
        Menu <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <nav aria-label="Account" id="appnav-menu" className={open ? 'is-open' : ''}>
        {link('dashboard', '#/dashboard', 'Projects')}
        {link('teams', '#/teams', 'Teams')}
        {link('settings', '#/settings', 'Settings')}
        {link('billing', '#/billing', 'Billing')}
        <span className="muted" title={user?.email}>{credits} credits</span>
        <button type="button" className="btn ghost small" onClick={() => void logout()}>Log out</button>
      </nav>
    </header>
  );
}
