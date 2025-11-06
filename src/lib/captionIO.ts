import type { Caption } from '@/datasource/types'

function formatTimecode(ms: number) {
  const clamped = Math.max(0, Math.floor(ms))
  const hours = Math.floor(clamped / 3_600_000)
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000

  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const mmm = String(millis).padStart(3, '0')

  return `${hh}:${mm}:${ss},${mmm}`
}

export function captionsToSrt(captions: Caption[]): string {
  const validCaptions = captions
    .filter((caption) => Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs))
    .filter((caption) => caption.startMs < caption.endMs)
    .filter((caption) => caption.text.trim() !== '')
    .sort((a, b) => a.startMs - b.startMs)

  const segments = validCaptions.map((caption, index) => {
    const safeTextLines = caption.text
      .replace(/\r\n?|\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, ''))

    const lines = [
      String(index + 1),
      `${formatTimecode(caption.startMs)} --> ${formatTimecode(caption.endMs)}`,
      ...safeTextLines,
    ]

    return lines.join('\r\n')
  })

  if (segments.length === 0) return ''

  return `${segments.join('\r\n\r\n')}\r\n`
}

export function serializeCaptionsToJson(captions: Caption[]): string {
  const sorted = [...captions].sort((a, b) => a.startMs - b.startMs)
  return JSON.stringify({ captions: sorted }, null, 2)
}

type CaptionJson = {
  id?: string
  startMs: unknown
  endMs: unknown
  text: unknown
}

function isCaptionJson(value: unknown): value is CaptionJson {
  if (!value || typeof value !== 'object') return false
  const candidate = value as CaptionJson
  return 'startMs' in candidate && 'endMs' in candidate && 'text' in candidate
}

function normalizeCaptionJson(raw: CaptionJson, fallbackId: () => string): Caption {
  const startMs = Number(raw.startMs)
  const endMs = Number(raw.endMs)
  const text = typeof raw.text === 'string' ? raw.text : ''

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('모든 자막에 시작/종료 시간이 필요해요.')
  }

  if (startMs >= endMs) {
    throw new Error('종료 시간은 시작 시간보다 커야 해요.')
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId(),
    startMs,
    endMs,
    text,
  }
}

export function parseCaptionsFromJson(jsonText: string, fallbackId: () => string): Caption[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('JSON 형식을 읽을 수 없어요.')
  }

  const sourceArray = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { captions?: unknown })?.captions)
      ? ((parsed as { captions: unknown[] }).captions)
      : null

  if (!sourceArray) {
    throw new Error('자막 JSON에 captions 배열이 필요해요.')
  }

  if (sourceArray.length === 0) return []

  return sourceArray.map((item) => {
    if (!isCaptionJson(item)) throw new Error('자막 항목에 필요한 필드가 없어요.')
    return normalizeCaptionJson(item, fallbackId)
  })
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()

  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}