'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { VIEWER } from '@/lib/game/constants';
import { loadCorsImage, resolveImageUrl } from '@/lib/mapillary/client';
import { EquirectViewer } from '@/lib/viewer/equirect';

interface Props {
  imageId: string;
  /**
   * Degrees clockwise from the panorama's forward direction to open facing.
   * Easy rounds pass the bearing to their landmark; every other round omits it
   * and opens straight ahead.
   */
  initialYaw?: number;
}

type Status = 'loading' | 'ready' | 'flat' | 'error';

/**
 * Resolves a Mapillary image ID and renders it as a pannable 360 panorama.
 *
 * If WebGL is unavailable or the texture upload fails, this falls back to a
 * plain <img> rather than blocking the turn - a flat view is harder to guess
 * from, but a broken turn would be worse.
 */
export default function PanoramaViewer({ imageId, initialYaw = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EquirectViewer | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [flatUrl, setFlatUrl] = useState('');

  // Kept here rather than in the viewer so the choice survives the next round:
  // the viewer is rebuilt for every location, and a player who paused the sweep
  // should not have it start again on them every turn.
  //
  // The initial value is read from the media query rather than from config
  // alone: a visitor whose system asks for reduced motion has told their whole
  // browser not to animate at them, which outranks this app's default. They can
  // still press play. Read lazily so the static export's first render matches
  // the server's - `matchMedia` does not exist during prerender.
  const [autoPan, setAutoPan] = useState(() => {
    if (!VIEWER.autoPanOnByDefault) return false;
    if (!VIEWER.respectsReducedMotion) return true;
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  const autoPanRef = useRef(autoPan);
  autoPanRef.current = autoPan;

  useEffect(() => {
    const controller = new AbortController();
    let viewer: EquirectViewer | null = null;
    let cancelled = false;

    setStatus('loading');
    setMessage('');
    setFlatUrl('');

    (async () => {
      try {
        const url = await resolveImageUrl(imageId, controller.signal);
        const image = await loadCorsImage(url, controller.signal);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        try {
          viewer = new EquirectViewer(canvas, {
            initialBearingDeg: initialYaw,
            autoPanDegreesPerSecond: VIEWER.autoPanDegreesPerSecond,
          });
          viewer.setImage(image);
          // The viewer stops panning by itself when the player grabs the view,
          // so the button has to hear about it or it would lie.
          viewer.onAutoPanChange = (panning) => setAutoPan(panning);
          viewer.setAutoPan(autoPanRef.current);
          viewerRef.current = viewer;
          setStatus('ready');
        } catch (glError) {
          // WebGL missing, blocked, or the image tainted the upload canvas.
          console.warn('Panorama viewer fell back to a flat image:', glError);
          setFlatUrl(url);
          setStatus('flat');
        }
      } catch (error) {
        if (cancelled || (error as Error)?.name === 'AbortError') return;
        setMessage((error as Error)?.message ?? 'Could not load this panorama.');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      viewer?.destroy();
      viewerRef.current = null;
    };
    // autoPan is deliberately NOT a dependency: it is applied through the ref
    // above and by the effect below, because listing it here would tear down the
    // viewer and refetch the panorama every time the button was pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, initialYaw]);

  useEffect(() => {
    viewerRef.current?.setAutoPan(autoPan);
  }, [autoPan]);

  useEffect(() => {
    const onResize = () => viewerRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleAutoPan = useCallback(() => setAutoPan((on) => !on), []);

  return (
    <div className="viewer">
      <canvas ref={canvasRef} style={{ display: status === 'ready' ? 'block' : 'none' }} />

      {status === 'loading' && (
        <div className="viewer-message">
          <div className="spinner" />
          <span>Finding somewhere in the world…</span>
        </div>
      )}

      {status === 'flat' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="viewer-fallback" src={flatUrl} alt="Street-level view of an unidentified location" />
      )}

      {status === 'error' && (
        <div className="viewer-message">
          <span>Could not load this panorama.</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{message}</span>
        </div>
      )}

      {status === 'ready' && (
        <>
          <button
            type="button"
            className={`auto-pan-button${autoPan ? ' active' : ''}`}
            aria-pressed={autoPan}
            aria-label={autoPan ? 'Pause the slow pan' : 'Slowly pan around'}
            title={autoPan ? 'Pause the slow pan' : 'Slowly pan around'}
            onClick={toggleAutoPan}
          >
            <span aria-hidden="true">{autoPan ? '❚❚' : '▶'}</span>
            <span className="auto-pan-label">{autoPan ? 'Panning' : 'Auto-pan'}</span>
          </button>
          <div className="viewer-hint">Drag to look around · scroll to zoom</div>
        </>
      )}
    </div>
  );
}
