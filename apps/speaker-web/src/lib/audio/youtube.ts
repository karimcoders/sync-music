/**
 * YouTube playback, synchronised honestly.
 *
 * What people actually do is search a song on YouTube, so the app has to
 * handle that. But a web page cannot take the audio out of a YouTube player
 * and send it to other phones — the player is a sandboxed iframe, the stream
 * is protected, and stealing it would break both the browser's rules and
 * YouTube's. Nothing here pretends otherwise.
 *
 * So instead of moving the audio, we move the TIME: every phone opens the
 * same video itself and is told exactly which second to be at, on the same
 * host clock the rest of the app uses. Each phone streams its own copy from
 * YouTube and they play together.
 *
 * The honest consequences:
 *  - every phone needs internet for this (unlike a file, which we hand out
 *    over the local link and which then plays offline);
 *  - alignment is only as good as the YouTube player allows. Its seek lands
 *    on a keyframe, not a sample, so expect a few hundred milliseconds
 *    between phones rather than the few tens we get with a file;
 *  - a video whose owner disabled embedding, or that is age-restricted,
 *    cannot play here at all. The app says so instead of failing silently;
 *  - ads, if YouTube shows them, are shown per phone and will desynchronise
 *    that phone until they finish.
 */

let apiPromise: Promise<void> | null = null;

export function loadYouTubeApi(): Promise<void> {
  if ((window as any).YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    (window as any).onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('YouTube could not be reached'));
    document.head.appendChild(s);
    window.setTimeout(() => reject(new Error('YouTube did not load')), 15000);
  });
  return apiPromise;
}

/** Accepts a full link, a share link, or a bare id. */
export function videoIdFrom(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
    if (m) return m[2];
  } catch { /* not a url */ }
  return null;
}

export const YT_ERRORS: Record<number, string> = {
  2: 'That link does not look like a video.',
  5: 'This phone’s browser cannot play that video.',
  100: 'That video is private or has been removed.',
  101: 'The owner of this video does not allow it to be played inside apps.',
  150: 'The owner of this video does not allow it to be played inside apps.',
};

export interface YtHandle {
  seekTo(seconds: number): void;
  play(): void;
  pause(): void;
  position(): number;
  isPlaying(): boolean;
  setVolume(v: number): void;
  load(videoId: string, at: number): void;
  destroy(): void;
}

/** Create a player in `el`. Resolves once YouTube says it is ready. */
export async function createPlayer(
  el: HTMLElement,
  videoId: string,
  onError: (msg: string) => void,
): Promise<YtHandle> {
  await loadYouTubeApi();
  const YT = (window as any).YT;
  return new Promise<YtHandle>((resolve) => {
    const player = new YT.Player(el, {
      videoId,
      playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => resolve({
          seekTo: (s: number) => { try { player.seekTo(s, true); } catch {} },
          play: () => { try { player.playVideo(); } catch {} },
          pause: () => { try { player.pauseVideo(); } catch {} },
          position: () => { try { return player.getCurrentTime() || 0; } catch { return 0; } },
          isPlaying: () => { try { return player.getPlayerState() === 1; } catch { return false; } },
          setVolume: (v: number) => { try { player.setVolume(Math.round(v * 100)); } catch {} },
          load: (id: string, at: number) => { try { player.loadVideoById(id, at); } catch {} },
          destroy: () => { try { player.destroy(); } catch {} },
        }),
        onError: (e: any) => onError(YT_ERRORS[e?.data] ?? 'YouTube refused to play that video.'),
      },
    });
  });
}
