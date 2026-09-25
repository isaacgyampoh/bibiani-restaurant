import { formatMinor } from '@rp/domain';
import { type ReactNode, useEffect } from 'react';

export function Money({ minor, currency }: { minor: number; currency: string }) {
  return <span>{formatMinor(minor, currency)}</span>;
}

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value.replace(/_/g, ' ')}</span>;
}

export function ConnectionDot({ state }: { state: 'connecting' | 'live' | 'polling' }) {
  const label =
    state === 'live'
      ? 'Live'
      : state === 'polling'
        ? 'Reconnecting — refreshing every few seconds'
        : 'Connecting';
  return (
    <span className="row small" title={label}>
      <span className={`dot ${state}`} />{' '}
      {state === 'live' ? 'Live' : state === 'polling' ? 'Offline sync' : '…'}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row">
          <h2 className="grow">{title}</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error" role="alert">
      {message}
    </div>
  );
}

export function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
