import { useEffect, useState } from 'react';
import Home from './pages/Home';
import Host from './pages/Host';
import Speaker from './pages/Speaker';
import SoundCheck from './pages/SoundCheck';
import MixerPage from './pages/Mixer';
import HostLogin from './components/HostLogin';
import { isUnlocked } from './lib/auth';

/**
 * Minimal router. Works both when the Node server serves the app at "/" and
 * when a static host serves it under a sub-path (GitHub Pages: /sync-music/).
 * Hash links are supported too, so deep links survive hosts without rewrites.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function currentPath() {
  // "#/host?api=https://…" — keep only the path part.
  if (location.hash.startsWith('#/')) return location.hash.slice(1).split('?')[0].replace(/\/+$/, '') || '/';
  const p = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  return p.replace(/\/+$/, '') || '/';
}

/**
 * The YouTube player needs a real element that exists BEFORE a video is
 * announced, and it must survive page switches — so it lives here, outside
 * the router, and is simply collapsed when there is no video.
 */
function YouTubeMount() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = window.setInterval(
      () => setOn(!!(window as any).__syncClient?.state?.youtubeId), 500);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className={`yt-wrap ${on ? 'on' : ''}`}>
      <div id="yt-host" />
    </div>
  );
}

export default function App() {
  const [path, setPath] = useState(currentPath());
  // The controller is locked away from guests; the gate lives at the route so
  // the player component itself never renders half-mounted.
  const [owner, setOwner] = useState(isUnlocked());
  const mount = <YouTubeMount />;

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

  if (path === '/mixer') return <>{mount}<MixerPage go={go} /></>;
  if (path === '/host') {
    return owner
      ? <>{mount}<Host go={go} /></>
      : <>{mount}<HostLogin go={go} onUnlock={() => setOwner(true)} /></>;
  }
  if (path === '/speaker') return <>{mount}<Speaker go={go} /></>;
  if (path === '/sound') return <>{mount}<SoundCheck go={go} /></>;
  return <>{mount}<Home go={go} /></>;
}
