import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { dataSource } from '@/datasource';
import type { Video } from '@/datasource/types';

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

export default function VideosPage() {
  const {
    data: videos,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['videos'],
    queryFn: () => dataSource.listVideos(),
  });

  return (
    <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Videos</h1>
        <span style={{ color: '#666' }}>
          {isPending ? '로딩 중…' : `${videos?.length ?? 0}개`}
        </span>
      </div>

      <div style={{ marginTop: 16 }}>
        {isPending ? (
          <p style={{ margin: 0 }}>목록을 불러오는 중이에요…</p>
        ) : isError ? (
          <div style={{ padding: 16, border: '1px solid #f2c4c4', borderRadius: 8, background: '#fff6f6' }}>
            <p style={{ margin: '0 0 8px' }}>목록을 불러오지 못했어요.</p>
            <pre style={{ margin: '0 0 12px', padding: 12, borderRadius: 6, background: '#111', color: '#eee', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
              {error instanceof Error ? error.message : String(error)}
            </pre>
            <button type="button" onClick={() => refetch()} style={{ padding: '8px 12px', cursor: 'pointer' }}>
              다시 시도
            </button>
          </div>
        ) : (videos?.length ?? 0) === 0 ? (
          <div style={{ padding: 16, border: '1px dashed #ccc', borderRadius: 8, background: '#fafafa' }}>
            <p style={{ margin: 0 }}>등록된 비디오가 없어요.</p>
            <p style={{ margin: '8px 0 0', color: '#666' }}>새 비디오를 업로드하면 여기에 표시돼요.</p>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {videos?.map((video) => (
              <li key={video.id} style={{ border: '1px solid #e6e6e6', borderRadius: 10, padding: 16, background: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Link to={`/videos/${video.id}`} style={{ textDecoration: 'none', color: '#222', fontSize: 18, fontWeight: 700 }}>
                      {video.title}
                    </Link>
                    <div style={{ color: '#666', marginTop: 4, fontSize: 13 }}>
                      {formatDate(video.createdAt)}
                    </div>
                  </div>
                  <div style={{ color: '#555', fontSize: 13, textAlign: 'right' }}>
                    {formatMeta(video) || '메타데이터 없음'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}