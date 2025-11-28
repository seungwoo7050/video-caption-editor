import { useCallback, useEffect, useRef } from 'react';

import type { Caption } from '../types';

type UseCaptionFocusOptions = {
  captions: Caption[];
  activeCaptionId: string | null;
  onCaptionFocus?: (captionId: string) => void;
};

export function useCaptionFocus({ captions, activeCaptionId, onCaptionFocus }: UseCaptionFocusOptions) {
  const captionRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const pendingCaptionTextFocusIdRef = useRef<string | null>(null);
  const prevCaptionIdsRef = useRef<string[]>([]);

  const registerCaptionRef = useCallback(
    (captionId: string) => (node: HTMLLIElement | null) => {
      captionRefs.current[captionId] = node;
    },
    [],
  );

  const requestTextFocus = useCallback((captionId: string) => {
    pendingCaptionTextFocusIdRef.current = captionId;
  }, []);
  
  useEffect(() => {
    const prevIds = prevCaptionIdsRef.current;
    const nextIds = captions.map((c) => c.id);

    prevCaptionIdsRef.current = nextIds;

    const prevSet = new Set(prevIds);
    const added = nextIds.filter((id) => !prevSet.has(id));
    if (added.length !== 1) return;

    const newCaptionId = added[0] ?? null;
    if (!newCaptionId) return;

    requestTextFocus(newCaptionId);
  }, [captions, requestTextFocus]);

  useEffect(() => {
    const liveIds = new Set(captions.map((c) => c.id));
    for (const key of Object.keys(captionRefs.current)) {
      if (!liveIds.has(key)) delete captionRefs.current[key];
    }
  }, [captions]);

  useEffect(() => {
    const targetId = pendingCaptionTextFocusIdRef.current;
    if (!targetId) return;

    const focusField = () => {
      const rowEl = captionRefs.current[targetId];
      if (!rowEl) return false;
      const inputEl =
        (rowEl.querySelector('textarea[data-caption-text="true"]') as HTMLElement | null) ??
        (rowEl.querySelector('textarea') as HTMLElement | null) ??
        (rowEl.querySelector('input[type="text"], input:not([type])') as HTMLElement | null);
       if (!inputEl) return false;
 
       inputEl.focus();
      // 가능하면 커서를 끝으로
      if (inputEl instanceof HTMLTextAreaElement) {
        const len = inputEl.value.length;
        inputEl.setSelectionRange(len, len);
      } else if (inputEl instanceof HTMLInputElement && typeof inputEl.select === 'function') {
        inputEl.select();
      }
      pendingCaptionTextFocusIdRef.current = null;
      onCaptionFocus?.(targetId);
      return true;
    };

    if (focusField()) return;

    let tries = 0;
    const tryFocus = () => {
      tries += 1;
      if (focusField()) return;
      if (tries < 8) window.setTimeout(tryFocus, 25);
    };

    window.setTimeout(tryFocus, 0);
  }, [captions, onCaptionFocus]);

  useEffect(() => {
    if (!activeCaptionId) return;
    const target = captionRefs.current[activeCaptionId];
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeCaptionId]);

  return { registerCaptionRef, requestTextFocus };
}
