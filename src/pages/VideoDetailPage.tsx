import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { dataSource } from '@/datasource';
import { dataSourceKind } from '@/datasource';
import type { Video } from '@/datasource/types';
import { queryClient } from '@/lib/queryClient';

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

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const videoId = id ?? '';
  const [appliedMetadataForId, setAppliedMetadataForId] = useState<string | null>(null);

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