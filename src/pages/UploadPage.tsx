import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';


import { dataSource, dataSourceKind } from '@/datasource';
import type { Video } from '@/datasource/types';
import { saveVideoAssetsAtomically } from '@/lib/localAssetStore';
import { queryClient } from '@/lib/queryClient';
import { captureThumbnailFromFile } from '@/lib/thumbnailGenerator';

import type { FormEvent } from 'react';

const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB

type FormErrors = {
  title?: string;
  video?: string;
};

function validateTitle(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return '제목을 입력해주세요.';
  if (trimmed.length < 3) return '제목은 3자 이상이어야 해요.';
  return undefined;
}

function validateVideoFile(file: File | null) {
  if (!file) return '업로드할 비디오 파일을 선택해주세요.';
  if (!ACCEPTED_VIDEO_TYPES.includes(file.type)) return '지원하지 않는 비디오 형식이에요.';
  if (file.size > MAX_VIDEO_SIZE) return '비디오 용량이 너무 커요.';
  return undefined;
}

function getErrors(input: { title: string; videoFile: File | null }): FormErrors {
  return {
    title: validateTitle(input.title),
    video: validateVideoFile(input.videoFile),
  };
}

function generateVideoId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `v_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function UploadPage() {
  const [title, setTitle] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<string>('');
  const [didSubmitOnce, setDidSubmitOnce] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [thumbnailBlob, setThumbnailBlob] = useState<Blob | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailStatus, setThumbnailStatus] = useState<string>('썸네일 생성 전입니다.');
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const navigate = useNavigate();

  const videoHelper = useMemo(
    () =>
      [
        `허용: ${ACCEPTED_VIDEO_TYPES.join(', ')}`,
        `최대 용량: ${(MAX_VIDEO_SIZE / (1024 * 1024)).toFixed(0)}MB`,
      ].join(' · '),
    [],
  );

  const thumbHelper = useMemo(
    () => '영상 0.5초 지점에서 자동으로 캡처해요.',
    [],
  );
  const currentErrors = getErrors({ title, videoFile });
  const canSubmit = !currentErrors.title && !currentErrors.video && Boolean(thumbnailBlob);

  useEffect(() => {
    let revokedUrl: string | null = null;
    let cancelled = false;

    if (!videoFile) {
      setThumbnailBlob(null);
      setThumbnailUrl(null);
      setThumbnailStatus('썸네일 생성 전입니다.');
      setThumbnailError(null);
      return () => undefined;
    }

    setThumbnailBlob(null);
    setThumbnailUrl(null);
    setThumbnailError(null);
    setThumbnailStatus('썸네일 생성 중이에요…');

    captureThumbnailFromFile(videoFile, 0.5)
      .then((blob) => {
        if (cancelled) return;
        setThumbnailBlob(blob);
        revokedUrl = URL.createObjectURL(blob);
        setThumbnailUrl(revokedUrl);
        setThumbnailStatus('썸네일 생성 완료!');
      })
      .catch((error) => {
        if (cancelled) return;
        setThumbnailStatus('썸네일 생성에 실패했어요.');
        setThumbnailError(error instanceof Error ? error.message : '알 수 없는 오류');
      });

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [videoFile]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    setStatus('');
    setDidSubmitOnce(true);

    const nextErrors = getErrors({ title, videoFile });
    setErrors(nextErrors);
    const ok = !nextErrors.title && !nextErrors.video;
    if (!ok) {
      setStatus('입력값을 다시 확인해주세요.');
      return;
    }

    if (!videoFile) {
      setStatus('업로드할 영상 파일을 찾을 수 없어요.');
      return;
    }

    if (!thumbnailBlob) {
      setStatus('썸네일이 아직 준비되지 않았어요. 잠시 후 다시 시도해주세요.');
      return;
    }

    setIsSubmitting(true);
    setStatus('로컬에 파일을 저장하고 있어요…');

    try {
      const videoId = generateVideoId();
      const trimmedTitle = title.trim();
      const createdAt = Date.now();

      if (dataSourceKind === 'mock') {
        await saveVideoAssetsAtomically({
          record: {
            id: videoId,
            title: trimmedTitle,
            createdAt,
            videoBlobKey: videoId,
          },
          videoBlob: videoFile,
          thumbnailBlob: thumbnailBlob ?? undefined,
        });
      } else {
        await dataSource.putVideoBlob(videoId, videoFile);
        await dataSource.putThumbBlob(videoId, thumbnailBlob);
      }

      const video = await dataSource.createVideo({ id: videoId, title: trimmedTitle, createdAt });

      queryClient.setQueryData(['videos'], (prev: Video[] | undefined) =>
        prev ? [video, ...prev] : [video],
      );
      void queryClient.invalidateQueries({ queryKey: ['videos'] });

      setStatus('업로드가 완료됐어요. 상세 페이지로 이동합니다.');
      navigate(`/videos/${video.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '업로드에 실패했어요.';
      setStatus(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0 }}>업로드</h1>
        <Link to="/videos" style={{ fontSize: 14, color: '#555' }}>
          목록으로 돌아가기
        </Link>
      </div>

      <p style={{ color: '#444', margin: '12px 0 20px' }}>
        업로드한 비디오/썸네일이 로컬(IndexedDB)에 저장되고, 업로드가 끝나면 상세 페이지로 이동해요.
      </p>

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'grid',
          gap: 20,
          padding: 16,
          borderRadius: 10,
          border: '1px solid #e6e6e6',
          background: '#fff',
        }}
        noValidate
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="title" style={{ fontWeight: 600 }}>
            제목
          </label>
          <input
            id="title"
            name="title"
            type="text"
            value={title}
            onChange={(event) => {
              const next = event.target.value;
              setTitle(next);
              if (didSubmitOnce || errors.title) {
                setErrors((prev) => ({ ...prev, title: validateTitle(next) }));
              }
            }}
            placeholder="예: 신규 온보딩 소개 영상"
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #ccc' }}
            aria-invalid={Boolean(errors.title)}
          />
          {errors.title ? (
            <p style={{ color: '#b00020', margin: 0, fontSize: 13 }}>{errors.title}</p>
          ) : (
            <p style={{ color: '#666', margin: 0, fontSize: 13 }}>3자 이상 입력해주세요.</p>
          )}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <label htmlFor="video" style={{ fontWeight: 600 }}>
            비디오 파일
          </label>
          <input
            id="video"
            name="video"
            type="file"
            accept={ACCEPTED_VIDEO_TYPES.join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setVideoFile(file);
              setErrors((prev) => ({ ...prev, video: validateVideoFile(file) }));
            }}
            aria-invalid={Boolean(errors.video)}
          />
          <p style={{ color: errors.video ? '#b00020' : '#666', margin: 0, fontSize: 13 }}>
            {errors.video ?? videoHelper}
          </p>
          {videoFile ? (
            <div style={{ fontSize: 13, color: '#333' }}>
              선택된 파일: {videoFile.name} ({(videoFile.size / (1024 * 1024)).toFixed(1)}MB)
            </div>
          ) : null}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <label htmlFor="thumbnail-preview" style={{ fontWeight: 600 }}>
              자동 생성된 썸네일
            </label>
            <span style={{ color: '#666', fontSize: 12 }}>{thumbHelper}</span>
          </div>
          <div
            id="thumbnail-preview"
            style={{
              border: '1px solid #e6e6e6',
              borderRadius: 8,
              padding: 12,
              background: '#fafafa',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ color: thumbnailError ? '#b00020' : '#444', fontSize: 14 }}>
              {thumbnailStatus}
              {thumbnailError ? ` (${thumbnailError})` : null}
            </div>
        </div>
            {thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt="자동 생성된 비디오 썸네일"
                style={{
                  width: '100%',
                  maxWidth: 320,
                  borderRadius: 6,
                  border: '1px solid #ddd',
                  objectFit: 'cover',
                }}
              />
            ) : null}
          </div>
        <button
          type="submit"
          disabled={!canSubmit || isSubmitting}
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            border: 'none',
            background: canSubmit && !isSubmitting ? '#111' : '#999',
            color: '#fff',
            fontWeight: 700,
            cursor: canSubmit && !isSubmitting ? 'pointer' : 'not-allowed',
          }}
        >
          {isSubmitting ? '업로드 중…' : '업로드하기'}
        </button>

        {status ? (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: errors.title || errors.video ? '#fff4f4' : '#f0fff2',
              color: errors.title || errors.video ? '#b00020' : '#1d7f32',
            }}
            aria-live="polite"
          >
            {status}
          </div>
        ) : null}
      </form>
    </main>
  );
}