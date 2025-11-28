import { formatDate, formatKeyLabel, formatMeta, parseCaptionGapMs } from '../utils';

import { CaptionRow } from './CaptionRow';
import { getCaptionErrors } from './captionValidation';
import { useCaptionFocus } from './useCaptionFocus';

import type { Caption, HotkeyConfig, TrimRange, Video } from '../types';
import type { ChangeEventHandler, RefObject } from 'react';

type CaptionEditorProps = {
  video: Video | null;
  isMetadataReady: boolean;
  captionDrafts: Caption[];
  activeCaptionId: string | null;
  captionGapMs: number;
  onCaptionGapChange: (gapMs: number) => void;
  isCaptionsLoading: boolean;
  isCaptionsError: boolean;
  captionsError: unknown;
  importError: string | null;
  hotkeyItems: { key: keyof HotkeyConfig; label: string; description: string }[];
  hotkeyConfig: HotkeyConfig;
  capturingHotkey: keyof HotkeyConfig | null;
  onResetHotkeys: () => void;
  onStartCaptureHotkey: (key: keyof HotkeyConfig) => void;
  onAddCaption: () => void;
  onCaptionFieldChange: (
    captionId: string,
    field: keyof Pick<Caption, 'startMs' | 'endMs' | 'text'>,
    value: string,
  ) => void;
  onSetCaptionTimeFromVideo: (captionId: string, field: keyof Pick<Caption, 'startMs' | 'endMs'>) => void;
  onConfirmCaption: (captionId: string) => void;
  onDeleteCaption: (captionId: string) => void;
  onCaptionFocus: (captionId: string) => void;
  onSaveCaptions: () => void;
  isSavingCaptions: boolean;
  isSaveCaptionsError: boolean;
  saveCaptionsError: unknown;
  hasCaptionErrors: boolean;
  lastSavedAt: number | null;
  applyTrimOnExport: boolean;
  onApplyTrimChange: (value: boolean) => void;
  trimRange: TrimRange | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onImportJsonFile: ChangeEventHandler<HTMLInputElement>;
  onImportJsonClick: () => void;
  onExportJson: () => void;
  onExportSrt: () => void;
  onHandleTrimExport: () => void;
  onHandleCancelTrim: () => void;
  isTrimming: boolean;
  trimProgress: number | null;
  trimMessage: string | null;
  trimResultUrl: string | null;
  trimFileName: string | null;
  trimError: string | null;
  onHandleBurnInExport: () => void;
  onHandleCancelBurnIn: () => void;
  isBurningIn: boolean;
  burnInProgress: number | null;
  burnInMessage: string | null;
  burnInResultUrl: string | null;
  burnInFileName: string | null;
  burnInError: string | null;
};

