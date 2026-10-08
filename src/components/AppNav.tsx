import { useSession } from '../lib/session';

export function AppNav({ current }: { current: 'dashboard' | 'teams' | 'settings' | 'billing' }) {
  const { user, credits, logout } = useSession();
  const link = (id: typeof current, href: string, label: string) => (
    <a href={href} aria-current={current === id ? 'page' : undefined} className={current === id ? 'is-current' : ''}>{label}</a>
  );
  return (
    <header className="nav appnav">
      <a className="brand" href="#/">MotionForge <span>AI</span></a>
      <nav aria-label="Account">
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
