import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last line of defence: if a screen crashes, staff see a branded page with a way back instead of a
 * blank white screen. Nothing unsaved on the server is lost (orders are saved per action).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('screen_crashed', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="splash crash" role="alert">
        <img src="/logo-512.png" alt="MY FOOD — Chefelisha Restaurant" />
        <strong>Something went wrong on this screen</strong>
        <span>Your saved orders and payments are safe. Reload to continue.</span>
        <div className="crash-actions">
          <button type="button" className="btn lg" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="btn lg ghost-light"
            onClick={() => {
              window.location.href = '/';
            }}
          >
            Go to start
          </button>
        </div>
      </div>
    );
  }
}
