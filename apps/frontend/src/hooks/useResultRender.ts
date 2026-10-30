import { type RefObject, useEffect } from 'react';
import {
  RENDER_MAX_MS,
  RENDER_MAX_SEQ,
  RENDER_RULE_VERSION,
  RENDER_SCHEMA_VERSION,
  RENDER_THRESHOLD_MS,
  RENDER_VIEWPORT_RATIO,
  type RenderCapability,
  type RenderMeasurement,
  type ResultRenderEvent,
} from '@telesphoros/shared-types';
import { useAuth } from '@/auth/AuthProvider';
import { renderQueueFor } from '@/lib/resultRenders';

/** While an episode continues, a duration row is recorded this often, so a page that dies loses at most this much. */
export const RENDER_CHECKPOINT_MS = 5_000;

interface Path {
  measurement: RenderMeasurement;
  /** The path's own condition (in view, or focus inside), before the tab's visibility. */
  holds: boolean;
  /** When the current uninterrupted interval began, while one runs. */
  since?: number;
  /** All visible time of earlier intervals in this page view, the short ones included. */
  closedMs: number;
  episode?: { id: string; seq: number };
  timer?: ReturnType<typeof setTimeout>;
}

function capabilities(): RenderCapability[] {
  const found: RenderCapability[] = ['page-visibility', 'focus-events'];
  if (typeof IntersectionObserver === 'function') found.unshift('intersection-observer');
  return found;
}

/**
 * Spec 019 D02b: render capture for one result row's recommendation-summary region, under `render-v1` (plan P2, R2). Two paths, each measured on its
 * own: `viewport` (at least half of the region in view, by IntersectionObserver) and `focus` (keyboard or assistive-technology focus inside it), each in a
 * visible tab. One continuous second on a path creates an episode, whose exposure is sent at once; while it continues, duration rows follow in batches,
 * and a last one when it ends. A change of result or patient (a new mount, or new arguments) or of visibility ends it; under one second nothing is sent.
 * It records display, never reading. Failures are never shown and never block the row: a missing event means "unknown".
 *
 * `patientId` is not sent (the server derives it from the result); a change of it only ends the episode, for a view that keeps the row mounted.
 */
export function useResultRender(resultId: string, regionRef: RefObject<HTMLElement | null>, patientId?: string): void {
  const { apiFetch } = useAuth();

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const queue = renderQueueFor(apiFetch);
    const detach = queue.attach();
    const capability = capabilities();
    const viewport: Path = { measurement: 'viewport', holds: false, closedMs: 0 };
    const focus: Path = { measurement: 'focus', holds: region.contains(document.activeElement), closedMs: 0 };
    const paths = capability.includes('intersection-observer') ? [viewport, focus] : [focus];

    const record = (path: Path, now: number, when: 'now' | 'batch') => {
      const episode = path.episode!;
      const continuousMs = Math.min(RENDER_MAX_MS, Math.max(RENDER_THRESHOLD_MS, now - path.since!));
      const event: ResultRenderEvent = {
        episodeId: episode.id,
        seq: episode.seq,
        kind: episode.seq === 0 ? 'exposure' : 'duration',
        resultId,
        measurement: path.measurement,
        ruleVersion: RENDER_RULE_VERSION,
        schemaVersion: RENDER_SCHEMA_VERSION,
        capability,
        occurredAt: new Date(now).toISOString(),
        continuousMs,
        cumulativeMs: Math.min(RENDER_MAX_MS, path.closedMs + continuousMs),
      };
      episode.seq += 1;
      queue.enqueue(event, when);
    };

    const tick = (path: Path) => {
      const now = Date.now();
      if (!path.episode) {
        path.episode = { id: crypto.randomUUID(), seq: 0 };
        record(path, now, 'now'); // the exposure, sent promptly (P4)
      } else if (path.episode.seq <= RENDER_MAX_SEQ) {
        record(path, now, 'batch');
      }
      path.timer = setTimeout(() => tick(path), RENDER_CHECKPOINT_MS);
    };

    const start = (path: Path) => {
      path.since = Date.now();
      path.timer = setTimeout(() => tick(path), RENDER_THRESHOLD_MS);
    };

    const stop = (path: Path, leaving = false) => {
      if (path.since === undefined) return;
      clearTimeout(path.timer);
      const now = Date.now();
      // An episode's last duration row: the time it held, continuous and in all. Sent at once if the page is going away.
      if (path.episode && path.episode.seq <= RENDER_MAX_SEQ) record(path, now, leaving || document.visibilityState === 'hidden' ? 'now' : 'batch');
      path.closedMs += now - path.since;
      path.since = undefined;
      path.episode = undefined;
      path.timer = undefined;
    };

    const update = (path: Path) => {
      const active = path.holds && document.visibilityState === 'visible';
      if (active && path.since === undefined) start(path);
      else if (!active && path.since !== undefined) stop(path);
    };

    let observer: IntersectionObserver | undefined;
    if (capability.includes('intersection-observer')) {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          viewport.holds = entry.isIntersecting && entry.intersectionRatio >= RENDER_VIEWPORT_RATIO;
          update(viewport);
        },
        { threshold: [0, RENDER_VIEWPORT_RATIO, 1] },
      );
      observer.observe(region);
    }
    const onFocusIn = () => {
      focus.holds = true;
      update(focus);
    };
    const onFocusOut = (event: FocusEvent) => {
      focus.holds = event.relatedTarget instanceof Node && region.contains(event.relatedTarget);
      update(focus);
    };
    const onVisibility = () => paths.forEach(update);
    const onPageHide = () => paths.forEach((path) => stop(path, true));
    region.addEventListener('focusin', onFocusIn);
    region.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    update(focus);

    return () => {
      observer?.disconnect();
      region.removeEventListener('focusin', onFocusIn);
      region.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      paths.forEach((path) => stop(path)); // another result or patient, or leaving the page, ends the episode
      detach();
    };
  }, [apiFetch, resultId, patientId, regionRef]);
}
