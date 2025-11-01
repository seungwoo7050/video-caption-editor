import React from 'react'

import { ErrorScreen } from '@/components/ErrorScreen'

type Props = {
  children: React.ReactNode
}

type State = {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    const { error } = this.state
    if (error) {
      const details = import.meta.env.DEV ? error.stack ?? String(error) : undefined
      return (
        <ErrorScreen
          title="앱 오류"
          message={error.message || '예기치 못한 오류가 발생했어요.'}
          details={details}
          onReload={this.handleReload}
          onGoHome={this.handleGoHome}
        />
      )
    }

    return this.props.children
  }
}
