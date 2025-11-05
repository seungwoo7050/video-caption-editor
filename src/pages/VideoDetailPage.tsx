import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { dataSource } from '@/datasource';
import { dataSourceKind } from '@/datasource';
import type { Caption, Video } from '@/datasource/types';
import { queryClient } from '@/lib/queryClient';
import type { CaptionWorkerRequest, CaptionWorkerResponse } from '@/workers/captionScanner.types';

import type { SyntheticEvent } from 'react';

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
  const captionRefs = useRef<Record<string, HTMLLIElement | null>>({});
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    },
    [video, videoId],
  );

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
            ) : (
              <p style={{ margin: 0 }}>재생할 수 있는 영상이 없어요.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}