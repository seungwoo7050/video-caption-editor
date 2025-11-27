import { useCallback, useEffect, useRef, useState } from 'react';

import type { TrimWorkerResponse } from '@/workers/trimWorker';

import type { UseTrimExportParams, UseTrimExportResult } from './types';

export function useTrimExport({
  applyTrimOnExport,
  effectiveDurationMs,
  normalizedTrimRange,
  safeTitleOrId,
  trimRange,
  videoBlob,
}: UseTrimExportParams): UseTrimExportResult {
  const trimWorkerRef = useRef<Worker | null>(null);
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimProgress, setTrimProgress] = useState<number | null>(null);
  const [trimMessage, setTrimMessage] = useState<string | null>(null);
  const [trimError, setTrimError] = useState<string | null>(null);
  const [trimResultUrl, setTrimResultUrl] = useState<string | null>(null);
  const [trimFileName, setTrimFileName] = useState<string | null>(null);

  const stopTrimWorker = useCallback(() => {
    const worker = trimWorkerRef.current;
    if (worker) {
      worker.terminate();
      trimWorkerRef.current = null;
    }
  }, []);

  const handleCancelTrim = useCallback(() => {
    stopTrimWorker();
    setIsTrimming(false);
    setTrimProgress(null);
    setTrimMessage('구간 mp4 내보내기를 취소했어요.');
  }, [stopTrimWorker]);

  const handleTrimExport = useCallback(async () => {
    if (!applyTrimOnExport) return;

    if (!trimRange) {
      setTrimError('트림 구간을 먼저 선택해 주세요.');
      return;
    }

    if (!videoBlob) {
      setTrimError('영상 파일을 찾지 못했어요. 다시 시도해 주세요.');
      return;
    }

    const mime = videoBlob.type || '';
    if (!mime.includes('mp4')) {
      setTrimError('mp4 영상만 구간 내보내기를 지원해요.');
      return;
    }

    if (videoBlob.size > 50 * 1024 * 1024) {
      setTrimError('50MB 이하의 mp4만 구간 내보내기를 지원해요.');
      return;
    }

    if (typeof effectiveDurationMs !== 'number') {
      setTrimError('영상 길이를 확인한 뒤 다시 시도해 주세요.');
      return;
    }

    if (effectiveDurationMs > 30_000) {
      setTrimError('길이 30초 이하의 영상을 사용해 주세요.');
      return;
    }

    if (!normalizedTrimRange) {
      setTrimError('유효한 트림 구간을 선택해 주세요.');
      return;
    }

    const { trimStart, trimEnd } = normalizedTrimRange;

    stopTrimWorker();
    if (trimResultUrl) {
      URL.revokeObjectURL(trimResultUrl);
      setTrimResultUrl(null);
    }

    setTrimError(null);
    setTrimProgress(0);
    setTrimMessage('ffmpeg.wasm을 로드하는 중이에요…');
    setIsTrimming(true);

    const worker = new Worker(new URL('../../../workers/trimWorker.ts', import.meta.url), {
      type: 'module',
    });

    trimWorkerRef.current = worker;
    const requestId = Date.now();
    const fileName = `${safeTitleOrId}_trim_${Math.round(trimStart)}-${Math.round(trimEnd)}_${formatNowForFileName()}.mp4`;
    setTrimFileName(fileName);

    function cleanup() {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      stopTrimWorker();
    }

    function handleError(errorEvent: ErrorEvent) {
      console.error('[trim-worker] crashed', errorEvent);
      setTrimError('구간 내보내기 중 오류가 발생했어요. 다시 시도해 주세요.');
      setIsTrimming(false);
      cleanup();
    }

    function handleMessage(event: MessageEvent<TrimWorkerResponse>) {
      const data = event.data;
      if (!data || data.requestId !== requestId) return;

      if (data.type === 'progress') {
        if (typeof data.progress === 'number') setTrimProgress(data.progress);
        if (data.message) setTrimMessage(data.message);
        return;
      }

      if (data.type === 'done') {
        const blob = new Blob([data.output], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        setTrimResultUrl(url);
        setTrimMessage('트림된 mp4가 준비됐어요.');
        setIsTrimming(false);
        cleanup();

        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        return;
      }

      if (data.type === 'error') {
        setTrimError('구간 mp4 내보내기에 실패했어요. 잠시 후 다시 시도해 주세요.');
        console.error('[trim-worker] error', data.message);
        setIsTrimming(false);
        cleanup();
      }
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    try {
      const videoBuffer = await videoBlob.arrayBuffer();
      worker.postMessage(
        { type: 'trim', requestId, videoData: videoBuffer, startMs: trimStart, endMs: trimEnd },
        [videoBuffer],
      );
    } catch (error) {
      setTrimError(error instanceof Error ? error.message : '구간 mp4 내보내기에 실패했어요.');
      setIsTrimming(false);
      cleanup();
    }
  }, [
    applyTrimOnExport,
    effectiveDurationMs,
    normalizedTrimRange,
    safeTitleOrId,
    stopTrimWorker,
    trimRange,
    trimResultUrl,
    videoBlob,
  ]);

  useEffect(() => {
    return () => {
      stopTrimWorker();
      if (trimResultUrl) {
        try {
          URL.revokeObjectURL(trimResultUrl);
        } catch {
          // ignore
        }
      }
    };
  }, [stopTrimWorker, trimResultUrl]);

  return {
    handleCancelTrim,
    handleTrimExport,
    isTrimming,
    trimError,
    trimFileName,
    trimMessage,
    trimProgress,
    trimResultUrl,
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
