import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Card, Row, Stack } from '../ui';

/**
 * Everything a phone needs to join, in one card: the link, a QR code and a
 * short code to type. The QR is rendered locally into a data URL — no external
 * service ever sees the link.
 */
export default function JoinCard({ link, code }: { link: string; code?: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link, { margin: 1, width: 440, color: { dark: '#0b0f14', light: '#ffffff' } })
      .then((d) => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [link]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be blocked */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card>
      <Stack gap={12}>
        <div className="kicker">Invite phones — this link never changes</div>

        <Row>
          <a className="link-strong" data-testid="speaker-link" href={link} target="_blank" rel="noreferrer">{link}</a>
          <button className="chip" data-testid="copy-link" onClick={() => copy(link)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </Row>

        {code && (
          <Row>
            <div>
              <div className="tiny">Or type this code on the speaker page</div>
              <div className="code-pill" data-testid="join-code">{code}</div>
            </div>
            <button className="chip" onClick={() => copy(code)}>Copy code</button>
          </Row>
        )}

        <Button variant="ghost" testId="toggle-qr" onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'HIDE QR CODE' : '📷  SHOW QR CODE'}
        </Button>

        {showQr && (
          <div className="qr-wrap">
            {qr
              ? <img className="qr" data-testid="qr-image" src={qr} alt="QR code for the speaker link" />
              : <div className="tiny">Could not render the QR code — use the link.</div>}
            <div className="tiny center">Point the other phone's camera at this</div>
          </div>
        )}
      </Stack>
    </Card>
  );
}
