import type { ReceiptView } from '@rp/contracts';
import { useEffect, useState } from 'react';
import { api } from '../infra/session';
import { ErrorBox, Modal } from './components';

type Block = ReceiptView['document']['blocks'][number];

/**
 * Renders the SAME printer-agnostic receipt document the thermal printer receives, as 80 mm paper:
 * one source of truth for the screen, browser printing and ESC/POS. The logo block shows the real
 * brand logo (the printer gets its 1-bit raster).
 */
export function ReceiptPaper({ blocks, reprint }: { blocks: Block[]; reprint?: boolean }) {
  return (
    <section className="receipt-paper" aria-label="Receipt">
      {reprint ? <div className="r-banner">** REPRINT **</div> : null}
      {blocks.map((b, i) => {
        const key = `${i}-${b.type}`;
        switch (b.type) {
          case 'logo':
            return (
              <img key={key} className="r-logo" src="/logo-192.png" alt="MY FOOD — Chefelisha Restaurant" />
            );
          case 'text':
            return (
              <div
                key={key}
                className={`r-line ${b.align === 'center' ? 'r-center' : b.align === 'right' ? 'r-right' : ''} ${b.bold ? 'r-bold' : ''} ${b.size === 'tall' ? 'r-tall' : b.size === 'large' ? 'r-large' : ''}`}
              >
                {b.text}
              </div>
            );
          case 'columns':
            return (
              <div key={key} className={`r-cols ${b.bold ? 'r-bold' : ''}`}>
                <span>{b.left}</span>
                <span>{b.right}</span>
              </div>
            );
          case 'divider':
            return <div key={key} className="r-div" />;
          case 'feed':
            return <div key={key} style={{ height: Math.min(b.lines, 2) * 8 }} />;
          default:
            return null;
        }
      })}
    </section>
  );
}

/** Receipt preview with a browser-print button (works before any thermal printer is installed). */
export function ReceiptModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.receipt(orderId).then(setReceipt).catch(setError);
  }, [orderId]);
  return (
    <Modal
      title={receipt ? `Receipt — order #${receipt.orderNumber}` : 'Receipt'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" disabled={!receipt} onClick={() => window.print()}>
            Print
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {receipt ? (
        <ReceiptPaper blocks={receipt.document.blocks} />
      ) : (
        <div className="muted">Loading receipt…</div>
      )}
    </Modal>
  );
}
