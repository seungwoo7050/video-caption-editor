import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BurnInWorkerResponse } from '@/workers/burnInWorker';

import { createCaptionExportSrt } from '../captions/captionIO';

import type { UseBurnInExportParams, UseBurnInExportResult } from './types';

export function useBurnInExport({
  captionDrafts,
  durationMs,
  safeTitleOrId,
  videoBlob,
}: UseBurnInExportParams): UseBurnInExportResult {
  const burnInWorkerRef = useRef<Worker | null>(null);
  const [isBurningIn, setIsBurningIn] = useState(false);
  const [burnInProgress, setBurnInProgress] = useState<number | null>(null);
  const [burnInMessage, setBurnInMessage] = useState<string | null>(null);
  const [burnInError, setBurnInError] = useState<string | null>(null);
  const [burnInResultUrl, setBurnInResultUrl] = useState<string | null>(null);
  const [burnInFileName, setBurnInFileName] = useState<string | null>(null);

  const burnInFontUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URL('/fonts/NotoSansKR-Regular.ttf', window.location.origin).toString();
  }, []);

  const stopBurnInWorker = useCallback(() => {
    const worker = burnInWorkerRef.current;
    if (worker) {
      worker.terminate();
      burnInWorkerRef.current = null;
    }
  }, []);

  const handleCancelBurnIn = useCallback(() => {
    stopBurnInWorker();
    setIsBurningIn(false);
    setBurnInProgress(null);
    setBurnInMessage('번인 내보내기를 취소했어요.');
  }, [stopBurnInWorker]);

  const handleBurnInExport = useCallback(async () => {
    if (!videoBlob) {
      setBurnInError('영상 파일을 찾지 못했어요. 다시 시도해 주세요.');
      return;
    }

    if (!burnInFontUrl) {
      setBurnInError('폰트 파일 경로를 준비하지 못했어요.');
      return;
    }

    const mime = videoBlob.type || '';
    if (!mime.includes('mp4')) {
      setBurnInError('mp4 영상만 번인 내보내기를 지원해요.');
      return;
    }

    if (videoBlob.size > 50 * 1024 * 1024) {
      setBurnInError('50MB 이하의 mp4만 번인 내보내기를 지원해요.');
      return;
    }

    if (typeof durationMs === 'number' && durationMs > 30_000) {
      setBurnInError('길이 30초 이하의 영상을 사용해 주세요.');
      return;
    }

    const srt = createCaptionExportSrt(captionDrafts, { applyTrimOnExport: false, trimRange: null });

    stopBurnInWorker();
    if (burnInResultUrl) {
      URL.revokeObjectURL(burnInResultUrl);
      setBurnInResultUrl(null);
    }

    setBurnInError(null);
    setBurnInProgress(0);
    setBurnInMessage('ffmpeg.wasm을 로드하는 중이에요…');
    setIsBurningIn(true);

    const worker = new Worker(new URL('../../../workers/burnInWorker.ts', import.meta.url), {
      type: 'module',
    });

    burnInWorkerRef.current = worker;
    const requestId = Date.now();

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      stopBurnInWorker();
    }

    const fileName = `${safeTitleOrId}_burnin_${formatNowForFileName()}.mp4`;
    setBurnInFileName(fileName);

    function handleError(errorEvent: ErrorEvent) {
      console.error('[burn-in-worker] crashed', errorEvent);
      setBurnInError('번인 작업 중 오류가 발생했어요. 다시 시도해 주세요.');
      setIsBurningIn(false);
      cleanup();
    }

    function handleMessage(event: MessageEvent<BurnInWorkerResponse>) {
      const data = event.data;
      if (!data || data.requestId !== requestId) return;

      if (data.type === 'progress') {
        if (typeof data.progress === 'number') setBurnInProgress(data.progress);
        if (data.message) setBurnInMessage(data.message);
        return;
      }

      if (data.type === 'done') {
        const blob = new Blob([data.output], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        setBurnInResultUrl(url);
        setBurnInMessage('자막이 포함된 mp4가 준비됐어요.');
        setIsBurningIn(false);
        cleanup();

        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        return;
      }

      if (data.type === 'error') {
        setBurnInError('번인 내보내기에 실패했어요. 잠시 후 다시 시도해 주세요.');
        console.error('[burn-in-worker] error', data.message);
        setIsBurningIn(false);
        cleanup();
      }
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    try {
      const videoBuffer = await videoBlob.arrayBuffer();
      worker.postMessage(
        { type: 'burn-in', requestId, videoData: videoBuffer, srtText: srt, fontUrl: burnInFontUrl },
        [videoBuffer],
      );
    } catch (error) {
      setBurnInError(error instanceof Error ? error.message : '번인 내보내기에 실패했어요.');
      setIsBurningIn(false);
      cleanup();
    }
  }, [burnInFontUrl, burnInResultUrl, captionDrafts, durationMs, safeTitleOrId, stopBurnInWorker, videoBlob]);

  useEffect(() => {
    return () => {
      stopBurnInWorker();
      if (burnInResultUrl) {
        try {
          URL.revokeObjectURL(burnInResultUrl);
        } catch {
          // ignore
        }
      }
    };
  }, [burnInResultUrl, stopBurnInWorker]);

  return {
    burnInError,
    burnInFileName,
    burnInMessage,
    burnInProgress,
    burnInResultUrl,
    handleBurnInExport,
    handleCancelBurnIn,
    isBurningIn,
  };
}

function formatNowForFileName() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}
