export type ApiErrorKind = 'network' | 'http' | 'parse' | 'timeout' | 'abort';

export type ApiError = {
  kind: ApiErrorKind;
  message: string;

  url?: string;
  method?: string;

  status?: number;
  statusText?: string;

  responseText?: string;
  responseJson?: unknown;

  cause?: unknown;
};

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e;
}

export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;

  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error';

  return { kind: 'network', message, cause: e };
}