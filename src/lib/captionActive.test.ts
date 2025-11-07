import { describe, expect, it } from 'vitest'

import type { Caption } from '@/datasource/types'

import { getActiveCaptionAtMs } from './captionActive'

describe('getActiveCaptionAtMs', () => {
  const baseCaptions: Caption[] = [
    { id: 'a', startMs: 0, endMs: 1000, text: 'A' },
    { id: 'b', startMs: 1000, endMs: 2000, text: 'B' },
    { id: 'c', startMs: 2000, endMs: 3000, text: 'C' },
  ]

  it('returns null when there is no matching caption', () => {
    expect(getActiveCaptionAtMs(baseCaptions, -1)).toBeNull()
    expect(getActiveCaptionAtMs(baseCaptions, Number.NaN)).toBeNull()
    expect(getActiveCaptionAtMs(baseCaptions, 5000)).toBeNull()
  })

  it('includes startMs but excludes endMs', () => {
    expect(getActiveCaptionAtMs(baseCaptions, 0)?.id).toBe('a')
    expect(getActiveCaptionAtMs(baseCaptions, 999)?.id).toBe('a')
    expect(getActiveCaptionAtMs(baseCaptions, 1000)?.id).toBe('b')
    expect(getActiveCaptionAtMs(baseCaptions, 2000)?.id).toBe('c')
    expect(getActiveCaptionAtMs(baseCaptions, 3000)).toBeNull()
  })

  it('prefers the caption with the latest start when overlaps occur', () => {
    const overlapping: Caption[] = [
      { id: 'early', startMs: 0, endMs: 3000, text: 'Early' },
      { id: 'middle', startMs: 500, endMs: 2500, text: 'Middle' },
      { id: 'late', startMs: 800, endMs: 1800, text: 'Late' },
    ]

    expect(getActiveCaptionAtMs(overlapping, 1000)?.id).toBe('late')
    expect(getActiveCaptionAtMs(overlapping, 2400)?.id).toBe('middle')
  })

  it('ignores captions with blank text', () => {
    const captionsWithBlank: Caption[] = [
      { id: 'visible', startMs: 0, endMs: 1000, text: 'Visible' },
      { id: 'blank', startMs: 1000, endMs: 2000, text: '   ' },
    ]

    expect(getActiveCaptionAtMs(captionsWithBlank, 1500)).toBeNull()
  })

  it('ignores blank captions even when they overlap others', () => {
    const overlappingWithBlank: Caption[] = [
      { id: 'base', startMs: 0, endMs: 3000, text: 'Base' },
      { id: 'blankTop', startMs: 800, endMs: 1800, text: '   ' },
    ]

    expect(getActiveCaptionAtMs(overlappingWithBlank, 1000)?.id).toBe('base')
  })

  it('works regardless of caption ordering', () => {
    const unsorted: Caption[] = [
      { id: 'second', startMs: 500, endMs: 1500, text: 'Second' },
      { id: 'first', startMs: 0, endMs: 2000, text: 'First' },
    ]

    expect(getActiveCaptionAtMs(unsorted, 750)?.id).toBe('second')
  })
})
