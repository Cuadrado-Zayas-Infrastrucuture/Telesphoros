import { useEffect, useState } from 'react';

const ATTACHMENT_UNDO_MS = 8_000;

/** A just-removed attachment that can be put back. The offer expires after a few seconds unless the pointer or keyboard focus is on it (`pause`). */
export function useRemovedAttachment() {
  const [removed, setRemoved] = useState<File | null>(null);
  const [paused, pause] = useState(false);
  useEffect(() => {
    if (!removed || paused) return;
    const timer = window.setTimeout(() => setRemoved(null), ATTACHMENT_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removed, paused]);
  return {
    removed,
    pause,
    offer: (file: File) => {
      setRemoved(file);
      pause(false);
    },
    discard: () => setRemoved(null),
  };
}
