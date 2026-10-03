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

export function Card({ children, pad = true, style }: { children: ReactNode; pad?: boolean; style?: CSSProperties }) {
  return <section className={pad ? 'card' : 'card flush'} style={style}>{children}</section>;
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
