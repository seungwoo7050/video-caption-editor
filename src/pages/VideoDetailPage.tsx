import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { dataSource, dataSourceKind } from '@/datasource';
import { downloadTextFile } from '@/lib/captionIO';
import { queryClient } from '@/lib/queryClient';
import { normalizeTrimRange } from '@/lib/trimRange';
import type { WaveformWorkerResponse } from '@/workers/waveformWorker';

import {
  createCaptionExportJson,
  createCaptionExportSrt,
  parseCaptionJsonForPage,
} from './videoDetail/captions/captionIO';
import { getActiveCaption } from './videoDetail/captions/captionSelectors';
import { getCaptionErrors } from './videoDetail/captions/captionValidation';
import {
  CAPTION_GAP_MS_STORAGE_KEY,
  DEFAULT_HOTKEYS,
  HOTKEY_STORAGE_KEY,
  TRIM_LOOP_EPSILON_MS,
  WAVEFORM_FOLLOW_RESUME_MS,
  WAVEFORM_MAX_BUCKET_COUNT,
  WAVEFORM_MAX_LOD_SCALE,
  WAVEFORM_MIN_BUCKET_COUNT,
  WAVEFORM_PEAK_CACHE_LIMIT,
  WAVEFORM_PLAYHEAD_RATIO,
  WAVEFORM_RASTER_CACHE_LIMIT,
  WAVEFORM_RASTER_MAX_WIDTH,
  WAVEFORM_RASTER_MEMORY_BUDGET_BYTES,
  WAVEFORM_RASTER_MIN_WIDTH,
  WAVEFORM_VIEWPORT_MIN_DURATION_MS,
} from './videoDetail/constants';
import { useBurnInExport } from './videoDetail/export/useBurnInExport';
import { useTrimExport } from './videoDetail/export/useTrimExport';
import {
  autoAlignCaptions,
  createCaptionId,
  formatDate,
  formatKeyLabel,
  formatMeta,
  formatMsWithSeconds,
  formatSeconds,
  getLastValidEndMs,
  isInvalidHotkeyKey,
  normalizeEventKey,
  parseCaptionGapMs,
  sanitizeForFileName,
  sanitizeHotkeyConfig,
  snapToStep,
  sortCaptions,
} from './videoDetail/utils';
import { useWebglPreview } from './videoDetail/webgl/useWebglPreview';
import { WebglPreviewView } from './videoDetail/webgl/WebglPreviewView';

import './VideoDetailPage.css';

import type {
  Caption,
  HotkeyConfig,
  TrimRange,
  Video,
  Viewport,
  WaveformRasterCacheEntry,
  WaveformWorkerPayload,
} from './videoDetail/types';
import type {
  ChangeEvent,
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
  SyntheticEvent,
} from 'react';

