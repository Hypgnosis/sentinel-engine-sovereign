import { useRef, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';

/**
 * SENTINEL ENGINE V4.9-RC — WebGL Performance Monitor
 * ═══════════════════════════════════════════════════════
 * Measures frame rate over a 3-second sliding window.
 * If FPS drops below 20 for 3 consecutive seconds or
 * WebGL fails to initialize within 3s, triggers fallback
 * to the 2D DataGrid.
 *
 * CRITICAL: Uses ONLY useRef for frame metrics.
 * No useState in the render loop per user rules.
 * ═══════════════════════════════════════════════════════
 */

const FPS_THRESHOLD = 20;
const WINDOW_SECONDS = 3;
const SAMPLE_INTERVAL = 0.5; // Sample every 500ms

function WebGLMonitor({ onFallback }) {
  const frameCountRef = useRef(0);
  const lastSampleTimeRef = useRef(0);
  const fpsHistoryRef = useRef([]); // sliding window of FPS samples
  const fallbackTriggeredRef = useRef(false);

  useFrame((state) => {
    if (fallbackTriggeredRef.current) return;

    frameCountRef.current++;
    const elapsed = state.clock.getElapsedTime();

    // Sample FPS at intervals
    if (elapsed - lastSampleTimeRef.current >= SAMPLE_INTERVAL) {
      const fps = frameCountRef.current / SAMPLE_INTERVAL;
      frameCountRef.current = 0;
      lastSampleTimeRef.current = elapsed;

      // Push to sliding window
      fpsHistoryRef.current.push(fps);

      // Keep only last N samples for the window
      const maxSamples = Math.ceil(WINDOW_SECONDS / SAMPLE_INTERVAL);
      if (fpsHistoryRef.current.length > maxSamples) {
        fpsHistoryRef.current.shift();
      }

      // Check if we have enough samples to evaluate
      if (fpsHistoryRef.current.length >= maxSamples) {
        const allBelowThreshold = fpsHistoryRef.current.every(f => f < FPS_THRESHOLD);
        if (allBelowThreshold) {
          fallbackTriggeredRef.current = true;
          console.warn(`[WEBGL_MONITOR] FPS below ${FPS_THRESHOLD} for ${WINDOW_SECONDS}s. Triggering 2D fallback.`);
          onFallback?.();
        }
      }
    }
  });

  return null; // Invisible monitoring component
}

/**
 * Hook that monitors WebGL context initialization time.
 * If the Canvas takes longer than timeoutMs to initialize,
 * calls onFallback.
 *
 * @param {number} timeoutMs - Max allowed init time (default 3000ms)
 * @param {Function} onFallback - Callback when timeout is exceeded
 * @returns {{ canvasReady: React.MutableRefObject<boolean> }}
 */
function useWebGLInitMonitor(timeoutMs = 3000, onFallback) {
  const canvasReady = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    // Start countdown
    timerRef.current = setTimeout(() => {
      if (!canvasReady.current) {
        console.warn(`[WEBGL_MONITOR] Canvas failed to init within ${timeoutMs}ms. Triggering 2D fallback.`);
        onFallback?.();
      }
    }, timeoutMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [timeoutMs, onFallback]);

  const markReady = useCallback(() => {
    canvasReady.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { canvasReady, markReady };
}

export { WebGLMonitor, useWebGLInitMonitor };
