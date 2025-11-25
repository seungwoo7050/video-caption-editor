import type { Caption, CaptionErrors } from '../types';

export function getCaptionErrors(caption: Caption): CaptionErrors {
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
