import { formatMinor } from '@rp/domain';
import { useEffect, useRef, useState } from 'react';
import { followTillScreen, type TillScreenState } from '../../infra/till-screen';

/**
 * The second monitor of a dual-screen till, facing the customer: a welcome screen between
 * customers, the order as it is rung up (items, prices, total), then "Paid · change · thank you".
 * Fed by the POS window on the same machine; no sign-in and no network needed.
 */
export function TillCustomerScreen() {
  const [state, setState] = useState<TillScreenState>({ kind: 'idle' });
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    document.title = 'MY FOOD · Customer screen';
    const off = followTillScreen(setState);
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    // Browsers allow full screen only after a tap: the first tap on this screen enters it.
    const onTap = () => {
      if (!document.fullscreenElement)
        void document.documentElement.requestFullscreen?.().catch(() => undefined);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('click', onTap);
    return () => {
      off();
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('click', onTap);
    };
  }, []);
  // The newest item is always in view.
  useEffect(() => {
    if (state.kind === 'order') list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [state]);
  // After "paid", go back to the welcome screen by itself.
  useEffect(() => {
    if (state.kind !== 'paid') return;
    const t = setTimeout(() => setState({ kind: 'idle' }), 20_000);
    return () => clearTimeout(t);
  }, [state]);

  const money = (m: number, c: string) => formatMinor(m, c);
  return (
    <div className={`till-screen ${state.kind}`}>
      <aside className="ts-brand">
        <img src="/logo-512.png" alt="" />
        <strong>Chefelisha Restaurant</strong>
        <span>Food is better than love</span>
      </aside>
      <main className="ts-main">
        {state.kind === 'idle' ? (
          <div className="ts-welcome">
            <h1>Welcome</h1>
            <p>Your order will appear here.</p>
          </div>
        ) : state.kind === 'paid' ? (
          <div className="ts-paid" role="status">
            <h1>Thank you!</h1>
            <p className="ts-sub">{state.title} is paid.</p>
            <dl>
              <div>
                <dt>Total</dt>
                <dd>{money(state.total, state.currency)}</dd>
              </div>
              {state.change > 0 ? (
                <div className="ts-change">
                  <dt>Your change</dt>
                  <dd>{money(state.change, state.currency)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : (
          <div className="ts-order">
            <h1>{state.title}</h1>
            <ul ref={list}>
              {state.lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: display-only list, rebuilt on every update
                <li key={i}>
                  <span className="q">{l.quantity}×</span>
                  <span className="n">
                    {l.name}
                    {l.detail ? <small>{l.detail}</small> : null}
                  </span>
                  <span className="a">{money(l.amount, state.currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="ts-totals">
              {state.discount > 0 ? (
                <div>
                  <dt>Discounts</dt>
                  <dd>−{money(state.discount, state.currency)}</dd>
                </div>
              ) : null}
              {state.paid > 0 ? (
                <div>
                  <dt>Paid</dt>
                  <dd>{money(state.paid, state.currency)}</dd>
                </div>
              ) : null}
              <div className="ts-total">
                <dt>{state.paid > 0 ? 'To pay' : 'Total'}</dt>
                <dd>{money(state.paid > 0 ? state.due : state.total, state.currency)}</dd>
              </div>
            </dl>
            {state.estimate ? (
              <p className="ts-note">Final total is confirmed when the order is sent.</p>
            ) : null}
          </div>
        )}
        {!fullscreen ? <p className="ts-hint">Tap the screen for full screen</p> : null}
      </main>
    </div>
  );
}
