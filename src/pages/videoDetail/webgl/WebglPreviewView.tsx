import type { RefObject } from 'react';

export type WebglPreviewViewProps = {
  isSupported: boolean;
  isReady: boolean;
  isGrayscale: boolean;
  onGrayscaleChange: (next: boolean) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  videoWidth?: number | null;
  videoHeight?: number | null;
};

export function WebglPreviewView({
  isSupported,
  isReady,
  isGrayscale,
  onGrayscaleChange,
  containerRef,
  canvasRef,
  videoWidth,
  videoHeight,
}: WebglPreviewViewProps) {
  if (!isSupported) return null;

  const aspectRatio = videoWidth && videoHeight ? `${videoWidth} / ${videoHeight}` : '16 / 9';

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        border: '1px solid #e2e8f0',
        background: '#f8fafc',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <p style={{ margin: 0, fontWeight: 600, color: '#111' }}>
          추가 미리보기 (WebGL){!isReady ? ' · 초기화 중…' : null}
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#111' }}>
          <input
            type="checkbox"
            checked={isGrayscale}
            disabled={!isReady}
            onChange={(event) => onGrayscaleChange(event.target.checked)}
          />
          <span>그레이스케일</span>
        </label>
      </div>
      <div ref={containerRef} style={{ width: '100%' }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            display: 'block',
            borderRadius: 8,
            background: '#000',
            aspectRatio,
          }}
        />
      </div>
    </div>
  );
}
