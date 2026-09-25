import { formatMinor } from '@rp/domain';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

/* ------------------------------------------------------------------ money */
export function Money({ minor, currency }: { minor: number; currency: string }) {
  return <span className="tabular">{formatMinor(minor, currency)}</span>;
}

/* ------------------------------------------------------------------ status */
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';
/** Plain-language labels and restrained tones for every status the system shows. */
const STATUS: Record<string, [string, Tone]> = {
  // orders
  draft: ['Draft', 'neutral'],
  submitted: ['Sent', 'info'],
  in_preparation: ['Preparing', 'warn'],
  partially_ready: ['Partly ready', 'warn'],
  ready: ['Ready', 'ok'],
  served: ['Served', 'neutral'],
  picked_up: ['Collected', 'neutral'],
  completed: ['Completed', 'ok'],
  cancelled: ['Cancelled', 'neutral'],
  voided: ['Voided', 'neutral'],
  // payment
  unpaid: ['Unpaid', 'danger'],
  partially_paid: ['Part paid', 'warn'],
  paid: ['Paid', 'ok'],
  partially_refunded: ['Part refunded', 'warn'],
  refunded: ['Refunded', 'neutral'],
  // items / tickets
  pending: ['Not sent', 'neutral'],
  sent: ['Sent', 'info'],
  accepted: ['Accepted', 'info'],
  new: ['New', 'info'],
  on_hold: ['On hold', 'neutral'],
  // devices / printing
  online: ['Online', 'ok'],
  offline: ['Offline', 'danger'],
  never_seen: ['Not connected', 'neutral'],
  printed: ['Printed', 'ok'],
  failed: ['Retrying', 'warn'],
  dead: ['Failed', 'danger'],
  claimed: ['Printing', 'info'],
};
export function statusLabel(value: string): string {
  return STATUS[value]?.[0] ?? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
export function Badge({ value, label, tone }: { value: string; label?: string; tone?: Tone }) {
  const t = tone ?? STATUS[value]?.[1] ?? 'neutral';
  return <span className={`badge status tone-${t}`}>{label ?? statusLabel(value)}</span>;
}

export function ConnectionDot({ state }: { state: 'connecting' | 'live' | 'polling' }) {
  const label = state === 'live' ? 'Live' : state === 'polling' ? 'Reconnecting…' : 'Connecting…';
  return (
    <span
      className="conn"
      title={state === 'polling' ? 'Connection lost: refreshing every few seconds' : label}
    >
      <span className={`dot ${state}`} /> {label}
    </span>
  );
}

/* ------------------------------------------------------------------ overlays */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking outside closes; Escape and the close button do too
    <div
      className="backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Side panel for forms: the page stays visible behind it. */
export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: clicking outside closes; Escape and the close button do too */}
      <div className="drawer-backdrop" role="presentation" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="close-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ messages */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {errorMessage(error)}
    </div>
  );
}
export function Alert({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode }) {
  return (
    <div className={`alert-box ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'danger';
}
const ToastContext = createContext<(text: string, tone?: 'ok' | 'danger') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'danger' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

/* ------------------------------------------------------------------ forms */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="field">
      <span>
        {label}
        {required ? (
          <span className="req" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="form-section">
      <div>
        <h3>{title}</h3>
        {description ? <div className="desc">{description}</div> : null}
      </div>
      <div className="form">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ PIN pad */
export function PinPad({
  value,
  onChange,
  onSubmit,
  length = 4,
  maxLength = 6,
  disabled,
  shake,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  length?: number;
  maxLength?: number;
  disabled?: boolean;
  shake?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^\d$/.test(e.key) && value.length < maxLength) onChange(value + e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && value.length >= length) onSubmit();
      else if (e.key === 'Escape') onChange('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, onChange, onSubmit, length, maxLength, disabled]);
  const dots = Math.max(length, value.length);
  return (
    <div className="stack">
      <div
        className={`pin-dots ${shake ? 'shake' : ''}`}
        aria-label={`${value.length} digits entered`}
        role="status"
      >
        {Array.from({ length: dots }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional dots
          <span key={i} className={i < value.length ? 'on' : ''} />
        ))}
      </div>
      <div className="numpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            disabled={disabled || value.length >= maxLength}
            onClick={() => onChange(value + d)}
          >
            {d}
          </button>
        ))}
        <button type="button" className="fn" disabled={disabled} onClick={() => onChange('')}>
          Clear
        </button>
        <button
          type="button"
          disabled={disabled || value.length >= maxLength}
          onClick={() => onChange(`${value}0`)}
        >
          0
        </button>
        <button
          type="button"
          className="fn"
          disabled={disabled}
          onClick={() => onChange(value.slice(0, -1))}
          aria-label="Delete"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

export function elapsed(fromIso: string, now: number): string {
  return duration(Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000)));
}

/** m:ss under an hour, then "1h 05m": readable at a glance from across a kitchen. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
