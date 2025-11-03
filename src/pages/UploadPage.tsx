import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { FormEvent } from 'react';

const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const ACCEPTED_THUMB_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_THUMB_SIZE = 10 * 1024 * 1024; // 10MB

type FormErrors = {
  title?: string;
  video?: string;
  thumbnail?: string;
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

function validateThumbnailFile(file: File | null) {
  if (!file) return '대표 썸네일을 선택해주세요.';
  if (!ACCEPTED_THUMB_TYPES.includes(file.type)) return '썸네일은 JPG/PNG/WEBP만 지원해요.';
  if (file.size > MAX_THUMB_SIZE) return '썸네일 용량이 너무 커요.';
  return undefined;
}

function getErrors(input: { title: string; videoFile: File | null; thumbnailFile: File | null }): FormErrors {
  return {
    title: validateTitle(input.title),
    video: validateVideoFile(input.videoFile),
    thumbnail: validateThumbnailFile(input.thumbnailFile),
  };
}

export default function UploadPage() {
  const [title, setTitle] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<string>('');
  const [didSubmitOnce, setDidSubmitOnce] = useState(false);

  const videoHelper = useMemo(
    () =>
      [
        `허용: ${ACCEPTED_VIDEO_TYPES.join(', ')}`,
        `최대 용량: ${(MAX_VIDEO_SIZE / (1024 * 1024)).toFixed(0)}MB`,
      ].join(' · '),
    [],
  );

  const thumbHelper = useMemo(
    () =>
      [
        `허용: ${ACCEPTED_THUMB_TYPES.join(', ')}`,
        `최대 용량: ${(MAX_THUMB_SIZE / (1024 * 1024)).toFixed(0)}MB`,
      ].join(' · '),
    [],
  );
  const currentErrors = getErrors({ title, videoFile, thumbnailFile });
  const canSubmit =
    !currentErrors.title && !currentErrors.video && !currentErrors.thumbnail;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('');
    setDidSubmitOnce(true);

    const nextErrors = getErrors({ title, videoFile, thumbnailFile });
    setErrors(nextErrors);
    const ok = !nextErrors.title && !nextErrors.video && !nextErrors.thumbnail;
    if (!ok) {
      setStatus('입력값을 다시 확인해주세요.');
      return;
    }

    setStatus('검증을 통과했어요! 실제 업로드 기능은 준비 중이에요.');
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
        파일 검증만 우선 지원돼요. 요구사항에 맞는지 확인만 하고 실제 저장은 진행되지 않아요.
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
          <label htmlFor="thumbnail" style={{ fontWeight: 600 }}>
            썸네일 이미지
          </label>
          <input
            id="thumbnail"
            name="thumbnail"
            type="file"
            accept={ACCEPTED_THUMB_TYPES.join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setThumbnailFile(file);
              setErrors((prev) => ({ ...prev, thumbnail: validateThumbnailFile(file) }));
            }}
            aria-invalid={Boolean(errors.thumbnail)}
          />
          <p style={{ color: errors.thumbnail ? '#b00020' : '#666', margin: 0, fontSize: 13 }}>
            {errors.thumbnail ?? thumbHelper}
          </p>
          {thumbnailFile ? (
            <div style={{ fontSize: 13, color: '#333' }}>
              선택된 파일: {thumbnailFile.name} ({(thumbnailFile.size / 1024).toFixed(0)}KB)
            </div>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            border: 'none',
            background: canSubmit ? '#111' : '#999',
            color: '#fff',
            fontWeight: 700,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          검증하기
        </button>

        {status ? (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: errors.title || errors.video || errors.thumbnail ? '#fff4f4' : '#f0fff2',
              color: errors.title || errors.video || errors.thumbnail ? '#b00020' : '#1d7f32',
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