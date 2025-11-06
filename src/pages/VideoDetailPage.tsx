import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { dataSource } from '@/datasource';
import { dataSourceKind } from '@/datasource';
import type { Caption, Video } from '@/datasource/types';
import { captionsToSrt, downloadTextFile, parseCaptionsFromJson, serializeCaptionsToJson } from '@/lib/captionIO';
import { queryClient } from '@/lib/queryClient';
import type { CaptionWorkerRequest, CaptionWorkerResponse } from '@/workers/captionScanner.types';

import type { ChangeEvent, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';

function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

function formatMeta(video: Video) {
  const duration =
    typeof video.durationMs === 'number'
      ? `${Math.round(video.durationMs / 1000)}s`
      : null;
  const resolution =
    typeof video.width === 'number' && typeof video.height === 'number'
      ? `${video.width}x${video.height}`
      : null;

  return [duration, resolution].filter(Boolean).join(' · ');
}

type CaptionErrors = {
  startMs?: string;
  endMs?: string;
  text?: string;
};

function sortCaptions(captions: Caption[]) {
  return [...captions].sort((a, b) => {
    const aStart = Number.isFinite(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
    const bStart = Number.isFinite(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
    return aStart - bStart;
  });
}

function getLastValidEndMs(captions: Caption[]) {
  for (let i = captions.length - 1; i >= 0; i -= 1) {
    const endMs = captions[i]?.endMs;
    if (Number.isFinite(endMs)) return endMs as number;
  }
  return 0;
}

function createCaptionId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `caption_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function snapToStep(ms: number, stepMs: number) {
  if (!Number.isFinite(ms) || stepMs <= 0) return ms;
  return Math.round(ms / stepMs) * stepMs;
}

function formatTimestamp(ms: number) {
  if (!Number.isFinite(ms)) return '--:--.---';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  const milliseconds = Math.abs(ms % 1000)
    .toString()
    .padStart(3, '0');
  return `${minutes}:${seconds}.${milliseconds}`;
}

function getCaptionErrors(caption: Caption): CaptionErrors {
  const errors: CaptionErrors = {};
  const hasStart = Number.isFinite(caption.startMs);
  const hasEnd = Number.isFinite(caption.endMs);

  if (!hasStart) errors.startMs = '시작 시간을 입력하세요.';
  if (!hasEnd) errors.endMs = '종료 시간을 입력하세요.';

  if (hasStart && hasEnd && caption.startMs >= caption.endMs) {
    errors.endMs = '종료 시간은 시작 시간보다 커야 해요.';
  }

  if (!caption.text.trim()) {
    errors.text = '자막 내용을 입력하세요.';
  }

  return errors;
}

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const videoId = id ?? '';
  const [appliedMetadataForId, setAppliedMetadataForId] = useState<string | null>(null);

  const [captionDrafts, setCaptionDrafts] = useState<Caption[]>([]);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [trimRange, setTrimRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [snapStepMs, setSnapStepMs] = useState<100 | 1000>(100);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const trimRangeRef = useRef<{ startMs: number; endMs: number } | null>(null);
  const [dragTarget, setDragTarget] = useState<'start' | 'end' | 'new' | null>(null);

  const {
    data: video,
    isPending: isVideoLoading,
    isError: isVideoError,
  } = useQuery({
    queryKey: ['video', videoId],
    enabled: Boolean(videoId),
    queryFn: async () => {
      const fetched = await dataSource.getVideo(videoId);
      if (!fetched) throw new Error('비디오 정보를 찾을 수 없어요.');
      return fetched;
    },
  });

  const hasExistingMetadata = Boolean(
    video &&
      (typeof video.durationMs === 'number' ||
        typeof video.width === 'number' ||
        typeof video.height === 'number'),
  );
  const hasAppliedMetadata = appliedMetadataForId === videoId;
  const isMetadataReady = hasAppliedMetadata || hasExistingMetadata;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const waveformDataRef = useRef<Uint8Array | null>(null);
  const waveformRafIdRef = useRef<number | null>(null);  
  const captionRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeCaptionId, setActiveCaptionId] = useState<string | null>(null);
  const [lastFocusedCaptionId, setLastFocusedCaptionId] = useState<string | null>(null);
  const timeUpdateRafIdRef = useRef<number | null>(null);

  const captionWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/captionScanner.ts', import.meta.url), {
      type: 'module',
    });
    captionWorkerRef.current = worker;

    const handleMessage = (event: MessageEvent<CaptionWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'activeCaption') {
        setActiveCaptionId((prev) =>
          prev !== message.activeCaptionId ? message.activeCaptionId : prev,
        );
        if (import.meta.env.DEV) console.debug('[worker->main] activeCaption', message);
        return;
      }

      if (message.type === 'log') {
        if (import.meta.env.DEV) console.debug('[worker->main]', message.message);
      }
    };

    worker.addEventListener('message', handleMessage);

    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
      captionWorkerRef.current = null;
    };
  }, []);

  const {
    data: videoBlob,
    error: videoBlobError,
    isPending: isBlobLoading,
  } = useQuery({
    queryKey: ['video-blob', videoId],
    enabled: Boolean(videoId),
    queryFn: async () => {
      const blob = await dataSource.getVideoBlob(videoId);
      if (!blob) throw new Error('영상 파일을 불러올 수 없어요.');
      return blob;
    },
  });

  const {
    data: thumbnailBlob,
    error: thumbnailBlobError,
    isPending: isThumbLoading,
  } = useQuery({
    queryKey: ['thumbnail-blob', videoId],
    enabled: Boolean(videoId),
    queryFn: () => dataSource.getThumbBlob(videoId),
  });  

  const videoUrl = useMemo(() => {
    if (!videoBlob) return null;
    return URL.createObjectURL(videoBlob);
  }, [videoBlob]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const thumbnailUrl = useMemo(() => {
    if (!thumbnailBlob) return null;
    return URL.createObjectURL(thumbnailBlob);
  }, [thumbnailBlob]);

  useEffect(() => {
    return () => {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
  }, [thumbnailUrl]);

  const {
    data: captions,
    isPending: isCaptionsLoading,
    isError: isCaptionsError,
    error: captionsError,
  } = useQuery({
    queryKey: ['captions', videoId],
    enabled: Boolean(videoId),
    queryFn: () => dataSource.listCaptions(videoId),
  });

  useEffect(() => {
    if (captions) {
       
      setCaptionDrafts(sortCaptions(captions));
    }
  }, [captions]);

  useEffect(() => {
    const worker = captionWorkerRef.current;
    if (!worker) return;

    const syncMessage: CaptionWorkerRequest = { type: 'syncCaptions', captions: captionDrafts };
    worker.postMessage(syncMessage);
    if (import.meta.env.DEV) console.debug('[worker<-main] syncCaptions', captionDrafts.length);

    const currentTime = videoRef.current?.currentTime;
    if (Number.isFinite(currentTime)) {
      const scanMessage: CaptionWorkerRequest = {
        type: 'scanActiveCaption',
        currentTimeMs: (currentTime as number) * 1000,
      };
      worker.postMessage(scanMessage);
    }
  }, [captionDrafts]);

  const hasCaptionErrors = useMemo(
    () => captionDrafts.some((c) => Object.keys(getCaptionErrors(c)).length > 0),
    [captionDrafts],
  );

  const {
    mutate: persistCaptions,
    isPending: isSavingCaptions,
    isError: isSaveCaptionsError,
    error: saveCaptionsError,
    reset: resetSaveCaptionsError,
  } = useMutation({
    mutationFn: async (nextCaptions: Caption[]) => {
      const sorted = sortCaptions(nextCaptions);
      await dataSource.saveCaptions(videoId, sorted);
      return sorted;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['captions', videoId], saved);
      setCaptionDrafts(saved);
      setLastSavedAt(Date.now());
    },
  });

  const handleCaptionFieldChange = useCallback(
    (captionId: string, field: keyof Pick<Caption, 'startMs' | 'endMs' | 'text'>, value: string) => {
      resetSaveCaptionsError();
      setImportError(null);
      const nextNumber =
        value.trim() === '' ? Number.NaN : Number(value);
      setCaptionDrafts((prev) =>
        sortCaptions(
          prev.map((caption) =>
            caption.id === captionId
              ? {
                  ...caption,
                  [field]: field === 'text' ? value : nextNumber,
                }
              : caption,
          ),
        ),
      );
    },
    [resetSaveCaptionsError],
  );

  const getCurrentTimeMs = useCallback(() => {
    const video = videoRef.current;
    if (!video) return Number.NaN;

    const currentTimeMs = Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000)
      : Number.NaN;

    return currentTimeMs;
  }, []);

  const handleAddCaption = useCallback(() => {
    resetSaveCaptionsError();
    setImportError(null);
    const nextCaptionId = createCaptionId();
    const currentTimeMs = getCurrentTimeMs();
    setCaptionDrafts((prev) => {
      const startMs = Number.isFinite(currentTimeMs) ? currentTimeMs : getLastValidEndMs(prev);
      const endMs = startMs + 1000;
      const next = [...prev, { id: nextCaptionId, startMs, endMs, text: '' }];
      return sortCaptions(next);
    });
    setLastFocusedCaptionId(nextCaptionId);
  }, [getCurrentTimeMs, resetSaveCaptionsError]);

  const handleSetCaptionTimeFromVideo = useCallback(
    (captionId: string, field: keyof Pick<Caption, 'startMs' | 'endMs'>) => {
      const currentTimeMs = getCurrentTimeMs();
      if (!Number.isFinite(currentTimeMs)) return;

      handleCaptionFieldChange(captionId, field, currentTimeMs.toString());
      setLastFocusedCaptionId(captionId);
    },
    [getCurrentTimeMs, handleCaptionFieldChange],
  );

  const baseFileName = useMemo(() => {
    if (!video) return 'captions';
    const safeTitle = video.title.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_');
    const trimmed = safeTitle.replace(/^_+|_+$/g, '');
    return trimmed || 'captions';
  }, [video]);

  const handleExportJson = useCallback(() => {
    const json = serializeCaptionsToJson(captionDrafts);
    downloadTextFile(`${baseFileName}.json`, json, 'application/json;charset=utf-8');
  }, [baseFileName, captionDrafts]);

  const handleExportSrt = useCallback(() => {
    const srt = captionsToSrt(captionDrafts);
    downloadTextFile(`${baseFileName}.srt`, srt, 'application/x-subrip;charset=utf-8');
  }, [baseFileName, captionDrafts]);

  const handleImportJsonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportJsonFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = parseCaptionsFromJson(text, createCaptionId);
        setCaptionDrafts(sortCaptions(imported));
        setImportError(null);
        resetSaveCaptionsError();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '자막 JSON을 불러오지 못했어요.');
      } finally {
        event.target.value = '';
      }
    },
    [resetSaveCaptionsError],
  );

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const getShortcutTargetCaptionId = useCallback(() => {
    return (
      lastFocusedCaptionId ??
      activeCaptionId ??
      captionDrafts[captionDrafts.length - 1]?.id ??
      null
    );
  }, [activeCaptionId, captionDrafts, lastFocusedCaptionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'A' ||
          target.isContentEditable);
      if (isTypingTarget) return;

      if (event.key === ' ') {
        event.preventDefault();
        togglePlayback();
        return;
      }

      if (event.key === '[') {
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'startMs');
        return;
      }

      if (event.key === ']') {
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'endMs');
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        handleAddCaption();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [getShortcutTargetCaptionId, handleAddCaption, handleSetCaptionTimeFromVideo, togglePlayback]);

  const handleDeleteCaption = useCallback((captionId: string) => {
    resetSaveCaptionsError();
    setImportError(null);
    setCaptionDrafts((prev) => prev.filter((caption) => caption.id !== captionId));
    setLastFocusedCaptionId((prev) => (prev === captionId ? null : prev));
  }, [resetSaveCaptionsError]);

  const handleSaveCaptions = useCallback(() => {
    if (!videoId || hasCaptionErrors) return;
    persistCaptions(captionDrafts);
  }, [captionDrafts, hasCaptionErrors, persistCaptions, videoId]);

  const handleMetadata = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      if (!video) return;
      const target = event.currentTarget;
      const durationMs = Number.isFinite(target.duration)
        ? Math.round(target.duration * 1000)
        : undefined;
      const width = target.videoWidth || undefined;
      const height = target.videoHeight || undefined;

      if (
        durationMs === video.durationMs &&
        width === video.width &&
        height === video.height
      ) {
        setAppliedMetadataForId(videoId);
        return;
      }

      const patch: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>> = {};
      if (typeof durationMs === 'number') patch.durationMs = durationMs;
      if (typeof width === 'number') patch.width = width;
      if (typeof height === 'number') patch.height = height;

      const next: Video = { ...video, ...patch };

      queryClient.setQueryData(['video', videoId], next);
      queryClient.setQueryData(['videos'], (prev: Video[] | undefined) =>
        prev?.map((v) => (v.id === next.id ? { ...v, ...next } : v)) ?? prev,
      );
      if (dataSourceKind === 'mock') {
        const maybe = dataSource as unknown as {
          updateVideoMetadata?: (
            id: string,
            meta: Partial<Pick<Video, 'durationMs' | 'width' | 'height'>>
          ) => Promise<void>;
        };
        if (typeof maybe.updateVideoMetadata === 'function') {
          void maybe.updateVideoMetadata(videoId, patch);
        }
      }

      setAppliedMetadataForId(videoId);
      if (typeof durationMs === 'number') setDurationMs(durationMs);
    },
    [video, videoId],
  );

  useEffect(() => {
    if (typeof video?.durationMs === 'number') {
      setDurationMs(video.durationMs);
    }
  }, [video]);

  useEffect(() => {
    if (typeof durationMs !== 'number') return;
    setTrimRange((prev) => {
      if (prev && Number.isFinite(prev.startMs) && Number.isFinite(prev.endMs)) {
        const clampedStart = Math.max(0, Math.min(prev.startMs, durationMs));
        const clampedEnd = Math.max(clampedStart, Math.min(prev.endMs, durationMs));
        return { startMs: clampedStart, endMs: clampedEnd };
      }
      return { startMs: 0, endMs: durationMs };
    });
  }, [durationMs]);

  useEffect(() => {
    trimRangeRef.current = trimRange;
  }, [trimRange]);

  const drawWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    const analyser = analyserRef.current;
    const dataArray = waveformDataRef.current;
    if (!canvas || !analyser || !dataArray) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const typedDataArray = dataArray as unknown as Uint8Array<ArrayBuffer>;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr || 1;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    analyser.getByteTimeDomainData(typedDataArray);

    context.clearRect(0, 0, width, height);
    context.lineWidth = 2;
    context.strokeStyle = '#2b7bff';

    context.beginPath();
    const sliceWidth = width / typedDataArray.length;
    let x = 0;

    for (let i = 0; i < typedDataArray.length; i += 1) {
      const value = typedDataArray[i] ?? 128;
      const v = value / 128.0;
      const y = (v * height) / 2;

      if (i === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }

      x += sliceWidth;
    }

    context.stroke();
    waveformRafIdRef.current = window.requestAnimationFrame(drawWaveform);
  }, []);

  const stopWaveform = useCallback(() => {
    if (waveformRafIdRef.current !== null) {
      window.cancelAnimationFrame(waveformRafIdRef.current);
      waveformRafIdRef.current = null;
    }
  }, []);

  const startWaveform = useCallback(() => {
    stopWaveform();
    waveformRafIdRef.current = window.requestAnimationFrame(drawWaveform);
  }, [drawWaveform, stopWaveform]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoUrl) return undefined;

    const AudioContextClass =
      window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return undefined;

    let context: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;

    try {
      context = new AudioContextClass();
      audioContextRef.current = context;

      source = context.createMediaElementSource(videoElement);
      mediaSourceRef.current = source;

      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      source.connect(analyser);
      analyser.connect(context.destination);

      waveformDataRef.current =
        new Uint8Array(analyser.frequencyBinCount) as unknown as Uint8Array<ArrayBuffer>;
    } catch {
      audioContextRef.current = null;
      analyserRef.current = null;
      mediaSourceRef.current = null;
      waveformDataRef.current = null;
      return undefined;
    }

    const handlePlay = () => {
      if (!context) return;
      void context.resume().catch(() => null);
      startWaveform();
    };

    const handlePause = () => {
      stopWaveform();
    };

    const handleEnded = () => {
      stopWaveform();
    };

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('ended', handleEnded);

    if (!videoElement.paused && !videoElement.ended) {
      if (context) void context.resume().catch(() => null);
      startWaveform();
    }

    return () => {
      stopWaveform();
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('ended', handleEnded);

      try {
        analyser?.disconnect();
        source?.disconnect();
      } catch (err) {
        if (import.meta.env.DEV) {
          console.debug('[waveform] cleanup failed', err);
        }
      }
      if (context) void context.close().catch(() => null);

      audioContextRef.current = null;
      analyserRef.current = null;
      mediaSourceRef.current = null;
      waveformDataRef.current = null;
    };
  }, [startWaveform, stopWaveform, videoUrl]);

  useEffect(() => {
    const target = videoRef.current;
    if (!target) return undefined;

    const handleTimeUpdate = () => {
      if (timeUpdateRafIdRef.current !== null) return;
      timeUpdateRafIdRef.current = window.requestAnimationFrame(() => {
        timeUpdateRafIdRef.current = null;
        const currentTimeMs = Number.isFinite(target.currentTime)
          ? target.currentTime * 1000
          : Number.NaN;
        if (!Number.isFinite(currentTimeMs)) return;
        const worker = captionWorkerRef.current;
        if (!worker) return;

        const message: CaptionWorkerRequest = {
          type: 'scanActiveCaption',
          currentTimeMs,
        };
        worker.postMessage(message);
      });
    };

    target.addEventListener('timeupdate', handleTimeUpdate);
    target.addEventListener('seeking', handleTimeUpdate);

    return () => {
      target.removeEventListener('timeupdate', handleTimeUpdate);
      target.removeEventListener('seeking', handleTimeUpdate);
      if (timeUpdateRafIdRef.current !== null) {
        window.cancelAnimationFrame(timeUpdateRafIdRef.current);
        timeUpdateRafIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const liveIds = new Set(captionDrafts.map((c) => c.id));
    for (const key of Object.keys(captionRefs.current)) {
      if (!liveIds.has(key)) delete captionRefs.current[key];
    }
  }, [captionDrafts]);

  useEffect(() => {
    if (!activeCaptionId) return;
    const target = captionRefs.current[activeCaptionId];
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeCaptionId]);

  const effectiveDurationMs = useMemo(() => {
    if (typeof durationMs === 'number') return durationMs;
    if (typeof video?.durationMs === 'number') return video.durationMs;
    return null;
  }, [durationMs, video]);

  const selection = useMemo(() => {
    if (!trimRange || typeof effectiveDurationMs !== 'number') return null;
    const startMs = Math.max(0, Math.min(trimRange.startMs, effectiveDurationMs));
    const endMs = Math.max(startMs, Math.min(trimRange.endMs, effectiveDurationMs));
    const widthPct = effectiveDurationMs === 0 ? 0 : ((endMs - startMs) / effectiveDurationMs) * 100;
    const leftPct = effectiveDurationMs === 0 ? 0 : (startMs / effectiveDurationMs) * 100;
    return { startMs, endMs, widthPct, leftPct, durationMs: endMs - startMs };
  }, [effectiveDurationMs, trimRange]);

  const clampToDuration = useCallback(
    (ms: number) => {
      const maxDuration = effectiveDurationMs ?? Number.NaN;
      if (!Number.isFinite(maxDuration)) return Math.max(0, ms);
      return Math.min(Math.max(ms, 0), maxDuration);
    },
    [effectiveDurationMs],
  );

  const updateTrimRange = useCallback(
    (next: { startMs: number; endMs: number }) => {
      setTrimRange((prev) => {
        const snappedStart = snapToStep(next.startMs, snapStepMs);
        const snappedEnd = snapToStep(next.endMs, snapStepMs);
        const clampedStart = clampToDuration(Math.min(snappedStart, snappedEnd));
        const clampedEnd = clampToDuration(Math.max(snappedStart, snappedEnd));
        if (prev && clampedStart === prev.startMs && clampedEnd === prev.endMs) return prev;
        return { startMs: clampedStart, endMs: clampedEnd };
      });
    },
    [clampToDuration, snapStepMs],
  );

  const handleNudge = useCallback(
    (target: 'start' | 'end', deltaMs: number) => {
      setTrimRange((prev) => {
        if (!prev) return prev;
        const nextStart = target === 'start' ? clampToDuration(prev.startMs + deltaMs) : prev.startMs;
        const nextEnd = target === 'end' ? clampToDuration(prev.endMs + deltaMs) : prev.endMs;
        return {
          startMs: Math.min(nextStart, nextEnd),
          endMs: Math.max(nextStart, nextEnd),
        };
      });
    },
    [clampToDuration],
  );

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const ms = clampToDuration(ratio * effectiveDurationMs);
      setDragTarget('new');
      updateTrimRange({ startMs: ms, endMs: ms });
      trimRangeRef.current = { startMs: ms, endMs: ms };
      window.getSelection()?.removeAllRanges();
    },
    [clampToDuration, effectiveDurationMs, updateTrimRange],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragTarget || typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const ms = clampToDuration(ratio * effectiveDurationMs);
      setTrimRange((prev) => {
        if (!prev) return prev;
        if (dragTarget === 'start') {
          const next = { startMs: ms, endMs: prev.endMs };
          trimRangeRef.current = next;
          return next;
        }
        if (dragTarget === 'end') {
          const next = { startMs: prev.startMs, endMs: ms };
          trimRangeRef.current = next;
          return next;
        }
        const next = { startMs: prev.startMs, endMs: ms };
        trimRangeRef.current = next;
        return next;
      });
    },
    [clampToDuration, dragTarget, effectiveDurationMs],
  );

  const handlePointerUp = useCallback(() => {
    if (!dragTarget) return;
    const latest = trimRangeRef.current;
    if (!latest) return;

    setDragTarget(null);
    updateTrimRange(latest);
  }, [dragTarget, updateTrimRange]);
  useEffect(() => {
    if (!dragTarget) return undefined;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragTarget, handlePointerMove, handlePointerUp]);

  return (
    <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0 }}>비디오 상세</h1>
        <Link to="/videos" style={{ fontSize: 14, color: '#555' }}>
          목록으로 돌아가기
        </Link>
      </div>

      {isVideoLoading ? (
        <p style={{ margin: '12px 0 0' }}>비디오 정보를 불러오는 중이에요…</p>
      ) : isVideoError || !video ? (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 8,
            border: '1px solid #f2c4c4',
            background: '#fff6f6',
            color: '#b00020',
          }}
        >
          <p style={{ margin: 0 }}>비디오를 찾지 못했어요.</p>
        </div>
      ) : (
        <div style={{ marginTop: 16, display: 'grid', gap: 16 }}>
          <section
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h2 style={{ margin: 0 }}>{video.title}</h2>
              <span style={{ color: '#666', fontSize: 13 }}>
                {formatDate(video.createdAt)}
              </span>
            </div>
              <div style={{ color: '#555', fontSize: 14 }}>
                {formatMeta(video) || '메타데이터 없음'}
                {isMetadataReady && formatMeta(video)
                  ? ' (추출됨)'
                  : null}
              </div>
            </section>

          <section
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h3 style={{ margin: 0 }}>자막</h3>
              <button
                type="button"
                onClick={handleAddCaption}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid #111',
                  cursor: 'pointer',
                  background: '#111',
                  color: '#fff',
                }}
                disabled={isCaptionsLoading || isSavingCaptions}
              >
                새 자막 추가
              </button>
              <div style={{ flex: 1 }} />
              {lastSavedAt ? (
                <span style={{ color: '#666', fontSize: 12 }}>
                  마지막 저장: {new Date(lastSavedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {isCaptionsLoading ? (
              <p style={{ margin: 0 }}>자막을 불러오는 중이에요…</p>
            ) : isCaptionsError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #f2c4c4',
                  background: '#fff6f6',
                  color: '#b00020',
                }}
              >
                <p style={{ margin: '0 0 6px' }}>자막을 불러오지 못했어요.</p>
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: '#2f1317',
                    color: '#ffeaea',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                  }}
                >
                  {captionsError instanceof Error ? captionsError.message : String(captionsError)}
                </pre>
              </div>
            ) : captionDrafts.length === 0 ? (
              <p style={{ margin: 0, color: '#555' }}>
                자막이 없어요. 새 자막을 추가해보세요.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
                {captionDrafts.map((caption) => {
                  const errors = getCaptionErrors(caption);
                  const hasError = Object.keys(errors).length > 0;
                  const isActive = activeCaptionId === caption.id;
                  return (
                    <li
                      key={caption.id}
                      ref={(node) => {
                        captionRefs.current[caption.id] = node;
                      }}
                      style={{
                        border: isActive ? '1px solid #111' : '1px solid #e6e6e6',
                        borderRadius: 10,
                        padding: 12,
                        background: hasError
                          ? '#fffafa'
                          : isActive
                            ? '#f5f8ff'
                            : '#fdfdfd',
                        display: 'grid',
                        boxShadow: isActive ? '0 0 0 2px #dfe8ff' : undefined,
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>시작(ms)</span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="number"
                              min={0}
                              value={Number.isFinite(caption.startMs) ? caption.startMs : ''}
                              onChange={(e) =>
                                handleCaptionFieldChange(caption.id, 'startMs', e.target.value)
                              }
                              onFocus={() => setLastFocusedCaptionId(caption.id)}
                              style={{
                                padding: '8px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleSetCaptionTimeFromVideo(caption.id, 'startMs')}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                                cursor: 'pointer',
                                background: '#f7f7f7',
                                color: '#111',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              현재 재생 위치로 설정
                            </button>
                          </div>
                          {errors.startMs ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.startMs}</span>
                          ) : null}
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>종료(ms)</span>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="number"
                              min={0}
                              value={Number.isFinite(caption.endMs) ? caption.endMs : ''}
                              onChange={(e) => handleCaptionFieldChange(caption.id, 'endMs', e.target.value)}
                              onFocus={() => setLastFocusedCaptionId(caption.id)}
                              style={{
                                padding: '8px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleSetCaptionTimeFromVideo(caption.id, 'endMs')}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ccc',
                                cursor: 'pointer',
                                background: '#f7f7f7',
                                color: '#111',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              현재 재생 위치로 설정
                            </button>
                          </div>
                          {errors.endMs ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.endMs}</span>
                          ) : null}
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: 12, color: '#555' }}>자막 내용</span>
                          <input
                            type="text"
                            value={caption.text}
                            onChange={(e) => handleCaptionFieldChange(caption.id, 'text', e.target.value)}
                            onFocus={() => setLastFocusedCaptionId(caption.id)}
                            placeholder="자막을 입력하세요"
                            style={{
                              padding: '8px 10px',
                              borderRadius: 6,
                              border: '1px solid #ccc',
                            }}
                          />
                          {errors.text ? (
                            <span style={{ color: '#b00020', fontSize: 12 }}>{errors.text}</span>
                          ) : null}
                        </label>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={() => handleDeleteCaption(caption.id)}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 8,
                              border: '1px solid #b00020',
                              background: '#fff6f6',
                              color: '#b00020',
                              cursor: 'pointer',
                              height: 'fit-content',
                            }}
                            aria-label="자막 삭제"
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {isSaveCaptionsError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid #f2c4c4',
                  background: '#fff6f6',
                  color: '#b00020',
                }}
              >
                <p style={{ margin: '0 0 6px' }}>자막 저장에 실패했어요.</p>
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 6,
                    background: '#2f1317',
                    color: '#ffeaea',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                  }}
                >
                  {saveCaptionsError instanceof Error ? saveCaptionsError.message : String(saveCaptionsError)}
                </pre>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={handleSaveCaptions}
                disabled={
                  isCaptionsLoading ||
                  isSavingCaptions ||
                  hasCaptionErrors ||
                  captionDrafts.length === 0
                }
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#111',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {isSavingCaptions ? '저장 중…' : '자막 저장'}
              </button>
              {hasCaptionErrors ? (
                <span style={{ color: '#b00020', fontSize: 13 }}>
                  모든 자막의 시작·종료 시간과 내용을 확인하세요.
                </span>
              ) : (
                <span style={{ color: '#555', fontSize: 13 }}>
                  시작 시간 오름차순으로 정렬되어 저장돼요.
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={handleImportJsonFile}
              />
              <button
                type="button"
                onClick={handleImportJsonClick}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                JSON 불러오기
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                JSON 내보내기
              </button>
              <button
                type="button"
                onClick={handleExportSrt}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #ccc',
                  background: '#f8f8f8',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                SRT 내보내기
              </button>
            </div>

            {importError ? (
              <p style={{ margin: '8px 0 0', color: '#b00020' }}>{importError}</p>
            ) : null}
          </section>

          <section
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
            }}
          >
            <h3 style={{ margin: '0 0 12px' }}>썸네일</h3>
            {isThumbLoading ? (
              <p style={{ margin: 0 }}>썸네일을 불러오는 중이에요…</p>
            ) : thumbnailBlobError ? (
              <p style={{ margin: 0, color: '#b00020' }}>
                썸네일을 불러오지 못했어요.
              </p>
            ) : thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt="저장된 비디오 썸네일"
                style={{
                  width: '100%',
                  maxWidth: 360,
                  borderRadius: 8,
                  border: '1px solid #ddd',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <p style={{ margin: 0, color: '#555' }}>저장된 썸네일이 없어요.</p>
            )}
          </section>

          <section
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
            }}
          >
            <h3 style={{ margin: '0 0 12px' }}>영상 미리보기</h3>
            {isBlobLoading ? (
              <p style={{ margin: 0 }}>비디오 파일을 불러오는 중이에요…</p>
            ) : videoBlobError ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  background: '#fff4f4',
                  border: '1px solid #f2c4c4',
                  color: '#b00020',
                }}
              >
                영상 파일을 불러오지 못했어요.
              </div>
            ) : videoUrl ? (
              <>
                <video
                  key={videoUrl}
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  style={{ width: '100%', borderRadius: 8, background: '#000' }}
                  onLoadedMetadata={handleMetadata}
                >
                  <track kind="captions" />
                </video>
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    display: 'grid',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <p style={{ margin: 0, color: '#111', fontWeight: 600 }}>트리밍 구간</p>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
                      <span style={{ color: '#111' }}>
                        시작: <strong>{selection ? formatTimestamp(selection.startMs) : '--:--.---'}</strong>
                      </span>
                      <span style={{ color: '#111' }}>
                        종료: <strong>{selection ? formatTimestamp(selection.endMs) : '--:--.---'}</strong>
                      </span>
                      <span style={{ color: '#555' }}>
                        길이: {selection ? formatTimestamp(selection.durationMs) : '--:--.---'}
                      </span>
                    </div>
                  </div>
                  <div
                    ref={timelineRef}
                    onPointerDown={handleTimelinePointerDown}
                    style={{
                      position: 'relative',
                      height: 32,
                      borderRadius: 16,
                      background: '#e5e7eb',
                      cursor: 'crosshair',
                      touchAction: 'none',
                      overflow: 'hidden',
                    }}
                    aria-label="트리밍 구간 선택"
                  >
                    {selection ? (
                      <div
                        style={{
                          position: 'absolute',
                          left: `${selection.leftPct}%`,
                          width: `${selection.widthPct}%`,
                          top: 0,
                          bottom: 0,
                          background: 'rgba(43, 123, 255, 0.2)',
                          border: '1px solid #2b7bff',
                          borderRadius: 16,
                          minWidth: 8,
                        }}
                      >
                        <div
                          role="separator"
                          aria-label="시작 지점 조절"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setDragTarget('start');
                          }}
                          style={{
                            position: 'absolute',
                            left: -6,
                            top: -6,
                            bottom: -6,
                            width: 12,
                            borderRadius: 4,
                            background: '#2b7bff',
                            cursor: 'ew-resize',
                          }}
                        />
                        <div
                          role="separator"
                          aria-label="종료 지점 조절"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setDragTarget('end');
                          }}
                          style={{
                            position: 'absolute',
                            right: -6,
                            top: -6,
                            bottom: -6,
                            width: 12,
                            borderRadius: 4,
                            background: '#2b7bff',
                            cursor: 'ew-resize',
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, color: '#333' }}>스냅:</span>
                    {[100, 1000].map((step) => (
                      <button
                        key={step}
                        type="button"
                        onClick={() => setSnapStepMs(step as 100 | 1000)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: snapStepMs === step ? '1px solid #2b7bff' : '1px solid #d0d7e2',
                          background: snapStepMs === step ? '#e8f0ff' : '#fff',
                          color: '#111',
                          cursor: 'pointer',
                        }}
                      >
                        {step === 100 ? '100ms' : '1s'}
                      </button>
                    ))}
                    <span style={{ fontSize: 13, color: '#333', marginLeft: 8 }}>미세 조정:</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => handleNudge('start', -snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        시작 -{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('start', snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        시작 +{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('end', -snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        종료 -{snapStepMs}ms
                      </button>
                      <button
                        type="button"
                        onClick={() => handleNudge('end', snapStepMs)}
                        disabled={!selection}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: selection ? 'pointer' : 'not-allowed',
                        }}
                      >
                        종료 +{snapStepMs}ms
                      </button>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#f7f9fb',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <p style={{ margin: '0 0 8px', color: '#333', fontSize: 14 }}>오디오 파형</p>
                  <canvas
                    ref={waveformCanvasRef}
                    style={{ width: '100%', height: 96, display: 'block' }}
                  />
                </div>
              </>
            ) : (
              <p style={{ margin: 0 }}>재생할 수 있는 영상이 없어요.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}