const WINDOW_KEYDOWN_CAPTURE_OPTS = { capture: true } as const;

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const videoId = id ?? '';
  const [appliedMetadataForId, setAppliedMetadataForId] = useState<string | null>(null);

  const [captionDrafts, setCaptionDrafts] = useState<Caption[]>([]);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const [waveformViewport, setWaveformViewport] = useState<Viewport | null>(null);
  const [shouldLoopTrim, setShouldLoopTrim] = useState(false);
  const [applyTrimOnExport, setApplyTrimOnExport] = useState(false);
  const [hotkeyConfig, setHotkeyConfig] = useState<HotkeyConfig>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_HOTKEYS };
    try {
      const stored = localStorage.getItem(HOTKEY_STORAGE_KEY);
      if (!stored) return { ...DEFAULT_HOTKEYS };
      const parsed = JSON.parse(stored);
      return sanitizeHotkeyConfig(parsed);
    } catch {
      return { ...DEFAULT_HOTKEYS };
    }
  });
  const [captionGapMs, setCaptionGapMs] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    try {
      const stored = localStorage.getItem(CAPTION_GAP_MS_STORAGE_KEY);
      return parseCaptionGapMs(stored);
    } catch {
      return 1;
    }
  });
  const [capturingHotkey, setCapturingHotkey] = useState<keyof HotkeyConfig | null>(null);
  const [snapStepMs, setSnapStepMs] = useState<100 | 1000>(100);
  const [trimInputSeconds, setTrimInputSeconds] = useState<{ start: string; end: string }>({
    start: '',
    end: '',
  });
  const trimInputFocusRef = useRef<'start' | 'end' | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const trimRangeRef = useRef<TrimRange | null>(null);
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
  const waveformWorkerRef = useRef<Worker | null>(null);
  const waveformWorkerResolversRef = useRef<Map<number, (response: WaveformWorkerResponse) => void>>(new Map());
  const waveformRequestIdRef = useRef(0);
  const waveformSamplesReadyRef = useRef(false);
  const waveformOverviewPeaksRef = useRef<Int16Array | null>(null);
  const waveformPeaksCacheRef = useRef<Map<number, Int16Array>>(new Map());
  const waveformRasterCacheRef = useRef<Map<string, WaveformRasterCacheEntry>>(new Map());
  const waveformRasterBytesRef = useRef(0);
  const waveformRasterKeyRef = useRef<string | null>(null);
  const waveformRasterHeightRef = useRef<number>(0);
  const waveformOverviewRenderRafIdRef = useRef<number | null>(null);
  const waveformBucketCountRef = useRef<number | null>(null);
  const waveformViewportRef = useRef<Viewport | null>(null);
  const waveformViewportCommitTimerRef = useRef<number | null>(null);
  const renderOverviewWaveformRef = useRef<(() => void) | null>(null);
  const waveformWheelRafIdRef = useRef<number | null>(null);
  const waveformPendingWheelRef = useRef<
    | { type: 'zoom'; deltaPx: number; width: number; anchorX: number }
    | { type: 'pan'; deltaPx: number; width: number }
    | null
  >(null);

  useEffect(() => {
    try {
      localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(hotkeyConfig));
    } catch {
      // ignore
    }
  }, [hotkeyConfig]);
  useEffect(() => {
    try {
      localStorage.setItem(CAPTION_GAP_MS_STORAGE_KEY, captionGapMs.toString());
    } catch {
      // ignore
    }
  }, [captionGapMs]);
  const waveformPendingBucketRef = useRef<number | null>(null);
  const waveformComputeTimeoutRef = useRef<number | null>(null);
  const waveformComputeTokenRef = useRef<number>(0);
  const waveformLastComputeAtRef = useRef<number>(0);
  const waveformModeRef = useRef<'overview' | 'live' | 'loading'>('loading');
  const currentTimeMsRef = useRef<number | null>(null);
  const waveformScrubPointerIdRef = useRef<number | null>(null);
  const waveformScrubRafIdRef = useRef<number | null>(null);
  const waveformPendingSeekMsRef = useRef<number | null>(null);
  const waveformFollowEnabledRef = useRef(true);
  const waveformFollowPausedRef = useRef(false);
  const waveformFollowResumeTimeoutRef = useRef<number | null>(null);
  const shouldLoopTrimRef = useRef(false);
  const normalizedTrimRangeRef = useRef<ReturnType<typeof normalizeTrimRange>>(null);
  const captionRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const pendingCaptionTextFocusIdRef = useRef<string | null>(null);
  const prevCaptionIdsRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState<number | null>(null);
  const lastUiTimeUpdateAtRef = useRef<number>(0);
  const [lastFocusedCaptionId, setLastFocusedCaptionId] = useState<string | null>(null);
  const [shouldUseLiveWaveform, setShouldUseLiveWaveform] = useState(false);
  const videoFrameRequestIdRef = useRef<number | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  const {
    data: videoBlob,
    error: videoBlobError,
    isPending: isBlobLoading,
  } = useQuery({
    queryKey: ['video-blob', videoId],
    enabled: Boolean(videoId),
    queryFn: async () => {
      const blob = await dataSource.getVideoBlob(videoId);
      if (!blob) throw new Error('원본 파일을 찾을 수 없어요. (로컬 저장소)');
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

  const {
    isWebglSupported,
    isWebglReady,
    isGrayscale,
    handleGrayscaleChange,
    webglCanvasRef,
    webglContainerRef,
  } = useWebglPreview({ videoRef, videoUrl });

  const activeCaption = useMemo(() => {
    return getActiveCaption(captionDrafts, currentTimeMs);
  }, [captionDrafts, currentTimeMs]);

  const activeCaptionId = activeCaption?.id ?? null;

  const activeCaptionText = useMemo(() => {
    const text = activeCaption?.text.trim();
    return text ? text : null;
  }, [activeCaption]);

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

  useEffect(() => {
    const worker = new Worker(new URL('../workers/waveformWorker.ts', import.meta.url), {
      type: 'module',
    });

    waveformWorkerRef.current = worker;
    const resolverMap = waveformWorkerResolversRef.current;

    const handleMessage = (event: MessageEvent<WaveformWorkerResponse>) => {
      const { requestId } = event.data ?? {};
      if (typeof requestId !== 'number') return;
      const resolver = resolverMap.get(requestId);
      if (resolver) {
        resolver(event.data);
        resolverMap.delete(requestId);
      }
    };

    const handleError = (errorEvent: ErrorEvent) => {
      console.error('[waveform] worker error', errorEvent);
      resolverMap.forEach((resolver, requestId) => {
        resolver({ type: 'error', requestId, message: 'worker-error' });
      });
      resolverMap.clear();
      setShouldUseLiveWaveform(true);
      waveformModeRef.current = 'live';
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    return () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      worker.terminate();
      resolverMap.clear();
      waveformWorkerRef.current = null;
    };
  }, []);

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
    setCaptionDrafts((prev) => autoAlignCaptions(prev, captionGapMs));
  }, [captionGapMs]);

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
      setCaptionDrafts((prev) => {
        const next = prev.map((caption) =>
          caption.id === captionId
            ? {
                ...caption,
                [field]: field === 'text' ? value : nextNumber,
              }
            : caption,
        );

        if (field === 'text') return sortCaptions(next);
        // 숫자 입력은 "비우고 다시 타이핑"을 허용해야 함.
        // 빈값(NaN)인 동안은 자동 정렬로 값을 다시 채우지 않는다.
        if (!Number.isFinite(nextNumber)) return next;
        return autoAlignCaptions(next, captionGapMs);
      });
    },
    [captionGapMs, resetSaveCaptionsError],
  );

  const getCurrentTimeMs = useCallback(() => {
    const video = videoRef.current;
    if (!video) return Number.NaN;

    const currentTimeMs = Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000)
      : Number.NaN;

    return currentTimeMs;
  }, []);

  const commitCurrentTimeMs = useCallback((ms: number | null) => {
    currentTimeMsRef.current = ms;

    // 10~15fps 정도만 UI 업데이트 (리스트 전체 리렌더 방지)
    const now =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

    if (now - lastUiTimeUpdateAtRef.current < 100) return;
    lastUiTimeUpdateAtRef.current = now;
    setCurrentTimeMs(ms);
  }, []);

  const applyTrimLoopIfNeeded = useCallback(
    (video: HTMLVideoElement, currentTimeMs: number) => {
      if (!shouldLoopTrimRef.current) return currentTimeMs;
      const range = normalizedTrimRangeRef.current;
      if (!range || !Number.isFinite(currentTimeMs)) return currentTimeMs;
      if (video.paused || video.ended) return currentTimeMs;
      const { trimStart, trimEnd } = range;
      if (trimEnd - trimStart <= 0) return currentTimeMs;

      if (currentTimeMs > trimEnd - TRIM_LOOP_EPSILON_MS) {
        video.currentTime = trimStart / 1000;
        return Math.round(trimStart);
      }

      return currentTimeMs;
    },
    [],
  );

  const updateCurrentTime = useCallback(
    (options: { enforceTrimLoop?: boolean } = {}) => {
      const video = videoRef.current;
      if (!video) {
        commitCurrentTimeMs(null);
        return;
      }

      const next = getCurrentTimeMs();
      const adjusted = options.enforceTrimLoop
        ? applyTrimLoopIfNeeded(video, next)
        : next;

      commitCurrentTimeMs(Number.isFinite(adjusted) ? adjusted : null);
    },
    [applyTrimLoopIfNeeded, getCurrentTimeMs, commitCurrentTimeMs],
  );

  useEffect(() => {
    currentTimeMsRef.current = currentTimeMs;
  }, [currentTimeMs]);

  const clampPlaybackToTrimOnPlay = useCallback(() => {
    if (!shouldLoopTrimRef.current) return;
    const video = videoRef.current;
    const range = normalizedTrimRangeRef.current;
    if (!video || !range) return;

    const currentTimeMs = Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000)
      : Number.NaN;
    if (!Number.isFinite(currentTimeMs)) return;

    if (
      currentTimeMs < range.trimStart - TRIM_LOOP_EPSILON_MS ||
      currentTimeMs > range.trimEnd + TRIM_LOOP_EPSILON_MS
    ) {
      video.currentTime = range.trimStart / 1000;
      setCurrentTimeMs(Math.round(range.trimStart));
    }
  }, []);

  const cancelTimeTracking = useCallback(() => {
    const video = videoRef.current;
    if (video && typeof video.cancelVideoFrameCallback === 'function' && videoFrameRequestIdRef.current !== null) {
      video.cancelVideoFrameCallback(videoFrameRequestIdRef.current);
    }
    if (animationFrameIdRef.current !== null) {
      window.cancelAnimationFrame(animationFrameIdRef.current);
    }
    videoFrameRequestIdRef.current = null;
    animationFrameIdRef.current = null;
  }, []);

  const scheduleTimeTracking = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    cancelTimeTracking();

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = () => {
        updateCurrentTime({ enforceTrimLoop: true });
        videoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      };

      videoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      return;
    }

    if (video.paused || video.ended) return;

    const loop = () => {
      updateCurrentTime({ enforceTrimLoop: true });
      if (!video.paused && !video.ended) {
        animationFrameIdRef.current = window.requestAnimationFrame(loop);
      } else {
        animationFrameIdRef.current = null;
      }
    };

    animationFrameIdRef.current = window.requestAnimationFrame(loop);
  }, [cancelTimeTracking, updateCurrentTime]);

  const handleAddCaption = useCallback(() => {
    resetSaveCaptionsError();
    setImportError(null);
    const nextCaptionId = createCaptionId();
    const currentTimeMs = getCurrentTimeMs();
    setCaptionDrafts((prev) => {
      const aligned = autoAlignCaptions(prev, captionGapMs);
      const lastEndMs = getLastValidEndMs(aligned);
      const hasValidEnd = aligned.some((caption) => Number.isFinite(caption.endMs));
      const minimumStart = hasValidEnd ? lastEndMs + captionGapMs : 0;
      const startMs = Number.isFinite(currentTimeMs)
        ? Math.max(currentTimeMs, minimumStart)
        : minimumStart;
      const endMs = startMs + 1000;
      const next = [...aligned, { id: nextCaptionId, startMs, endMs, text: '' }];
      return autoAlignCaptions(next, captionGapMs);
    });
    setLastFocusedCaptionId(nextCaptionId);
    pendingCaptionTextFocusIdRef.current = nextCaptionId;
  }, [captionGapMs, getCurrentTimeMs, resetSaveCaptionsError]);

  const handleConfirmCaption = useCallback(
    (captionId: string) => {
      resetSaveCaptionsError();
      setImportError(null);
      let createdId: string | null = null;
      setCaptionDrafts((prev) => {
        const aligned = autoAlignCaptions(prev, captionGapMs);
        const targetIndex = aligned.findIndex((caption) => caption.id === captionId);
        if (targetIndex === -1) return aligned;

        const target = aligned[targetIndex];
        if (!target) return aligned;
        if (!target.text.trim()) return aligned;

        const targetEnd = Number.isFinite(target.endMs)
          ? target.endMs
          : getLastValidEndMs(aligned.slice(0, targetIndex + 1));
        const nextStart = (Number.isFinite(targetEnd) ? (targetEnd as number) : 0) + captionGapMs;

        const nextCaption: Caption = {
          id: createCaptionId(),
          startMs: nextStart,
          endMs: nextStart + 1000,
          text: '',
        };

        createdId = nextCaption.id;

        const nextCaptions = [...aligned];
        nextCaptions.splice(targetIndex + 1, 0, nextCaption);
        return autoAlignCaptions(nextCaptions, captionGapMs);
      });

      if (createdId) {
        setLastFocusedCaptionId(createdId);
        pendingCaptionTextFocusIdRef.current = createdId;
      }
    },
    [captionGapMs, resetSaveCaptionsError],
  );

  useEffect(() => {
    const targetId = pendingCaptionTextFocusIdRef.current;
    if (!targetId) return;
    const rowEl = captionRefs.current[targetId];
    if (!rowEl) return;
    const inputEl = rowEl.querySelector('textarea, input') as HTMLElement | null;
    if (!inputEl) return;
    inputEl.focus();
    pendingCaptionTextFocusIdRef.current = null;
  }, [captionDrafts]);

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
    return sanitizeForFileName(video.title, 'captions');
  }, [video]);

  const safeTitleOrId = useMemo(() => {
    if (video?.title) return sanitizeForFileName(video.title, videoId || 'video');
    if (videoId) return sanitizeForFileName(videoId, 'video');
    return 'video';
  }, [video, videoId]);

  const handleExportJson = useCallback(() => {
    const json = createCaptionExportJson(captionDrafts, { applyTrimOnExport, trimRange });
    downloadTextFile(`${baseFileName}.json`, json, 'application/json;charset=utf-8');
  }, [applyTrimOnExport, baseFileName, captionDrafts, trimRange]);

  const handleExportSrt = useCallback(() => {
    const srt = createCaptionExportSrt(captionDrafts, { applyTrimOnExport, trimRange });
    downloadTextFile(`${baseFileName}.srt`, srt, 'application/x-subrip;charset=utf-8');
  }, [applyTrimOnExport, baseFileName, captionDrafts, trimRange]);

  const handleImportJsonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportJsonFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = parseCaptionJsonForPage(text, createCaptionId, captionGapMs);
        setCaptionDrafts(imported);
        setImportError(null);
        resetSaveCaptionsError();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '자막 JSON을 불러오지 못했어요.');
      } finally {
        event.target.value = '';
      }
    },
    [captionGapMs, resetSaveCaptionsError],
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

  const hotkeyItems: { key: keyof HotkeyConfig; label: string; description: string }[] = [
    { key: 'togglePlay', label: '재생/정지', description: '영상 재생·일시정지' },
    { key: 'setStart', label: '시작 설정', description: '현재 재생 위치를 시작 시간으로 설정' },
    { key: 'setEnd', label: '종료 설정', description: '현재 재생 위치를 종료 시간으로 설정' },
    { key: 'confirm', label: '자막 추가', description: '새 자막을 추가하고 포커스 유지' },
  ];

  useEffect(() => {
    const hotkeyValues = new Set(Object.values(hotkeyConfig));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (capturingHotkey) return;
      if (event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const eventKey = normalizeEventKey(event.key);
      if (!eventKey || eventKey === 'Process') return;

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'A' ||
          target.isContentEditable);

      // textarea(자막 내용)에서 Enter는 로컬(onKeyDown)로 처리한다.
      // - Enter: 확정(다음 자막 생성)
      // - Shift+Enter: 줄바꿈
      // window capture에서 Enter를 먹어버리면 Shift+Enter도 확정으로 동작하거나,
      // Enter가 중복 처리되어 자막이 2개 생길 수 있다.
      if (target?.tagName === 'TEXTAREA' && eventKey === 'Enter') return;
      if (isTypingTarget && !hotkeyValues.has(eventKey)) return;

      if (eventKey === hotkeyConfig.togglePlay) {
        event.stopPropagation();
        event.preventDefault();
        togglePlayback();
        return;
      }

      if (eventKey === hotkeyConfig.setStart) {
        event.stopPropagation();
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'startMs');
        return;
      }

      if (eventKey === hotkeyConfig.setEnd) {
        event.stopPropagation();
        event.preventDefault();
        const targetCaptionId = getShortcutTargetCaptionId();
        if (targetCaptionId) handleSetCaptionTimeFromVideo(targetCaptionId, 'endMs');
        return;
      }

      if (eventKey === hotkeyConfig.confirm) {
        // confirm이 Enter일 때 Shift+Enter는 textarea 줄바꿈으로 남겨둔다.
        // (textarea가 아닌 곳에서도 실수로 확정되지 않게)
        if (eventKey === 'Enter' && event.shiftKey) return;
        event.stopPropagation();
        event.preventDefault();
        handleAddCaption();
      }
    };

    window.addEventListener('keydown', handleKeyDown, WINDOW_KEYDOWN_CAPTURE_OPTS);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, WINDOW_KEYDOWN_CAPTURE_OPTS);
    };
  }, [
    capturingHotkey,
    getShortcutTargetCaptionId,
    handleAddCaption,
    handleSetCaptionTimeFromVideo,
    hotkeyConfig,
    togglePlayback,
  ]);

  useEffect(() => {
    if (!capturingHotkey) return;

    const handleCapture = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const eventKey = normalizeEventKey(event.key);
      if (!eventKey || eventKey === 'Process') return;

      event.stopPropagation();
      event.preventDefault();

      if (eventKey === 'Escape') {
        setCapturingHotkey(null);
        return;
      }

      if (isInvalidHotkeyKey(eventKey)) {
        return;
      }

      setHotkeyConfig((prev) => ({ ...prev, [capturingHotkey]: eventKey }));
      setCapturingHotkey(null);
    };

    window.addEventListener('keydown', handleCapture, WINDOW_KEYDOWN_CAPTURE_OPTS);
    return () => {
      window.removeEventListener('keydown', handleCapture, WINDOW_KEYDOWN_CAPTURE_OPTS);
    };
  }, [capturingHotkey]);

  useEffect(() => {
    const prevIds = prevCaptionIdsRef.current;
    const nextIds = captionDrafts.map((c) => c.id);

    // 다음 렌더부터 비교할 수 있게 먼저 갱신
    prevCaptionIdsRef.current = nextIds;

    const prevSet = new Set(prevIds);
    const added = nextIds.filter((id) => !prevSet.has(id));

    // import처럼 여러 개가 한 번에 추가되는 케이스는 건드리지 않음
    if (added.length !== 1) return;

    const newCaptionId = added[0] ?? null;
    if (!newCaptionId) return;

    setLastFocusedCaptionId(newCaptionId);

    if (typeof window === 'undefined') return;

    let tries = 0;
    const tryFocus = () => {
      tries += 1;
      const root = captionRefs.current[newCaptionId];
      const el = root?.querySelector(
        // 우선 textarea(자막 내용), 없으면 text input(혹시 구조가 다를 때)
        'textarea, input[type="text"], input:not([type])',
      ) as HTMLTextAreaElement | HTMLInputElement | null;

      if (el) {
        el.focus();
        if ('select' in el) el.select?.();
        return;
      }

      if (tries < 8) window.setTimeout(tryFocus, 25);
    };

    window.setTimeout(tryFocus, 0);
  }, [captionDrafts]);

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

  const effectiveDurationMs = useMemo(() => {
    if (typeof durationMs === 'number') return durationMs;
    if (typeof video?.durationMs === 'number') return video.durationMs;
    return null;
  }, [durationMs, video]);

  const normalizedTrimRange = useMemo(() => {
    return normalizeTrimRange(trimRange, effectiveDurationMs);
  }, [effectiveDurationMs, trimRange]);

  const waveformViewportDurationMs = useMemo(() => {
    if (waveformViewport) return waveformViewport.endMs - waveformViewport.startMs;
    if (typeof effectiveDurationMs === 'number') return effectiveDurationMs;
    return null;
  }, [effectiveDurationMs, waveformViewport]);

  useEffect(() => {
    shouldLoopTrimRef.current = shouldLoopTrim;
  }, [shouldLoopTrim]);

  useEffect(() => {
    waveformViewportRef.current = waveformViewport;
  }, [waveformViewport]);

  const commitWaveformViewportState = useCallback((next: Viewport) => {
    if (waveformViewportCommitTimerRef.current !== null) {
      window.clearTimeout(waveformViewportCommitTimerRef.current);
    }
    waveformViewportCommitTimerRef.current = window.setTimeout(() => {
      setWaveformViewport(next); // UI state는 드물게만 커밋
      waveformViewportCommitTimerRef.current = null;
    }, 80);
  }, []);

  const setWaveformViewportFast = useCallback(
    (next: Viewport) => {
      waveformViewportRef.current = next;                 // ref를 진짜 source로 사용
      renderOverviewWaveformRef.current?.();              // rAF로 캔버스 redraw
      commitWaveformViewportState(next);                  // state는 디바운스 커밋
    },
    [commitWaveformViewportState],
  );

  useEffect(() => {
    return () => {
      if (waveformViewportCommitTimerRef.current !== null) {
        window.clearTimeout(waveformViewportCommitTimerRef.current);
        waveformViewportCommitTimerRef.current = null;
      }
    };
  }, []);

  const clampWaveformViewport = useCallback(
    (startMs: number, durationMs: number): Viewport | null => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return null;

      const minDuration = Math.min(WAVEFORM_VIEWPORT_MIN_DURATION_MS, effectiveDurationMs);
      const desiredDuration = Math.max(durationMs, minDuration);
      const clampedDuration = Math.min(desiredDuration, effectiveDurationMs);

      const safeStart = Number.isFinite(startMs) ? startMs : 0;
      const clampedStart = Math.min(Math.max(safeStart, 0), effectiveDurationMs - clampedDuration);
      const clampedEnd = clampedStart + clampedDuration;

      return { startMs: clampedStart, endMs: clampedEnd };
    },
    [effectiveDurationMs],
  );

  useEffect(() => {
    if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) {
      setWaveformViewport(null);
      return;
    }

    setWaveformViewport((prev) => {
      const prevDuration = prev ? prev.endMs - prev.startMs : effectiveDurationMs;
      return clampWaveformViewport(prev?.startMs ?? 0, prevDuration) ?? { startMs: 0, endMs: effectiveDurationMs };
    });
  }, [clampWaveformViewport, effectiveDurationMs]);

  useEffect(() => {
    normalizedTrimRangeRef.current = normalizedTrimRange;
  }, [normalizedTrimRange]);

  useEffect(() => {
    if (!normalizedTrimRange) {
      setTrimInputSeconds({ start: '', end: '' });
      return;
    }
    setTrimInputSeconds((prev) => {
      const nextStart =
        trimInputFocusRef.current === 'start'
          ? prev.start
          : formatSeconds(normalizedTrimRange.trimStart);
      const nextEnd =
        trimInputFocusRef.current === 'end'
          ? prev.end
          : formatSeconds(normalizedTrimRange.trimEnd);
      if (prev.start === nextStart && prev.end === nextEnd) return prev;
      return { start: nextStart, end: nextEnd };
    });
  }, [normalizedTrimRange]);

  const trimRangeSummary = useMemo(() => {
    if (!normalizedTrimRange) return null;
    const durationSeconds = (
      (normalizedTrimRange.trimEnd - normalizedTrimRange.trimStart) /
      1000
    ).toFixed(2);
    const startMs = Math.round(normalizedTrimRange.trimStart);
    const endMs = Math.round(normalizedTrimRange.trimEnd);
    const startSeconds = formatSeconds(normalizedTrimRange.trimStart);
    const endSeconds = formatSeconds(normalizedTrimRange.trimEnd);
    return { durationSeconds, startMs, endMs, startSeconds, endSeconds };
  }, [normalizedTrimRange]);

  const canApplyTrimFromCurrentTime =
    Boolean(normalizedTrimRange) &&
    typeof effectiveDurationMs === 'number' &&
    typeof currentTimeMs === 'number' &&
    Number.isFinite(currentTimeMs);

  const {
    burnInError,
    burnInFileName,
    burnInMessage,
    burnInProgress,
    burnInResultUrl,
    handleBurnInExport,
    handleCancelBurnIn,
    isBurningIn,
  } = useBurnInExport({ captionDrafts, durationMs, safeTitleOrId, videoBlob });

  const {
    handleCancelTrim,
    handleTrimExport,
    isTrimming,
    trimError,
    trimFileName,
    trimMessage,
    trimProgress,
    trimResultUrl,
  } = useTrimExport({
    applyTrimOnExport,
    effectiveDurationMs,
    normalizedTrimRange,
    safeTitleOrId,
    trimRange,
    videoBlob,
  });

  const postWaveformWorkerMessage = useCallback(
    (message: WaveformWorkerPayload, transfer: Transferable[] = []) => {
      const worker = waveformWorkerRef.current;
      if (!worker) return Promise.reject(new Error('waveform-worker-unavailable'));

      const requestId = waveformRequestIdRef.current + 1;
      waveformRequestIdRef.current = requestId;

      return new Promise<WaveformWorkerResponse>((resolve, reject) => {
        waveformWorkerResolversRef.current.set(requestId, (response) => {
          if (response.type === 'error') {
            reject(new Error(response.message));
            return;
          }

          resolve(response);
        });

        const payload = { ...message, requestId } satisfies WaveformWorkerPayload & { requestId: number };
        worker.postMessage(payload, transfer);
      });
    },
    [],
  );

  const clearWaveformRasterCache = useCallback(() => {
    waveformRasterCacheRef.current.clear();
    waveformRasterBytesRef.current = 0;
    waveformRasterKeyRef.current = null;
    waveformRasterHeightRef.current = 0;
  }, []);

  const resetWaveformOverview = useCallback(() => {
    waveformSamplesReadyRef.current = false;
    waveformOverviewPeaksRef.current = null;
    waveformPeaksCacheRef.current.clear();
    clearWaveformRasterCache();
    waveformBucketCountRef.current = null;
    waveformPendingBucketRef.current = null;
    waveformLastComputeAtRef.current = 0;
    waveformModeRef.current = 'loading';
    if (waveformComputeTimeoutRef.current !== null) {
      window.clearTimeout(waveformComputeTimeoutRef.current);
      waveformComputeTimeoutRef.current = null;
    }
  }, [clearWaveformRasterCache]);

  const getWaveformBucketCount = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return null;
    if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return null;

    const viewportStartMs = waveformViewportRef.current?.startMs ?? waveformViewport?.startMs ?? 0;
    const viewportEndMs = waveformViewportRef.current?.endMs ?? waveformViewport?.endMs ?? effectiveDurationMs;
    const viewportDurationMs = viewportEndMs - viewportStartMs;
    if (!(viewportDurationMs > 0)) return null;

    const zoomScale = Math.max(1, effectiveDurationMs / viewportDurationMs);
    const lodScale = Math.min(WAVEFORM_MAX_LOD_SCALE, Math.pow(2, Math.ceil(Math.log2(zoomScale))));
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const bucketCount = Math.max(WAVEFORM_MIN_BUCKET_COUNT, Math.round(width * lodScale));
    return Math.min(WAVEFORM_MAX_BUCKET_COUNT, bucketCount);
  }, [effectiveDurationMs, waveformViewport?.endMs, waveformViewport?.startMs]);

  const getWaveformRasterWidth = useCallback(
    (bucketCount: number) =>
      Math.max(WAVEFORM_RASTER_MIN_WIDTH, Math.min(bucketCount, WAVEFORM_RASTER_MAX_WIDTH)),
    [],
  );

  const formatRasterBytes = useCallback((bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`, []);

  const touchWaveformRasterCache = useCallback(
    (key: string, canvas: OffscreenCanvas | HTMLCanvasElement) => {
      const cache = waveformRasterCacheRef.current;
      let totalBytes = waveformRasterBytesRef.current;

      const existing = cache.get(key);
      if (existing) {
        totalBytes -= existing.bytes;
      }

      const rasterWidth = Math.max(1, canvas.width || 0);
      const bytes = Math.max(0, rasterWidth * Math.max(1, canvas.height || 0) * 4);
      cache.delete(key);
      cache.set(key, { canvas, bytes, rasterWidth });
      totalBytes += bytes;

      const evictOldest = () => {
        const oldest = cache.keys().next();
        if (oldest.done) return false;
        const oldestKey = oldest.value;
        const oldestEntry = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldestEntry) {
          totalBytes -= oldestEntry.bytes;
          if (import.meta.env.DEV) {
            console.debug(
              `[waveform] raster evicted (key=${oldestKey}, width=${oldestEntry.rasterWidth}, total=${formatRasterBytes(totalBytes)})`,
            );
          }
        }
        return true;
      };

      while (cache.size > WAVEFORM_RASTER_CACHE_LIMIT) {
        if (!evictOldest()) break;
      }

      while (totalBytes > WAVEFORM_RASTER_MEMORY_BUDGET_BYTES && cache.size > 0) {
        if (!evictOldest()) break;
      }

      waveformRasterBytesRef.current = totalBytes;
      return totalBytes;
    },
    [formatRasterBytes],
  );

  const getWaveformRasterKey = useCallback(
    (bucketCount: number, rasterWidth: number, height: number, dpr: number) =>
      `${bucketCount}|${rasterWidth}|${height}|${Math.round(dpr * 100)}`,
    [],
  );

  const createWaveformRasterCanvas = useCallback((width: number, height: number) => {
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(`[waveform] raster canvas creation failed (width=${width}, height=${height})`, error);
      }
      return null;
    }
  }, []);

  const downsampleWaveformPeaks = useCallback((peaks: Int16Array, sourceBucketCount: number, targetBucketCount: number) => {
    const safeTarget = Math.max(1, targetBucketCount);
    const safeSource = Math.max(1, sourceBucketCount);
    const result = new Int16Array(safeTarget * 2);
    const ratio = safeSource / safeTarget;

    for (let bucket = 0; bucket < safeTarget; bucket += 1) {
      const start = Math.floor(bucket * ratio);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * ratio));
      let min = 32767;
      let max = -32768;
      for (let source = start; source < end && source < safeSource; source += 1) {
        const sourceMin = peaks[source * 2] ?? 0;
        const sourceMax = peaks[source * 2 + 1] ?? 0;
        if (sourceMin < min) min = sourceMin;
        if (sourceMax > max) max = sourceMax;
      }
      result[bucket * 2] = min === 32767 ? 0 : min;
      result[bucket * 2 + 1] = max === -32768 ? 0 : max;
    }

    return result;
  }, []);

  const rasterizeWaveform = useCallback(
    (bucketCount: number, peaks: Int16Array, height: number, rasterWidth?: number, allowFallback = true): OffscreenCanvas | HTMLCanvasElement | null => {
      const width = Math.max(1, Math.min(rasterWidth ?? bucketCount, WAVEFORM_RASTER_MAX_WIDTH));
      const effectivePeaks = bucketCount > width ? downsampleWaveformPeaks(peaks, bucketCount, width) : peaks;
      const rasterCanvas = createWaveformRasterCanvas(width, height);
      if (!rasterCanvas) {
        clearWaveformRasterCache();
        if (allowFallback && width > WAVEFORM_RASTER_MIN_WIDTH) {
          return rasterizeWaveform(bucketCount, peaks, height, WAVEFORM_RASTER_MIN_WIDTH, false);
        }
        return null;
      }
      const context = rasterCanvas.getContext('2d');
      if (!context) {
        clearWaveformRasterCache();
        if (allowFallback && width > WAVEFORM_RASTER_MIN_WIDTH) {
          return rasterizeWaveform(bucketCount, peaks, height, WAVEFORM_RASTER_MIN_WIDTH, false);
        }
        return null;
      }

      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      context.strokeStyle = '#2b7bff';

      const halfHeight = height / 2;
      context.beginPath();
      for (let bucket = 0; bucket < width; bucket += 1) {
        const min = (effectivePeaks[bucket * 2] ?? 0) / 32768;
        const max = (effectivePeaks[bucket * 2 + 1] ?? 0) / 32767;
        const x = bucket + 0.5;
        const yMin = halfHeight + min * halfHeight;
        const yMax = halfHeight + max * halfHeight;
        context.moveTo(x, yMin);
        context.lineTo(x, yMax);
      }
      context.stroke();

      return rasterCanvas;
    },
    [
      clearWaveformRasterCache,
      createWaveformRasterCanvas,
      downsampleWaveformPeaks,
    ],
  );

  const primeWaveformRaster = useCallback(
    (bucketCount: number, peaks: Int16Array) => {
      const canvas = waveformCanvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      const targetHeight = canvas && canvas.clientHeight > 0
        ? Math.max(1, Math.round(canvas.clientHeight * dpr))
        : waveformRasterHeightRef.current;
      if (!targetHeight) return;

      const rasterWidth = getWaveformRasterWidth(bucketCount);
      const key = getWaveformRasterKey(bucketCount, rasterWidth, targetHeight, dpr);
      const cache = waveformRasterCacheRef.current;
      const cached = cache.get(key);
      if (cached) {
        const totalBytes = touchWaveformRasterCache(key, cached.canvas);
        waveformRasterKeyRef.current = key;
        if (import.meta.env.DEV) {
          console.debug(
            `[waveform] raster cache hit (key=${key}, width=${cached.rasterWidth}, total=${formatRasterBytes(totalBytes)})`,
          );
        }
        return;
      }
      if (cache.has(key)) return;

      const raster = rasterizeWaveform(bucketCount, peaks, targetHeight, rasterWidth);
      if (!raster) return;
      const finalWidth = Math.max(1, raster.width || rasterWidth);
      const finalKey = getWaveformRasterKey(bucketCount, finalWidth, targetHeight, dpr);
      const totalBytes = touchWaveformRasterCache(finalKey, raster);
      waveformRasterKeyRef.current = finalKey;
      if (import.meta.env.DEV) {
        console.debug(
          `[waveform] raster cached (key=${finalKey}, width=${finalWidth}, total=${formatRasterBytes(totalBytes)})`,
        );
      }
    },
    [formatRasterBytes, getWaveformRasterKey, getWaveformRasterWidth, rasterizeWaveform, touchWaveformRasterCache],
  );

  const xToMs = useCallback(
    (x: number, width: number) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0 || width <= 0) return null;
      const viewportStartMs = waveformViewportRef.current?.startMs ?? waveformViewport?.startMs ?? 0;
      const viewportEndMs = waveformViewportRef.current?.endMs ?? waveformViewport?.endMs ?? effectiveDurationMs;
      const viewportDurationMs = viewportEndMs - viewportStartMs;
      if (!(viewportDurationMs > 0)) return null;
      const ratio = x / width;
      const ms = viewportStartMs + ratio * viewportDurationMs;
      return Math.min(Math.max(ms, 0), effectiveDurationMs);
    },
    [effectiveDurationMs, waveformViewport?.endMs, waveformViewport?.startMs],
  );

  const msToX = useCallback(
    (ms: number, width: number) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0 || width <= 0) return null;
      const viewportStartMs = waveformViewportRef.current?.startMs ?? waveformViewport?.startMs ?? 0;
      const viewportEndMs = waveformViewportRef.current?.endMs ?? waveformViewport?.endMs ?? effectiveDurationMs;
      const viewportDurationMs = viewportEndMs - viewportStartMs;
      if (!(viewportDurationMs > 0)) return null;
      const clampedMs = Math.min(Math.max(ms, viewportStartMs), viewportEndMs);
      return ((clampedMs - viewportStartMs) / viewportDurationMs) * width;
    },
    [effectiveDurationMs, waveformViewport?.endMs, waveformViewport?.startMs],
  );

  const resetWaveformViewport = useCallback(() => {
    if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
    const clamped = clampWaveformViewport(0, effectiveDurationMs);
    if (clamped) setWaveformViewportFast(clamped);
  }, [clampWaveformViewport, effectiveDurationMs, setWaveformViewportFast]);

  const cancelWaveformFollowResume = useCallback(() => {
    if (waveformFollowResumeTimeoutRef.current !== null) {
      window.clearTimeout(waveformFollowResumeTimeoutRef.current);
      waveformFollowResumeTimeoutRef.current = null;
    }
  }, []);

  const pauseWaveformFollow = useCallback(
    (durationMs = WAVEFORM_FOLLOW_RESUME_MS) => {
      waveformFollowPausedRef.current = true;
      cancelWaveformFollowResume();
      waveformFollowResumeTimeoutRef.current = window.setTimeout(() => {
        waveformFollowPausedRef.current = false;
      }, durationMs);
    },
    [cancelWaveformFollowResume],
  );

  const zoomWaveformViewport = useCallback(
    (factor: number, anchorMs?: number | null) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      if (!Number.isFinite(factor) || factor <= 0) return;

      const current = waveformViewportRef.current ?? { startMs: 0, endMs: effectiveDurationMs };
      const currentDuration = current.endMs - current.startMs;
      if (!(currentDuration > 0)) return;

      const targetDuration = currentDuration * factor;
      const clampedAnchor = Number.isFinite(anchorMs)
        ? Math.min(Math.max(anchorMs as number, 0), effectiveDurationMs)
        : current.startMs + currentDuration / 2;

      const anchorRatio = (clampedAnchor - current.startMs) / currentDuration;
      const nextStart = clampedAnchor - anchorRatio * targetDuration;

      const next = clampWaveformViewport(nextStart, targetDuration);
      if (!next) return;
      setWaveformViewportFast(next);
    },
    [clampWaveformViewport, effectiveDurationMs, setWaveformViewportFast],
  );

  const panWaveformViewport = useCallback(
    (deltaPx: number, width: number) => {
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      if (!(width > 0)) return;
      if (!Number.isFinite(deltaPx)) return;
      pauseWaveformFollow();

      const current = waveformViewportRef.current ?? { startMs: 0, endMs: effectiveDurationMs };
      const durationMs = current.endMs - current.startMs;
      if (!(durationMs > 0)) return;

      const deltaMs = (deltaPx / width) * durationMs;
      const next = clampWaveformViewport(current.startMs + deltaMs, durationMs);
      if (!next) return;
      setWaveformViewportFast(next);
    },
    [clampWaveformViewport, effectiveDurationMs, pauseWaveformFollow, setWaveformViewportFast],
  );

  const isWaveformFollowActive = useCallback(() => {
    if (!waveformFollowEnabledRef.current || waveformFollowPausedRef.current) return false;
    if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return false;
    const viewport = waveformViewportRef.current ?? { startMs: 0, endMs: effectiveDurationMs };
    const viewportDuration = viewport.endMs - viewport.startMs;
    if (!(viewportDuration > 0)) return false;
    return viewportDuration < effectiveDurationMs;
  }, [effectiveDurationMs]);

  const recenterWaveformViewport = useCallback(
    (ms: number) => {
      if (!isWaveformFollowActive()) return;
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;

      const current = waveformViewportRef.current ?? { startMs: 0, endMs: effectiveDurationMs };
      const viewportDuration = current.endMs - current.startMs;
      if (!(viewportDuration > 0)) return;

      const desiredStart = ms - viewportDuration * WAVEFORM_PLAYHEAD_RATIO;
      const next = clampWaveformViewport(desiredStart, viewportDuration);
      if (!next) return;

      if (
        Math.abs(next.startMs - current.startMs) < 0.1 &&
        Math.abs(next.endMs - current.endMs) < 0.1
      ) {
        return;
      }

      setWaveformViewportFast(next);
    },
    [clampWaveformViewport, effectiveDurationMs, isWaveformFollowActive, setWaveformViewportFast],
  );

  useEffect(() => {
    if (typeof currentTimeMs !== 'number') return;
    recenterWaveformViewport(currentTimeMs);
  }, [currentTimeMs, recenterWaveformViewport]);

  useEffect(() => {
    return () => {
      cancelWaveformFollowResume();
    };
  }, [cancelWaveformFollowResume]);

  const seekToMs = useCallback(
    (ms: number) => {
      const videoElement = videoRef.current;
      if (!videoElement) return;
      if (!Number.isFinite(ms)) return;
      videoElement.currentTime = ms / 1000;
      commitCurrentTimeMs(ms);
      recenterWaveformViewport(ms);
    },
    [commitCurrentTimeMs, recenterWaveformViewport],
  );

  const handleWaveformPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = waveformCanvasRef.current;
      const videoElement = videoRef.current;
      if (!canvas || !videoElement) return;
      // 좌클릭(또는 기본 포인터)만 처리
      if (typeof event.button === 'number' && event.button !== 0) return;

      // 모바일에서 스크롤/줌 제스처와 섞이지 않게 최소 방어
      event.preventDefault();

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      // 포인터 안정성(지금은 down만 쓰지만, 기본 방어로 캡처)
      if (typeof canvas.setPointerCapture === 'function') {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }

      const ms = xToMs(event.clientX - rect.left, rect.width);
      if (typeof ms !== 'number') return;

      waveformScrubPointerIdRef.current = event.pointerId;
      waveformPendingSeekMsRef.current = ms;
      seekToMs(ms);
    },
    [seekToMs, xToMs],
  );
  
  const handleWaveformPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const activePointerId = waveformScrubPointerIdRef.current;
      if (activePointerId === null || activePointerId !== event.pointerId) return;

      const canvas = waveformCanvasRef.current;
      if (!canvas) return;

      event.preventDefault();
      pauseWaveformFollow();

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;

      const ms = xToMs(event.clientX - rect.left, rect.width);
      if (typeof ms !== 'number') return;

      waveformPendingSeekMsRef.current = ms;

      if (waveformScrubRafIdRef.current !== null) return;
      waveformScrubRafIdRef.current = window.requestAnimationFrame(() => {
        waveformScrubRafIdRef.current = null;
        const pending = waveformPendingSeekMsRef.current;
        if (typeof pending === 'number') seekToMs(pending);
      });
    },
    [pauseWaveformFollow, seekToMs, xToMs],
  );

  const handleWaveformPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const activePointerId = waveformScrubPointerIdRef.current;
      if (activePointerId === null || activePointerId !== event.pointerId) return;

      const canvas = waveformCanvasRef.current;
      waveformScrubPointerIdRef.current = null;

      if (waveformScrubRafIdRef.current !== null) {
        window.cancelAnimationFrame(waveformScrubRafIdRef.current);
        waveformScrubRafIdRef.current = null;
      }

      const pending = waveformPendingSeekMsRef.current;
      waveformPendingSeekMsRef.current = null;
      if (typeof pending === 'number') seekToMs(pending);

      if (canvas && typeof canvas.releasePointerCapture === 'function') {
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
    },
    [seekToMs],
  );

  const handleWaveformWheel = useCallback(
    (event: WheelEvent) => {
      const canvas = waveformCanvasRef.current;
      if (!canvas) return;
      if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;
      if (waveformScrubPointerIdRef.current !== null) return;

      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0)) return;

      // 페이지 스크롤 방지(필수: passive:false로 붙여야 먹힘)
      event.preventDefault();
      pauseWaveformFollow();

      const rawDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      const deltaMode = event.deltaMode ?? 0; // 0=pixel, 1=line, 2=page
      const linePx = 16;
      const pagePx = rect.width;
      const scaled =
        deltaMode === 1 ? rawDelta * linePx : deltaMode === 2 ? rawDelta * pagePx : rawDelta;

      const maxAbs = rect.width * 2;
      const deltaPx = Math.max(-maxAbs, Math.min(maxAbs, scaled));

      const nextType: 'zoom' | 'pan' = event.altKey ? 'zoom' : 'pan';
      const anchorX = event.clientX - rect.left;

      const prev = waveformPendingWheelRef.current;
      if (prev && prev.type === nextType) {
        prev.deltaPx += deltaPx;
        prev.width = rect.width;
        if (prev.type === 'zoom') (prev as { anchorX: number }).anchorX = anchorX;
      } else {
        waveformPendingWheelRef.current =
          nextType === 'zoom'
            ? { type: 'zoom', deltaPx, width: rect.width, anchorX }
            : { type: 'pan', deltaPx, width: rect.width };
      }

      if (waveformWheelRafIdRef.current !== null) return;
      waveformWheelRafIdRef.current = window.requestAnimationFrame(() => {
        waveformWheelRafIdRef.current = null;
        const pending = waveformPendingWheelRef.current;
        waveformPendingWheelRef.current = null;
        if (!pending) return;

        if (pending.type === 'zoom') {
          const anchorMs = xToMs(pending.anchorX, pending.width);
          // 트랙패드/휠 둘 다 자연스럽게: 지수 스케일
          const zoomFactor = Math.exp(pending.deltaPx * 0.001);
          zoomWaveformViewport(zoomFactor, anchorMs);
        } else {
          panWaveformViewport(pending.deltaPx, pending.width);
        }

      });
    },
    [effectiveDurationMs, panWaveformViewport, pauseWaveformFollow, xToMs, zoomWaveformViewport],
  );

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => handleWaveformWheel(e);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [handleWaveformWheel]);

  const renderOverviewWaveformNow = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    if (typeof effectiveDurationMs !== 'number' || effectiveDurationMs <= 0) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    waveformRasterHeightRef.current = height;

    const peaks = waveformOverviewPeaksRef.current;
    const bucketCount = waveformBucketCountRef.current;

    const viewportStartMs = waveformViewportRef.current?.startMs ?? waveformViewport?.startMs ?? 0;
    const viewportEndMs = waveformViewportRef.current?.endMs ?? waveformViewport?.endMs ?? effectiveDurationMs;
    const viewportDurationMs = viewportEndMs - viewportStartMs;
    if (!(viewportDurationMs > 0)) return;

    const cache = waveformRasterCacheRef.current;
    const targetRasterWidth = bucketCount && bucketCount > 0 ? getWaveformRasterWidth(bucketCount) : null;
    const targetKey = bucketCount && bucketCount > 0 && targetRasterWidth
      ? getWaveformRasterKey(bucketCount, targetRasterWidth, height, dpr)
      : null;

    let rasterCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

    if (targetKey) {
      const cached = cache.get(targetKey) ?? null;
      if (cached) {
        const totalBytes = touchWaveformRasterCache(targetKey, cached.canvas);
        waveformRasterKeyRef.current = targetKey;
        rasterCanvas = cached.canvas;
        if (import.meta.env.DEV) {
          console.debug(
            `[waveform] raster cache hit (key=${targetKey}, width=${cached.rasterWidth}, total=${formatRasterBytes(totalBytes)})`,
          );
        }
      }
    }

    if (!rasterCanvas && peaks && bucketCount && targetRasterWidth && targetKey) {
      const generated = rasterizeWaveform(bucketCount, peaks, height, targetRasterWidth);
      if (generated) {
        const finalWidth = Math.max(1, generated.width || targetRasterWidth);
        const finalKey = getWaveformRasterKey(bucketCount, finalWidth, height, dpr);
        const totalBytes = touchWaveformRasterCache(finalKey, generated);
        waveformRasterKeyRef.current = finalKey;
        rasterCanvas = generated;
        if (import.meta.env.DEV) {
          console.debug(
            `[waveform] raster cached (key=${finalKey}, width=${finalWidth}, total=${formatRasterBytes(totalBytes)})`,
          );
        }
      }
    }

    if (!rasterCanvas && waveformRasterKeyRef.current) {
      rasterCanvas = cache.get(waveformRasterKeyRef.current)?.canvas ?? null;
    }

    context.clearRect(0, 0, width, height);

    if (rasterCanvas) {
      const rasterWidth = Math.max(1, rasterCanvas.width);
      const sourceStartX = (viewportStartMs / effectiveDurationMs) * rasterWidth;
      const sourceWidth = (viewportDurationMs / effectiveDurationMs) * rasterWidth;
      const maxStart = Math.max(0, rasterWidth - 1);
      const clampedStart = Math.max(0, Math.min(maxStart, sourceStartX));
      const maxWidth = rasterWidth - clampedStart;
      const clampedWidth = Math.max(1, Math.min(maxWidth, sourceWidth));

      context.drawImage(
        rasterCanvas,
        clampedStart,
        0,
        clampedWidth,
        rasterCanvas.height,
        0,
        0,
        width,
        height,
      );
    }

    const currentMs = currentTimeMsRef.current;
    if (typeof currentMs === 'number') {
      const x = msToX(currentMs, width);
      if (typeof x === 'number') {
        context.strokeStyle = '#ef4444';
        context.lineWidth = 1;
        context.beginPath();
        const alignedX = x + 0.5;
        context.moveTo(alignedX, 0);
        context.lineTo(alignedX, height);
        context.stroke();
      }
    }
  }, [
    effectiveDurationMs,
    formatRasterBytes,
    getWaveformRasterWidth,
    getWaveformRasterKey,
    msToX,
    rasterizeWaveform,
    touchWaveformRasterCache,
    waveformViewport?.endMs,
    waveformViewport?.startMs,
  ]);

  const scheduleRenderOverviewWaveform = useCallback(() => {
    if (waveformOverviewRenderRafIdRef.current !== null) return;
    waveformOverviewRenderRafIdRef.current = window.requestAnimationFrame(() => {
      waveformOverviewRenderRafIdRef.current = null;
      renderOverviewWaveformNow();
    });
  }, [renderOverviewWaveformNow]);

  useEffect(() => {
    return () => {
      if (waveformWheelRafIdRef.current !== null) {
        window.cancelAnimationFrame(waveformWheelRafIdRef.current);
        waveformWheelRafIdRef.current = null;
      }
      if (waveformOverviewRenderRafIdRef.current !== null) {
        window.cancelAnimationFrame(waveformOverviewRenderRafIdRef.current);
        waveformOverviewRenderRafIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    renderOverviewWaveformRef.current = scheduleRenderOverviewWaveform;
  }, [scheduleRenderOverviewWaveform]);

  const applyCachedWaveformPeaks = useCallback(
    (bucketCount: number) => {
      const cache = waveformPeaksCacheRef.current;
      const cached = cache.get(bucketCount);
      if (!cached) return false;

      cache.delete(bucketCount);
      cache.set(bucketCount, cached);
      waveformOverviewPeaksRef.current = cached;
      waveformBucketCountRef.current = bucketCount;
      waveformLastComputeAtRef.current = Date.now();
      waveformPendingBucketRef.current = null;
      primeWaveformRaster(bucketCount, cached);
      if (import.meta.env.DEV) {
        console.debug(`[waveform] peaks cache hit (bucketCount=${bucketCount}, entries=${cache.size})`);
      }
      scheduleRenderOverviewWaveform();
      return true;
    },
    [primeWaveformRaster, scheduleRenderOverviewWaveform],
  );

  const storeWaveformPeaks = useCallback(
    (bucketCount: number, peaks: Int16Array) => {
      const cache = waveformPeaksCacheRef.current;
      cache.set(bucketCount, peaks);
      if (cache.size > WAVEFORM_PEAK_CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      if (import.meta.env.DEV) {
        console.debug(`[waveform] peaks cached (bucketCount=${bucketCount}, entries=${cache.size})`);
      }

      waveformOverviewPeaksRef.current = peaks;
      waveformBucketCountRef.current = bucketCount;
      waveformLastComputeAtRef.current = Date.now();
      waveformPendingBucketRef.current = null;
      primeWaveformRaster(bucketCount, peaks);
      scheduleRenderOverviewWaveform();
    },
    [primeWaveformRaster, scheduleRenderOverviewWaveform],
  );

  const computeOverviewPeaks = useCallback(
    async (bucketCount: number) => {
      try {
        const token = waveformComputeTokenRef.current + 1;
        waveformComputeTokenRef.current = token;
        const response = await postWaveformWorkerMessage({ type: 'compute-peaks', bucketCount });
        if (response.type !== 'peaks-ready') return;
        if (token !== waveformComputeTokenRef.current) return;

        const peaks = new Int16Array(response.peaks);
        storeWaveformPeaks(response.bucketCount, peaks);

        if (import.meta.env.DEV) {
          console.debug(
            `[waveform] overview peaks computed in ${response.durationMs.toFixed(1)}ms via ${response.impl}`,
          );
        }

      } catch (error) {
        console.error('[waveform] peak computation failed', error);
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
      }
    },
    [postWaveformWorkerMessage, storeWaveformPeaks],
  );

  const queueWaveformComputation = useCallback(
    (bucketCount: number | null) => {
      if (!bucketCount || bucketCount <= 0 || shouldUseLiveWaveform) return;

      if (applyCachedWaveformPeaks(bucketCount)) return;

      waveformPendingBucketRef.current = bucketCount;

      if (waveformComputeTimeoutRef.current !== null) {
        window.clearTimeout(waveformComputeTimeoutRef.current);
      }

      const now = Date.now();
      if (waveformBucketCountRef.current === bucketCount && now - waveformLastComputeAtRef.current < 1000) {
        scheduleRenderOverviewWaveform();
        return;
      }

      const delay = waveformLastComputeAtRef.current === 0
        ? 0
        : Math.max(0, 1000 - (now - waveformLastComputeAtRef.current));

      waveformComputeTimeoutRef.current = window.setTimeout(() => {
        waveformComputeTimeoutRef.current = null;
        const pendingBucketCount = waveformPendingBucketRef.current;
        if (!waveformSamplesReadyRef.current || typeof pendingBucketCount !== 'number') return;
        void computeOverviewPeaks(pendingBucketCount);
      }, delay);
    },
    [applyCachedWaveformPeaks, computeOverviewPeaks, scheduleRenderOverviewWaveform, shouldUseLiveWaveform],
  );

  useEffect(() => {
    resetWaveformOverview();
    setShouldUseLiveWaveform(false);

    if (!videoBlob) return undefined;

    let cancelled = false;

    const decodeWaveform = async () => {
      const AudioContextClass =
        window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
        return;
      }

      let context: AudioContext | null = null;

      try {
        context = new AudioContextClass();
        waveformModeRef.current = 'loading';

        const audioBuffer = await videoBlob.arrayBuffer();
        const decoded = await context.decodeAudioData(audioBuffer.slice(0));
        if (cancelled) return;

        const firstChannel = decoded.getChannelData(0);
        let samples: Float32Array;

        if (decoded.numberOfChannels >= 2) {
          // 기본은 첫 번째 채널, 2채널인 경우 좌/우 평균을 사용한다.
          const secondChannel = decoded.getChannelData(1);
          samples = new Float32Array(firstChannel.length);
          for (let i = 0; i < samples.length; i += 1) {
            const left = firstChannel[i] ?? 0;
            const right = secondChannel[i] ?? 0;
            samples[i] = (left + right) / 2;
          }
        } else {
          samples = new Float32Array(firstChannel);
        }

        const response = await postWaveformWorkerMessage(
          { type: 'load-samples', samples: samples.buffer as ArrayBuffer },
          [samples.buffer],
        );
        if (cancelled) return;
        if (response.type !== 'samples-loaded') throw new Error('waveform-load-failed');

        waveformSamplesReadyRef.current = true;
        waveformModeRef.current = 'overview';

        const bucketCount = getWaveformBucketCount();
        queueWaveformComputation(bucketCount ?? Math.min(samples.length, 4096));
      } catch (error) {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.debug('[waveform] overview fallback', error);
        }
        waveformSamplesReadyRef.current = false;
        waveformOverviewPeaksRef.current = null;
        resetWaveformOverview();
        setShouldUseLiveWaveform(true);
        waveformModeRef.current = 'live';
      } finally {
        if (context) void context.close().catch(() => null);
      }
    };

    void decodeWaveform();

    return () => {
      cancelled = true;
    };
  }, [getWaveformBucketCount, postWaveformWorkerMessage, queueWaveformComputation, resetWaveformOverview, videoBlob]);

  useEffect(() => {
    if (shouldUseLiveWaveform) return undefined;

    const canvas = waveformCanvasRef.current;
    if (!canvas) return undefined;

    const handleResize = () => {
      const bucketCount = getWaveformBucketCount();
      if (bucketCount && bucketCount !== waveformBucketCountRef.current) {
        queueWaveformComputation(bucketCount);
      }
      scheduleRenderOverviewWaveform();
    };

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    if (observer) observer.observe(canvas);
    window.addEventListener('resize', handleResize);

    handleResize();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
      if (waveformComputeTimeoutRef.current !== null) {
        window.clearTimeout(waveformComputeTimeoutRef.current);
        waveformComputeTimeoutRef.current = null;
      }
    };
  }, [getWaveformBucketCount, queueWaveformComputation, scheduleRenderOverviewWaveform, shouldUseLiveWaveform]);

  useEffect(() => {
    if (shouldUseLiveWaveform) return;
    const bucketCount = getWaveformBucketCount();
    queueWaveformComputation(bucketCount);
  }, [
    getWaveformBucketCount,
    queueWaveformComputation,
    shouldUseLiveWaveform,
    waveformViewport?.endMs,
    waveformViewport?.startMs,
    waveformViewportDurationMs,
  ]);

  useEffect(() => {
    if (shouldUseLiveWaveform) return;
    scheduleRenderOverviewWaveform();
  }, [scheduleRenderOverviewWaveform, shouldUseLiveWaveform, currentTimeMs]);

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
    if (typeof currentTimeMsRef.current === 'number') {
      const x = msToX(currentTimeMsRef.current, width);
      if (typeof x === 'number') {
        context.strokeStyle = '#ef4444';
        context.lineWidth = Math.max(1, dpr * 1.2);
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
    }
    waveformRafIdRef.current = window.requestAnimationFrame(drawWaveform);
  }, [msToX]);

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
    if (!videoElement || !videoUrl || !shouldUseLiveWaveform) return undefined;

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
  }, [shouldUseLiveWaveform, startWaveform, stopWaveform, videoUrl]);

  useEffect(() => {
    if (!shouldUseLiveWaveform) {
      stopWaveform();
    }
  }, [shouldUseLiveWaveform, stopWaveform]);

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
    (next: TrimRange) => {
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

  const handleTrimSecondsChange = useCallback((field: 'start' | 'end', value: string) => {
    setTrimInputSeconds((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleTrimSecondsFocus = useCallback(
    (field: 'start' | 'end') => () => {
      trimInputFocusRef.current = field;
    },
    [],
  );

  const handleTrimSecondsBlur = useCallback(
    (field: 'start' | 'end') => (event: ReactFocusEvent<HTMLInputElement>) => {
      trimInputFocusRef.current = null;
      const raw = event.currentTarget.value;
      const value = raw.replace(',', '.');
      setTrimInputSeconds((prev) => ({ ...prev, [field]: value }));

      const parsedSeconds = Number.parseFloat(value);
      const currentRange = trimRangeRef.current ?? trimRange;
      if (!currentRange || !Number.isFinite(parsedSeconds)) {
        setTrimInputSeconds({
          start: trimRangeSummary?.startSeconds ?? '',
          end: trimRangeSummary?.endSeconds ?? '',
        });
        return;
      }

      const normalizedSeconds = Math.max(0, Math.round(parsedSeconds * 100) / 100);
      const targetMs = Math.round(normalizedSeconds * 1000);
      const nextRange =
        field === 'start'
          ? { startMs: targetMs, endMs: currentRange.endMs }
          : { startMs: currentRange.startMs, endMs: targetMs };

      updateTrimRange(nextRange);

      const normalized = normalizeTrimRange(nextRange, effectiveDurationMs);
      if (normalized) {
        setTrimInputSeconds({
          start: formatSeconds(normalized.trimStart),
          end: formatSeconds(normalized.trimEnd),
        });
      }
    },
    [effectiveDurationMs, trimRange, trimRangeSummary?.endSeconds, trimRangeSummary?.startSeconds, updateTrimRange],
  );

  const applyTrimFromCurrentTime = useCallback(
    (field: 'start' | 'end') => {
      if (typeof effectiveDurationMs !== 'number') return;

      const nowMs = getCurrentTimeMs();
      if (!Number.isFinite(nowMs)) return;

      const snapped = snapToStep(nowMs, snapStepMs);
      const clamped = clampToDuration(snapped);
      const base =
        normalizedTrimRangeRef.current ?? normalizeTrimRange(trimRangeRef.current, effectiveDurationMs);
      if (!base) return;

      const draftStart = field === 'start' ? clamped : Math.min(base.trimStart, clamped);
      const draftEnd = field === 'end' ? clamped : Math.max(base.trimEnd, clamped);
      const normalized = normalizeTrimRange({ startMs: draftStart, endMs: draftEnd }, effectiveDurationMs);
      if (!normalized) return;

      const nextRange = { startMs: normalized.trimStart, endMs: normalized.trimEnd };
      updateTrimRange(nextRange);

      setTrimInputSeconds((prev) => {
        const startText = formatSeconds(normalized.trimStart);
        const endText = formatSeconds(normalized.trimEnd);
        return {
          start: field === 'start' ? startText : trimInputFocusRef.current === 'start' ? prev.start : startText,
          end: field === 'end' ? endText : trimInputFocusRef.current === 'end' ? prev.end : endText,
        };
      });
    },
    [clampToDuration, effectiveDurationMs, getCurrentTimeMs, snapStepMs, updateTrimRange],
  );
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    updateCurrentTime({ enforceTrimLoop: true });

    const handleTimeUpdate = () => updateCurrentTime({ enforceTrimLoop: true });
    const handleSeeked = () => updateCurrentTime({ enforceTrimLoop: true });
    const handleSeeking = () => updateCurrentTime({ enforceTrimLoop: true });
    const handleLoadedMetadata = () => updateCurrentTime({ enforceTrimLoop: true });
    const handlePlay = () => {
      clampPlaybackToTrimOnPlay();
      updateCurrentTime({ enforceTrimLoop: true });
      scheduleTimeTracking();
    };
    const handlePause = () => {
      updateCurrentTime({ enforceTrimLoop: true });
      cancelTimeTracking();
    };
    const handleEnded = () => {
      updateCurrentTime({ enforceTrimLoop: true });
      cancelTimeTracking();
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeking', handleSeeking);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);

    if (!video.paused && !video.ended) {
      scheduleTimeTracking();
    }

    return () => {
      cancelTimeTracking();
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeking', handleSeeking);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
    };
  }, [videoUrl, cancelTimeTracking, clampPlaybackToTrimOnPlay, scheduleTimeTracking, updateCurrentTime]);

  return (
    <main className="video-detail-page">
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
        <div className="video-detail-sections">
          <section
            className="video-detail-meta"
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
            className="video-detail-captions"
            style={{
              padding: 16,
              borderRadius: 10,
              border: '1px solid #e6e6e6',
              background: '#fff',
              // 자막 리스트가 길어지면 섹션 내부에서 스크롤되도록
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              maxHeight: '100vh',
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

            <div
              style={{
                display: 'grid',
                gap: 10,
                padding: 12,
                borderRadius: 10,
                border: '1px solid #e6e6e6',
                background: '#f8fafc',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14, color: '#111' }}>단축키 설정</strong>
                <span style={{ fontSize: 12, color: '#555' }}>
                  입력창 포커스 상태에서도 동작하며, IME 조합 중에는 동작하지 않아요.
                </span>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => {
                    setCapturingHotkey(null);
                    setHotkeyConfig({ ...DEFAULT_HOTKEYS });
                  }}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    background: '#fff',
                    color: '#111',
                    cursor: 'pointer',
                  }}
                >
                  기본값 복원
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gap: 8,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                }}
              >
                {hotkeyItems.map((item) => {
                  const isCapturing = capturingHotkey === item.key;
                  return (
                    <div
                      key={item.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid #e2e8f0',
                        background: '#fff',
                      }}
                    >
                      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                        <span style={{ fontSize: 13, color: '#111', fontWeight: 600 }}>{item.label}</span>
                        <span style={{ fontSize: 12, color: '#555', wordBreak: 'keep-all' }}>
                          {item.description}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCapturingHotkey(item.key)}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: isCapturing ? '1px solid #111' : '1px solid #cbd5e1',
                          background: isCapturing ? '#111' : '#f8fafc',
                          color: isCapturing ? '#fff' : '#111',
                          cursor: 'pointer',
                          minWidth: 120,
                        }}
                      >
                        {isCapturing ? '입력 대기… (Esc)' : formatKeyLabel(hotkeyConfig[item.key])}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <strong style={{ fontSize: 14, color: '#111' }}>자동 시간 간격</strong>
                <span style={{ fontSize: 12, color: '#555' }}>
                  Enter로 자막을 확정하면 다음 자막의 시작 시간을 이전 종료 시간 뒤로 맞춰줘요.
                </span>
                <div style={{ flex: 1 }} />
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: '#111',
                  }}
                >
                  간격(ms)
                  <input
                    type="number"
                    min={0}
                    value={captionGapMs}
                    onChange={(e) => setCaptionGapMs(parseCaptionGapMs(e.target.value))}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid #cbd5e1',
                      width: 100,
                    }}
                  />
                </label>
              </div>
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
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  paddingRight: 6,
                }}
              >
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
                          <textarea
                            value={caption.text}
                            onChange={(e) => handleCaptionFieldChange(caption.id, 'text', e.target.value)}
                            onFocus={() => setLastFocusedCaptionId(caption.id)}
                            onKeyDown={(e) => {
                              if (e.nativeEvent.isComposing) return;
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleConfirmCaption(caption.id);
                              }
                            }}
                            placeholder="자막을 입력하세요"
                            rows={3}
                            style={{
                              padding: '8px 10px',
                              borderRadius: 6,
                              border: '1px solid #ccc',
                              resize: 'vertical',
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
              </div>
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
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={applyTrimOnExport}
                  disabled={!trimRange}
                  onChange={(event) => setApplyTrimOnExport(event.target.checked)}
                />
                <span style={{ fontSize: 14, color: '#111' }}>
                  선택 구간만 내보내기
                  <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(시작 시간을 0으로 맞춰 저장)</span>
                  {!trimRange ? (
                    <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(트림 구간을 먼저 선택)</span>
                  ) : null}
                </span>
              </label>
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

            {applyTrimOnExport ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  border: '1px solid #e6e6e6',
                  borderRadius: 10,
                  background: '#fafafa',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={handleTrimExport}
                    disabled={
                      isTrimming ||
                      isBlobLoading ||
                      Boolean(videoBlobError) ||
                      !videoBlob ||
                      !normalizedTrimRange
                    }
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: '1px solid #222',
                      background: '#111',
                      color: '#fff',
                      cursor: isTrimming ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {isTrimming ? '구간 내보내는 중…' : '구간 mp4 내보내기'}
                  </button>
                  {isTrimming ? (
                    <button
                      type="button"
                      onClick={handleCancelTrim}
                      style={{
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid #b00020',
                        background: '#fff6f6',
                        color: '#b00020',
                        cursor: 'pointer',
                      }}
                    >
                      작업 취소
                    </button>
                  ) : null}
                </div>
                <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
                  선택한 구간만 mp4로 잘라내요. 지원: mp4 · 길이 30초 이하 또는 50MB 이하.{' '}
                  {trimRangeSummary
                    ? `선택 범위 ${trimRangeSummary.durationSeconds}s (${formatMsWithSeconds(trimRangeSummary.startMs)} ~ ${formatMsWithSeconds(trimRangeSummary.endMs)}).`
                    : '유효한 트림 구간을 선택해 주세요.'}
                </p>
                {trimProgress !== null || trimMessage ? (
                  <div style={{ color: '#111', fontSize: 14, lineHeight: 1.4 }}>
                    {trimProgress !== null ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div
                          style={{
                            flex: '0 0 160px',
                            height: 8,
                            borderRadius: 999,
                            background: '#e5e5e5',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(Math.min(1, Math.max(0, trimProgress)) * 100)}%`,
                              height: '100%',
                              background: '#4a90e2',
                            }}
                          />
                        </div>
                        <span style={{ color: '#333', fontSize: 13 }}>
                          {Math.round(Math.min(1, Math.max(0, trimProgress)) * 100)}%
                        </span>
                      </div>
                    ) : null}
                    {trimMessage ? <div style={{ marginTop: 4, color: '#333' }}>{trimMessage}</div> : null}
                  </div>
                ) : null}
                {trimResultUrl && trimFileName ? (
                  <div style={{ fontSize: 14 }}>
                    <a
                      href={trimResultUrl}
                      download={trimFileName}
                      style={{ color: '#0b74de', textDecoration: 'underline' }}
                    >
                      트림된 mp4 다시 저장하기
                    </a>
                  </div>
                ) : null}
                {trimError ? (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid #f2c4c4',
                      background: '#fff6f6',
                      color: '#b00020',
                      fontSize: 14,
                    }}
                  >
                    <p style={{ margin: '0 0 4px' }}>{trimError}</p>
                    <p style={{ margin: 0, color: '#b00020', fontSize: 12 }}>DEV 로그는 콘솔을 확인하세요.</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              style={{
                marginTop: 12,
                padding: 12,
                border: '1px solid #e6e6e6',
                borderRadius: 10,
                background: '#fafafa',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={handleBurnInExport}
                  disabled={
                    isBurningIn ||
                    isBlobLoading ||
                    Boolean(videoBlobError) ||
                    !videoBlob ||
                    captionDrafts.length === 0
                  }
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid #222',
                    background: '#111',
                    color: '#fff',
                    cursor: isBurningIn ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isBurningIn ? '번인 내보내는 중…' : '자막 번인 mp4 내보내기'}
                </button>
                {isBurningIn ? (
                  <button
                    type="button"
                    onClick={handleCancelBurnIn}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 8,
                      border: '1px solid #b00020',
                      background: '#fff6f6',
                      color: '#b00020',
                      cursor: 'pointer',
                    }}
                  >
                    작업 취소
                  </button>
                ) : null}
              </div>
              <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
                지원: mp4 · 길이 30초 이하 또는 50MB 이하. 진행 중에도 다른 작업은 그대로 사용할 수 있어요.
              </p>
              {burnInProgress !== null || burnInMessage ? (
                <div style={{ color: '#111', fontSize: 14, lineHeight: 1.4 }}>
                  {burnInProgress !== null ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <div
                        style={{
                          flex: '0 0 160px',
                          height: 8,
                          borderRadius: 999,
                          background: '#e5e5e5',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%`,
                            height: '100%',
                            background: '#4a90e2',
                          }}
                        />
                      </div>
                      <span style={{ color: '#333', fontSize: 13 }}>
                        {Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%
                      </span>
                    </div>
                  ) : null}
                  {burnInMessage ? <div style={{ marginTop: 4, color: '#333' }}>{burnInMessage}</div> : null}
                </div>
              ) : null}
              {burnInResultUrl && burnInFileName ? (
                <div style={{ fontSize: 14 }}>
                  <a
                    href={burnInResultUrl}
                    download={burnInFileName}
                    style={{ color: '#0b74de', textDecoration: 'underline' }}
                  >
                    번인된 mp4 다시 저장하기
                  </a>
                </div>
              ) : null}
              {burnInError ? (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #f2c4c4',
                    background: '#fff6f6',
                    color: '#b00020',
                    fontSize: 14,
                  }}
                >
                  <p style={{ margin: '0 0 4px' }}>{burnInError}</p>
                  <p style={{ margin: 0, color: '#b00020', fontSize: 12 }}>
                    DEV 로그는 콘솔을 확인하세요.
                  </p>
                </div>
              ) : null}
            </div>

            {importError ? (
              <p style={{ margin: '8px 0 0', color: '#b00020' }}>{importError}</p>
            ) : null}
          </section>

          <section
            className="video-detail-thumbnail"
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
            className="video-detail-player"
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
                <div style={{ fontWeight: 700, marginBottom: 6 }}>영상 파일을 불러오지 못했어요.</div>
                <div style={{ fontSize: 13 }}>
                  {videoBlobError instanceof Error
                    ? videoBlobError.message
                    : '알 수 없는 오류가 발생했어요.'}
                </div>
              </div>
            ) : videoUrl ? (
              <>
                <div style={{ position: 'relative' }}>
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
                  {activeCaptionText ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: 24,
                        transform: 'translateX(-50%)',
                        background: 'rgba(0, 0, 0, 0.7)',
                        color: '#fff',
                        borderRadius: 8,
                        padding: '8px 12px',
                        maxWidth: 'calc(100% - 24px)',
                        textAlign: 'center',
                        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.25)',
                        fontSize: 16,
                        lineHeight: 1.5,
                        pointerEvents: 'none',
                      }}
                    >
                      {activeCaptionText}
                    </div>
                  ) : null}
                </div>
                <WebglPreviewView
                  isSupported={isWebglSupported}
                  isReady={isWebglReady}
                  isGrayscale={isGrayscale}
                  onGrayscaleChange={handleGrayscaleChange}
                  containerRef={webglContainerRef}
                  canvasRef={webglCanvasRef}
                  videoWidth={video?.width}
                  videoHeight={video?.height}
                />
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
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        flex: 1,
                        justifyContent: 'flex-end',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                          gap: 8,
                          fontSize: 13,
                          flex: 1,
                        }}
                      >
                        <div
                          style={{
                            color: '#111',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          시작: <strong>{selection ? formatMsWithSeconds(selection.startMs) : '--'}</strong>
                        </div>
                        <div
                          style={{
                            color: '#111',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          종료: <strong>{selection ? formatMsWithSeconds(selection.endMs) : '--'}</strong>
                        </div>
                        <div
                          style={{
                            color: '#555',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          길이: {selection ? formatMsWithSeconds(selection.durationMs) : '--'}
                        </div>
                      </div>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          color: '#111',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={shouldLoopTrim}
                          disabled={!trimRangeSummary}
                          onChange={(event) => setShouldLoopTrim(event.target.checked)}
                        />
                        <span>트림 구간만 반복 재생</span>
                      </label>
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
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: 12,
                    }}
                  >
                    <label style={{ display: 'grid', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#555' }}>시작 (초)</span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.01}
                          value={trimInputSeconds.start}
                          onFocus={handleTrimSecondsFocus('start')}
                          onChange={(event) => handleTrimSecondsChange('start', event.target.value)}
                          onBlur={handleTrimSecondsBlur('start')}
                          onDoubleClick={() => applyTrimFromCurrentTime('start')}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => applyTrimFromCurrentTime('start')}
                          disabled={!canApplyTrimFromCurrentTime}
                          aria-label="현재 시간으로 시작 설정"
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            background: '#f8fafc',
                            color: '#111',
                            cursor: canApplyTrimFromCurrentTime ? 'pointer' : 'not-allowed',
                          }}
                        >
                          현재
                        </button>
                      </div>
                    </label>
                    <label style={{ display: 'grid', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#555' }}>종료 (초)</span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.01}
                          value={trimInputSeconds.end}
                          onFocus={handleTrimSecondsFocus('end')}
                          onChange={(event) => handleTrimSecondsChange('end', event.target.value)}
                          onBlur={handleTrimSecondsBlur('end')}
                          onDoubleClick={() => applyTrimFromCurrentTime('end')}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => applyTrimFromCurrentTime('end')}
                          disabled={!canApplyTrimFromCurrentTime}
                          aria-label="현재 시간으로 종료 설정"
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid #cbd5e1',
                            background: '#f8fafc',
                            color: '#111',
                            cursor: canApplyTrimFromCurrentTime ? 'pointer' : 'not-allowed',
                          }}
                        >
                          현재
                        </button>
                      </div>
                    </label>
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
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ color: '#333', fontSize: 14 }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>오디오 파형</p>
                      <p style={{ margin: 0, fontSize: 12, color: '#475569' }}>
                        Alt + 휠: 줌 · 휠: 이동
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => zoomWaveformViewport(0.8)}
                        disabled={typeof effectiveDurationMs !== 'number'}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: typeof effectiveDurationMs === 'number' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => zoomWaveformViewport(1.25)}
                        disabled={typeof effectiveDurationMs !== 'number'}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: typeof effectiveDurationMs === 'number' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        -
                      </button>
                      <button
                        type="button"
                        onClick={resetWaveformViewport}
                        disabled={typeof effectiveDurationMs !== 'number'}
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #d0d7e2',
                          background: '#fff',
                          cursor: typeof effectiveDurationMs === 'number' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        Fit
                      </button>
                    </div>
                  </div>
                  <canvas
                    ref={waveformCanvasRef}
                    onPointerDown={handleWaveformPointerDown}
                    onPointerMove={handleWaveformPointerMove}
                    onPointerUp={handleWaveformPointerUp}
                    onPointerCancel={handleWaveformPointerUp}
                    style={{
                      width: '100%',
                      height: 96,
                      display: 'block',
                      cursor: 'pointer',
                      touchAction: 'none',
                      overscrollBehavior: 'contain',
                    }}
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
