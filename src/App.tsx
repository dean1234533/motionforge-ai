import { useEffect, useState } from 'react';
import { Docs } from './pages/Docs';
import { Editor } from './pages/Editor';
import { Landing } from './pages/Landing';

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

export function App() {
  const { path, params } = useRoute();
  useEffect(() => window.scrollTo(0, 0), [path]);
  if (path === '/editor') return <Editor initialPrompt={params.get('prompt') ?? ''} />;
  if (path === '/docs') return <Docs />;
  return <Landing />;
}
