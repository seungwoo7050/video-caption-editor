import { isRouteErrorResponse, useRouteError } from 'react-router-dom'

import { ErrorScreen } from '@/components/ErrorScreen'

export function RouteErrorElement() {
  const error = useRouteError()

  let title = '페이지 오류'
  let message = '페이지를 불러오는 중 문제가 발생했어요.'
  let details: string | undefined

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`
    message = typeof error.data === 'string' ? error.data : message
    details = import.meta.env.DEV ? JSON.stringify(error.data, null, 2) : undefined
  } else if (error instanceof Error) {
    message = error.message || message
    details = import.meta.env.DEV ? error.stack ?? String(error) : undefined
  } else {
    details = import.meta.env.DEV ? String(error) : undefined
  }

  return (
    <ErrorScreen
      title={title}
      message={message}
      details={details}
      onReload={() => window.location.reload()}
      onGoHome={() => {
        window.location.href = '/'
      }}
    />
  )
}
