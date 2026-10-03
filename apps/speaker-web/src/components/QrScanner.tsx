import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Button, Card, Stack } from '../ui';

/**
 * Camera QR scanner for joining a session.
 *
 * Uses the native BarcodeDetector when the browser has it (Chrome on Android)
 * and falls back to decoding frames with jsQR everywhere else, so iPhones work
 * too. The camera stream never leaves the device and is stopped as soon as a
 * code is found or the sheet is closed.
 */
export default function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState('Starting the camera…');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');

    const finish = (text: string) => {
      if (stopped) return;
      stopped = true;
      onResult(text);
    };

    const scan = async () => {
      const video = videoRef.current;
      if (!video || stopped) return;

      // 1) native detector (fast, no decoding in JS)
      const BD = (window as any).BarcodeDetector;
      if (BD) {
        try {
          const det = new BD({ formats: ['qr_code'] });
          const codes = await det.detect(video);
          if (codes?.length && codes[0].rawValue) return finish(codes[0].rawValue);
        } catch { /* fall through to jsQR */ }
      }

      // 2) jsQR fallback
      if (video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (found?.data) return finish(found.data);
        }
      }
      raf = requestAnimationFrame(() => void scan());
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        });
        if (stopped) return;
        const video = videoRef.current!;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        setHint('Point the camera at the host’s QR code');
        void scan();
      } catch (e: any) {
        setError(
          e?.name === 'NotAllowedError'
            ? 'Camera permission was refused. Allow it, or use the link or the code instead.'
            : 'No camera available on this device. Use the link or the code instead.',
        );
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <Card>
      <Stack gap={12}>
        <div className="kicker">Scan the host’s QR code</div>
        {error
          ? <div className="err-text">{error}</div>
          : (
            <div className="scanner">
              <video ref={videoRef} muted playsInline />
              <div className="scanner-frame" />
            </div>
          )}
        <div className="tiny center">{error ? '' : hint}</div>
        <Button variant="ghost" testId="close-scanner" onClick={onClose}>CANCEL</Button>
      </Stack>
    </Card>
  );
}
