import type { CSSProperties, ReactNode } from 'react';

/* A tiny design system so the host and speaker screens feel like one product. */

export function Shell({ children }: { children: ReactNode }) {
  return <div className="shell">{children}</div>;
}

export function Logo({ sub }: { sub?: string }) {
  return (
    <header className="logo">
      <div className="logo-mark" aria-hidden>
        <span /><span /><span /><span />
      </div>
      <div>
        <div className="logo-word">SYNC MUSIC</div>
        {sub && <div className="logo-sub">{sub}</div>}
      </div>
    </header>
  );
}

export function Card({ children, pad = true, style, className = '' }: { children: ReactNode; pad?: boolean; style?: CSSProperties; className?: string }) {
  return <section className={`${pad ? 'card' : 'card flush'} ${className}`.trim()} style={style}>{children}</section>;
}

export function Row({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="row" style={style}>{children}</div>;
}

export function Stack({ children, gap = 10, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>;
}

type BtnProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  wide?: boolean;
  testId?: string;
};
export function Button({ children, onClick, variant = 'primary', disabled, wide = true, testId }: BtnProps) {
  return (
    <button
      data-testid={testId}
      className={`btn ${variant} ${wide ? 'wide' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Status({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'idle'; children: ReactNode }) {
  return <span className={`pill ${tone}`}><i className="dot" />{children}</span>;
}

export function Meter({ value, buffered = 0 }: { value: number; buffered?: number }) {
  return (
    <div className="meter">
      <i className="buf" style={{ width: `${Math.min(100, buffered)}%` }} />
      <i className="pos" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export function Equalizer({ active }: { active: boolean }) {
  return (
    <div className={`eq ${active ? 'on' : ''}`} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />)}
    </div>
  );
}

/** Big artwork tile: a deterministic gradient per track + live bars. */
export function Artwork({ title, playing }: { title: string; playing: boolean }) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  const bg = `linear-gradient(140deg, hsl(${h} 72% 46%), hsl(${(h + 55) % 360} 78% 32%) 55%, hsl(${(h + 110) % 360} 70% 22%))`;
  return (
    <div className={`artwork ${playing ? 'spinning' : ''}`} style={{ background: bg }} aria-hidden>
      <div className="art-glow" />
      <div className="art-disc"><span /></div>
      <div className={`bars ${playing ? 'on' : ''}`}>
        {Array.from({ length: 18 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 9) * 0.09}s`, animationDuration: `${0.7 + (i % 5) * 0.13}s` }} />
        ))}
      </div>
    </div>
  );
}

/** Scrubbable progress bar: a real range input wearing a nicer coat. */
export function Scrubber({
  value, max, disabled, onPreview, onCommit,
}: {
  value: number; max: number; disabled?: boolean;
  onPreview: (v: number) => void; onCommit: () => void;
}) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="scrub" style={{ ['--p' as any]: `${pct}%` }}>
      <div className="scrub-track"><i style={{ width: `${pct}%` }} /></div>
      <input
        type="range" min={0} max={1000} value={max ? Math.round((value / max) * 1000) : 0}
        disabled={disabled}
        onChange={(e) => onPreview((+e.target.value / 1000) * max)}
        onMouseUp={onCommit} onTouchEnd={onCommit} onKeyUp={onCommit}
        aria-label="Seek"
      />
    </div>
  );
}

/* Inline SVG icons — emoji glyphs render as tofu boxes on many Android fonts. */
const svg = (d: ReactNode, box = 24) => (
  <svg viewBox={`0 0 ${box} ${box}`} width="1.25em" height="1.25em" fill="currentColor" aria-hidden>{d}</svg>
);
export const Icons = {
  play: svg(<path d="M8 5.5v13l11-6.5L8 5.5Z" />),
  pause: svg(<path d="M7 5h3.2v14H7V5Zm6.8 0H17v14h-3.2V5Z" />),
  stop: svg(<rect x="6.5" y="6.5" width="11" height="11" rx="2" />),
  prev: svg(<path d="M7 5h2.4v14H7V5Zm12 .8v12.4L10 12l9-6.2Z" />),
  next: svg(<path d="M14.6 5H17v14h-2.4V5ZM5 5.8 14 12l-9 6.2V5.8Z" />),
  resync: svg(<path d="M12 5a7 7 0 1 0 6.3 3.9l1.7-.9A9 9 0 1 1 12 3v2Zm0-3 4 3-4 3V2Z" />),
  speaker: svg(<path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4v-5Zm11.2-1.1a5 5 0 0 1 0 7.2l-1.3-1.3a3.2 3.2 0 0 0 0-4.6l1.3-1.3Zm2.4-2.5a8.4 8.4 0 0 1 0 12.2l-1.3-1.3a6.6 6.6 0 0 0 0-9.6l1.3-1.3Z" />),
};

/** Round transport button used by the player deck. */
export function RoundBtn({
  children, onClick, size = 'sm', label, disabled, testId,
}: {
  children: ReactNode; onClick?: () => void; size?: 'sm' | 'lg';
  label: string; disabled?: boolean; testId?: string;
}) {
  return (
    <button
      className={`round ${size}`} onClick={onClick} disabled={disabled}
      aria-label={label} title={label} data-testid={testId}
    >{children}</button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const fmtTime = (s: number) => {
  const v = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
