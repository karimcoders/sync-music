import { useEffect, useState } from 'react';
import Home from './pages/Home';
import Host from './pages/Host';
import Speaker from './pages/Speaker';

/**
 * Minimal router. Works both when the Node server serves the app at "/" and
 * when a static host serves it under a sub-path (GitHub Pages: /sync-music/).
 * Hash links are supported too, so deep links survive hosts without rewrites.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function currentPath() {
  if (location.hash.startsWith('#/')) return location.hash.slice(1);
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  return p.replace(/\/+$/, '') || '/';
}

export default function App() {
  const [path, setPath] = useState(currentPath());

  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);

  const go = (to: string) => {
    const url = `${BASE}${to === '/' ? '/' : to}`;
    history.pushState({}, '', url);
    setPath(to);
    window.scrollTo(0, 0);
  };

  if (path === '/host') return <Host go={go} />;
  if (path === '/speaker') return <Speaker go={go} />;
  return <Home go={go} />;
}