export function CaptionEditor({
  video,
  isMetadataReady,
  captionDrafts,
  activeCaptionId,
  captionGapMs,
  onCaptionGapChange,
  isCaptionsLoading,
  isCaptionsError,
  captionsError,
  importError,
  hotkeyItems,
  hotkeyConfig,
  capturingHotkey,
  onResetHotkeys,
  onStartCaptureHotkey,
  onAddCaption,
  onCaptionFieldChange,
  onSetCaptionTimeFromVideo,
  onConfirmCaption,
  onDeleteCaption,
  onCaptionFocus,
  onSaveCaptions,
  isSavingCaptions,
  isSaveCaptionsError,
  saveCaptionsError,
  hasCaptionErrors,
  lastSavedAt,
  applyTrimOnExport,
  onApplyTrimChange,
  trimRange,
  fileInputRef,
  onImportJsonFile,
  onImportJsonClick,
  onExportJson,
  onExportSrt,
  onHandleTrimExport,
  onHandleCancelTrim,
  isTrimming,
  trimProgress,
  trimMessage,
  trimResultUrl,
  trimFileName,
  trimError,
  onHandleBurnInExport,
  onHandleCancelBurnIn,
  isBurningIn,
  burnInProgress,
  burnInMessage,
  burnInResultUrl,
  burnInFileName,
  burnInError,
}: CaptionEditorProps) {
  const { registerCaptionRef } = useCaptionFocus({
    captions: captionDrafts,
    activeCaptionId,
    onCaptionFocus,
  });

  return (
    <section
      className="video-detail-captions"
      style={{
        padding: 16,
        borderRadius: 10,
        border: '1px solid #e6e6e6',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: '100vh',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0 }}>{video?.title}</h2>
        {video?.createdAt ? (
          <span style={{ color: '#666', fontSize: 13 }}>{formatDate(video.createdAt)}</span>
        ) : null}
      </div>
      <div style={{ color: '#555', fontSize: 14 }}>
        {video ? formatMeta(video) || '메타데이터 없음' : null}
        {isMetadataReady && video && formatMeta(video) ? ' (추출됨)' : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0 }}>자막</h3>
        <button
          type="button"
          onClick={onAddCaption}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #111',
            cursor: 'pointer',
            background: '#111',
            color: '#fff',
          }}
          disabled={isCaptionsLoading || isSavingCaptions}
        >
          새 자막 추가
        </button>
        <div style={{ flex: 1 }} />
        {lastSavedAt ? (
          <span style={{ color: '#666', fontSize: 12 }}>
            마지막 저장: {new Date(lastSavedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: 'grid',
          gap: 10,
          padding: 12,
          borderRadius: 10,
          border: '1px solid #e6e6e6',
          background: '#f8fafc',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, color: '#111' }}>단축키 설정</strong>
          <span style={{ fontSize: 12, color: '#555' }}>
            입력창 포커스 상태에서도 동작하며, IME 조합 중에는 동작하지 않아요.
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onResetHotkeys}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#fff',
              color: '#111',
              cursor: 'pointer',
            }}
          >
            기본값 복원
          </button>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          }}
        >
          {hotkeyItems.map((item) => {
            const isCapturing = capturingHotkey === item.key;
            return (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  background: '#fff',
                }}
              >
                <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: '#111', fontWeight: 600 }}>{item.label}</span>
                  <span style={{ fontSize: 12, color: '#555', wordBreak: 'keep-all' }}>
                    {item.description}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onStartCaptureHotkey(item.key)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: isCapturing ? '1px solid #111' : '1px solid #cbd5e1',
                    background: isCapturing ? '#111' : '#f8fafc',
                    color: isCapturing ? '#fff' : '#111',
                    cursor: 'pointer',
                    minWidth: 120,
                  }}
                >
                  {isCapturing ? '입력 대기… (Esc)' : formatKeyLabel(hotkeyConfig[item.key])}
                </button>
              </div>
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ fontSize: 14, color: '#111' }}>자동 시간 간격</strong>
          <span style={{ fontSize: 12, color: '#555' }}>
            Enter로 자막을 확정하면 다음 자막의 시작 시간을 이전 종료 시간 뒤로 맞춰줘요.
          </span>
          <div style={{ flex: 1 }} />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: '#111',
            }}
          >
            간격(ms)
            <input
              type="number"
              min={0}
              value={captionGapMs}
              onChange={(e) => onCaptionGapChange(parseCaptionGapMs(e.target.value))}
              style={{
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                width: 100,
              }}
            />
          </label>
        </div>
      </div>

      {isCaptionsLoading ? (
        <p style={{ margin: 0 }}>자막을 불러오는 중이에요…</p>
      ) : isCaptionsError ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            border: '1px solid #f2c4c4',
            background: '#fff6f6',
            color: '#b00020',
          }}
        >
          <p style={{ margin: '0 0 6px' }}>자막을 불러오지 못했어요.</p>
          <pre
            style={{
              margin: 0,
              padding: 8,
              borderRadius: 6,
              background: '#2f1317',
              color: '#ffeaea',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
            }}
          >
            {captionsError instanceof Error ? captionsError.message : String(captionsError)}
          </pre>
        </div>
      ) : captionDrafts.length === 0 ? (
        <p style={{ margin: 0, color: '#555' }}>자막이 없어요. 새 자막을 추가해보세요.</p>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            paddingRight: 6,
          }}
        >
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {captionDrafts.map((caption) => {
              const errors = getCaptionErrors(caption);
              const isActive = activeCaptionId === caption.id;
              return (
                <CaptionRow
                  key={caption.id}
                  caption={caption}
                  errors={errors}
                  isActive={isActive}
                  onFieldChange={onCaptionFieldChange}
                  onSetTimeFromVideo={(id, field) => {
                    onSetCaptionTimeFromVideo(id, field);
                    onCaptionFocus(id);
                  }}
                  onConfirm={onConfirmCaption}
                  onDelete={onDeleteCaption}
                  onFocus={onCaptionFocus}
                  registerRowRef={registerCaptionRef(caption.id)}
                />
              );
            })}
          </ul>
        </div>
      )}

      {isSaveCaptionsError ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            border: '1px solid #f2c4c4',
            background: '#fff6f6',
            color: '#b00020',
          }}
        >
          <p style={{ margin: '0 0 6px' }}>자막 저장에 실패했어요.</p>
          <pre
            style={{
              margin: 0,
              padding: 8,
              borderRadius: 6,
              background: '#2f1317',
              color: '#ffeaea',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
            }}
          >
            {saveCaptionsError instanceof Error ? saveCaptionsError.message : String(saveCaptionsError)}
          </pre>
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={onSaveCaptions}
          disabled={isCaptionsLoading || isSavingCaptions || hasCaptionErrors || captionDrafts.length === 0}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: 'none',
            background: '#111',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          {isSavingCaptions ? '저장 중…' : '자막 저장'}
        </button>
        {hasCaptionErrors ? (
          <span style={{ color: '#b00020', fontSize: 13 }}>
            모든 자막의 시작·종료 시간과 내용을 확인하세요.
          </span>
        ) : (
          <span style={{ color: '#555', fontSize: 13 }}>시작 시간 오름차순으로 정렬되어 저장돼요.</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={onImportJsonFile} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
          <input
            type="checkbox"
            checked={applyTrimOnExport}
            disabled={!trimRange}
            onChange={(event) => onApplyTrimChange(event.target.checked)}
          />
          <span style={{ fontSize: 14, color: '#111' }}>
            선택 구간만 내보내기
            <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(시작 시간을 0으로 맞춰 저장)</span>
            {!trimRange ? (
              <span style={{ color: '#666', marginLeft: 6, fontSize: 12 }}>(트림 구간을 먼저 선택)</span>
            ) : null}
          </span>
        </label>
        <button
          type="button"
          onClick={onImportJsonClick}
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: '1px solid #ccc',
            background: '#f8f8f8',
            color: '#111',
            cursor: 'pointer',
          }}
        >
          JSON 불러오기
        </button>
        <button
          type="button"
          onClick={onExportJson}
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: '1px solid #ccc',
            background: '#f8f8f8',
            color: '#111',
            cursor: 'pointer',
          }}
        >
          JSON 내보내기
        </button>
        <button
          type="button"
          onClick={onExportSrt}
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: '1px solid #ccc',
            background: '#f8f8f8',
            color: '#111',
            cursor: 'pointer',
          }}
        >
          SRT 내보내기
        </button>
      </div>

      {applyTrimOnExport ? (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            border: '1px solid #e6e6e6',
            borderRadius: 10,
            background: '#fafafa',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              onClick={onHandleTrimExport}
              disabled={isTrimming}
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid #222',
                background: '#111',
                color: '#fff',
                cursor: isTrimming ? 'not-allowed' : 'pointer',
              }}
            >
              {isTrimming ? '구간 내보내는 중…' : '구간 mp4 내보내기'}
            </button>
            {isTrimming ? (
              <button
                type="button"
                onClick={onHandleCancelTrim}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid #b00020',
                  background: '#fff6f6',
                  color: '#b00020',
                  cursor: 'pointer',
                }}
              >
                작업 취소
              </button>
            ) : null}
          </div>
          <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
            길이 2분 이하 또는 60MB 이하만 지원해요. 진행 중에도 다른 작업은 그대로 사용할 수 있어요.
          </p>
          {trimProgress !== null || trimMessage ? (
            <div style={{ color: '#111', fontSize: 14, lineHeight: 1.4 }}>
              {trimProgress !== null ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <div
                    style={{
                      flex: '0 0 160px',
                      height: 8,
                      borderRadius: 999,
                      background: '#e5e5e5',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.round(Math.min(1, Math.max(0, trimProgress)) * 100)}%`,
                        height: '100%',
                        background: '#4a90e2',
                      }}
                    />
                  </div>
                  <span style={{ color: '#333', fontSize: 13 }}>
                    {Math.round(Math.min(1, Math.max(0, trimProgress)) * 100)}%
                  </span>
                </div>
              ) : null}
              {trimMessage ? <div style={{ marginTop: 4, color: '#333' }}>{trimMessage}</div> : null}
            </div>
          ) : null}
          {trimResultUrl && trimFileName ? (
            <div style={{ fontSize: 14 }}>
              <a href={trimResultUrl} download={trimFileName} style={{ color: '#0b74de', textDecoration: 'underline' }}>
                트림된 mp4 다시 저장하기
              </a>
            </div>
          ) : null}
          {trimError ? (
            <div
              style={{
                padding: 10,
                borderRadius: 8,
                border: '1px solid #f2c4c4',
                background: '#fff6f6',
                color: '#b00020',
                fontSize: 14,
              }}
            >
              <p style={{ margin: '0 0 4px' }}>{trimError}</p>
              <p style={{ margin: 0, color: '#b00020', fontSize: 12 }}>DEV 로그는 콘솔을 확인하세요.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 12,
          padding: 12,
          border: '1px solid #e6e6e6',
          borderRadius: 10,
          background: '#fafafa',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onHandleBurnInExport}
            disabled={isBurningIn || captionDrafts.length === 0}
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #222',
              background: '#111',
              color: '#fff',
              cursor: isBurningIn ? 'not-allowed' : 'pointer',
            }}
          >
            {isBurningIn ? '번인 내보내는 중…' : '자막 번인 mp4 내보내기'}
          </button>
          {isBurningIn ? (
            <button
              type="button"
              onClick={onHandleCancelBurnIn}
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid #b00020',
                background: '#fff6f6',
                color: '#b00020',
                cursor: 'pointer',
              }}
            >
              작업 취소
            </button>
          ) : null}
        </div>
        <p style={{ margin: 0, color: '#555', fontSize: 13 }}>
          지원: mp4 · 길이 30초 이하 또는 50MB 이하. 진행 중에도 다른 작업은 그대로 사용할 수 있어요.
        </p>
        {burnInProgress !== null || burnInMessage ? (
          <div style={{ color: '#111', fontSize: 14, lineHeight: 1.4 }}>
            {burnInProgress !== null ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div
                  style={{
                    flex: '0 0 160px',
                    height: 8,
                    borderRadius: 999,
                    background: '#e5e5e5',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%`,
                      height: '100%',
                      background: '#4a90e2',
                    }}
                  />
                </div>
                <span style={{ color: '#333', fontSize: 13 }}>
                  {Math.round(Math.min(1, Math.max(0, burnInProgress)) * 100)}%
                </span>
              </div>
            ) : null}
            {burnInMessage ? <div style={{ marginTop: 4, color: '#333' }}>{burnInMessage}</div> : null}
          </div>
        ) : null}
        {burnInResultUrl && burnInFileName ? (
          <div style={{ fontSize: 14 }}>
            <a
              href={burnInResultUrl}
              download={burnInFileName}
              style={{ color: '#0b74de', textDecoration: 'underline' }}
            >
              번인된 mp4 다시 저장하기
            </a>
          </div>
        ) : null}
        {burnInError ? (
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              border: '1px solid #f2c4c4',
              background: '#fff6f6',
              color: '#b00020',
              fontSize: 14,
            }}
          >
            <p style={{ margin: '0 0 4px' }}>{burnInError}</p>
            <p style={{ margin: 0, color: '#b00020', fontSize: 12 }}>DEV 로그는 콘솔을 확인하세요.</p>
          </div>
        ) : null}
      </div>

      {importError ? <p style={{ margin: '8px 0 0', color: '#b00020' }}>{importError}</p> : null}
    </section>
  );
}
