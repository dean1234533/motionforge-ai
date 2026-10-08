import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSession } from './lib/session';
import { Auth } from './pages/Auth';
import { Billing } from './pages/Billing';
import { Dashboard } from './pages/Dashboard';
import { Docs } from './pages/Docs';
import { Editor } from './pages/Editor';
import { Landing } from './pages/Landing';
import { NewProject } from './pages/NewProject';
import { Settings } from './pages/Settings';
import { Share } from './pages/Share';

export function useRoute(): { path: string; params: URLSearchParams } {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    return { path, params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  useEffect(() => {
    if (!loading && !user) window.location.hash = '#/login';
  }, [loading, user]);
  if (loading) return <p className="muted center-text">Loading…</p>;
  if (!user) return null;
  return <>{children}</>;
}

export function App() {
  const { path, params } = useRoute();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  const cloud = path.match(/^\/editor\/([0-9a-f-]{36})$/);
  const share = path.match(/^\/share\/([A-Za-z0-9_-]{16,64})$/);

  if (share) return <Share token={share[1]} />;
  if (cloud) return <RequireAuth><Editor key={cloud[1]} initialPrompt={params.get('prompt') ?? ''} projectId={cloud[1]} /></RequireAuth>;
  switch (path) {
    case '/editor':
      return <Editor initialPrompt={params.get('prompt') ?? ''} />;
    case '/login':
      return <Auth mode="login" />;
    case '/signup':
      return <Auth mode="signup" />;
    case '/dashboard':
      return <RequireAuth><Dashboard /></RequireAuth>;
    case '/new':
      return <RequireAuth><NewProject /></RequireAuth>;
    case '/settings':
      return <RequireAuth><Settings /></RequireAuth>;
    case '/billing':
      return <RequireAuth><Billing status={params.get('status')} /></RequireAuth>;
    case '/docs':
      return <Docs />;
    default:
      return <Landing />;
  }
}
