type Props = {
  title?: string
  message?: string
  details?: string
  onReload?: () => void
  onGoHome?: () => void
}

export function ErrorScreen({
  title = '문제가 발생했어요',
  message = '잠시 후 다시 시도해 주세요.',
  details,
  onReload,
  onGoHome,
}: Props) {
  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{title}</h1>
      <p style={{ marginTop: 12, marginBottom: 16, lineHeight: 1.5 }}>{message}</p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onReload}
          style={{ padding: '8px 12px', cursor: 'pointer' }}
        >
          새로고침
        </button>
        <button
          type="button"
          onClick={onGoHome}
          style={{ padding: '8px 12px', cursor: 'pointer' }}
        >
          홈으로
        </button>
      </div>

      {details ? (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: '#111',
            color: '#eee',
            borderRadius: 8,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {details}
        </pre>
      ) : null}
    </div>
  )
}
