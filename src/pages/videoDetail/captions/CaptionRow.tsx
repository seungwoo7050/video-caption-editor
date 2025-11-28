import type { Caption } from '../types';

type CaptionRowProps = {
  caption: Caption;
  errors: Partial<Record<keyof Caption, string>>;
  isActive: boolean;
  onFieldChange: (id: string, field: keyof Pick<Caption, 'startMs' | 'endMs' | 'text'>, value: string) => void;
  onSetTimeFromVideo: (id: string, field: keyof Pick<Caption, 'startMs' | 'endMs'>) => void;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
  onFocus: (id: string) => void;
  registerRowRef: (node: HTMLLIElement | null) => void;
};

export function CaptionRow({
  caption,
  errors,
  isActive,
  onFieldChange,
  onSetTimeFromVideo,
  onConfirm,
  onDelete,
  onFocus,
  registerRowRef,
}: CaptionRowProps) {
  const hasError = Object.keys(errors).length > 0;

  return (
    <li
      ref={registerRowRef}
      style={{
        border: isActive ? '1px solid #111' : '1px solid #e6e6e6',
        borderRadius: 10,
        padding: 12,
        background: hasError ? '#fffafa' : isActive ? '#f5f8ff' : '#fdfdfd',
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
              onChange={(e) => onFieldChange(caption.id, 'startMs', e.target.value)}
              onFocus={() => onFocus(caption.id)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #ccc',
              }}
            />
            <button
              type="button"
              onClick={() => onSetTimeFromVideo(caption.id, 'startMs')}
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
          {errors.startMs ? <span style={{ color: '#b00020', fontSize: 12 }}>{errors.startMs}</span> : null}
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#555' }}>종료(ms)</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="number"
              min={0}
              value={Number.isFinite(caption.endMs) ? caption.endMs : ''}
              onChange={(e) => onFieldChange(caption.id, 'endMs', e.target.value)}
              onFocus={() => onFocus(caption.id)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #ccc',
              }}
            />
            <button
              type="button"
              onClick={() => onSetTimeFromVideo(caption.id, 'endMs')}
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
          {errors.endMs ? <span style={{ color: '#b00020', fontSize: 12 }}>{errors.endMs}</span> : null}
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#555' }}>자막 내용</span>
          <textarea
            data-caption-text="true"
            value={caption.text}
            onChange={(e) => onFieldChange(caption.id, 'text', e.target.value)}
            onFocus={() => onFocus(caption.id)}
            onKeyDown={(e) => {
              if (e.key === '[' || e.key === ']') {
                e.stopPropagation();
                return;
              }
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onConfirm(caption.id);
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
          {errors.text ? <span style={{ color: '#b00020', fontSize: 12 }}>{errors.text}</span> : null}
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => onDelete(caption.id)}
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
}
