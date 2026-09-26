import type { ConfigurationView, MeView } from '@rp/contracts';
import { useEffect, useState } from 'react';
import { linkTo } from '../../infra/router';
import { api } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Icon } from '../../ui/icons';
import { Shell, Skeleton } from '../../ui/Shell';

type Row = Record<string, unknown>;
interface Step {
  title: string;
  why: string;
  href: string;
  action: string;
  done: boolean;
  optional?: boolean;
  /** Shown instead of a link when the step needs no action (it is already set up for you). */
  note?: string;
}

/**
 * First-time setup for a new owner: thirteen steps in a sensible order, each ticked automatically
 * from the restaurant's real configuration. Nothing here is mandatory; come back any time.
 */
export function SetupGuidePage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [config, setConfig] = useState<ConfigurationView | null>(null);
  const [stockItems, setStockItems] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.configuration().then(setConfig).catch(setError);
    if (branchId)
      api
        .inventory(branchId)
        .then((i) => setStockItems(i.items.length))
        .catch(() => setStockItems(0));
  }, [branchId]);

  const steps: Step[] = config ? buildSteps(config, branchId, stockItems ?? 0) : [];
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);

  return (
    <Shell
      me={me}
      title="Set up your restaurant"
      subtitle="Everything MY FOOD needs to run your restaurant, in order. Skip anything and come back later."
    >
      <ErrorBox error={error} />
      {!config ? (
        <Skeleton rows={8} />
      ) : (
        <>
          <section className="card setup-progress">
            <div className="card-body">
              <div className="row">
                <strong className="grow">
                  {done} of {steps.length} done
                </strong>
                {next ? (
                  <a className="btn primary" href={next.href} onClick={linkTo(next.href)}>
                    Next: {next.title}
                  </a>
                ) : (
                  <span className="ok-text">Your restaurant is ready</span>
                )}
              </div>
              <div
                className="setup-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={done}
                aria-label="Setup progress"
              >
                <div
                  className="setup-bar-fill"
                  style={{ width: `${Math.round((done / steps.length) * 100)}%` }}
                />
              </div>
            </div>
          </section>
          <section className="card">
            <ol className="setup-steps">
              {steps.map((s, i) => (
                <li key={s.title} className={s.done ? 'done' : ''}>
                  <span className="step-mark" aria-hidden>
                    {s.done ? <Icon name="check" size={16} /> : i + 1}
                  </span>
                  <div className="grow">
                    <strong>{s.title}</strong>
                    {s.optional ? <span className="small muted"> · optional</span> : null}
                    <div className="small muted">{s.why}</div>
                  </div>
                  {s.note ? (
                    <span className="small muted">{s.note}</span>
                  ) : (
                    <a className={`btn sm ${s.done ? '' : 'primary'}`} href={s.href} onClick={linkTo(s.href)}>
                      {s.done ? 'Review' : s.action}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </Shell>
  );
}

function buildSteps(config: ConfigurationView, branchId: string, stockItems: number): Step[] {
  const branch = (config.branches as Row[]).find((b) => b.id === branchId);
  const inBranch = (rows: unknown[]) => (rows as Row[]).filter((r) => !r.branchId || r.branchId === branchId);
  const devices = config.devices as Row[];
  const paired = (kind: string) => devices.some((d) => d.kind === kind && d.isActive && d.paired);
  const activeStaff = config.staff.filter((s) => s.isActive).length;
  return [
    {
      title: 'Restaurant details',
      why: 'Name and address, shown on receipts and screens.',
      href: '/settings',
      action: 'Add details',
      done: Boolean(config.restaurant.name && branch?.address),
    },
    {
      title: 'Logo and branding',
      why: 'MY FOOD branding is applied to every screen and receipt.',
      href: '/settings',
      action: 'Review',
      done: true,
      note: 'Ready',
    },
    {
      title: 'Contact information',
      why: 'The phone number printed on receipts.',
      href: '/settings',
      action: 'Add phone',
      done: Boolean(config.restaurant.phone),
    },
    {
      title: 'Currency',
      why: `Prices are in ${config.restaurant.currency}.`,
      href: '/settings',
      action: 'Review',
      done: Boolean(config.restaurant.currency),
      note: config.restaurant.currency,
    },
    {
      title: 'Tax and service charge',
      why: 'Ask your accountant which rates apply; add them once.',
      href: '/menu',
      action: 'Add taxes',
      done: (config.taxRates as Row[]).length > 0,
      optional: true,
    },
    {
      title: 'Dining areas and tables',
      why: 'Hall, terrace, takeaway, and the tables the POS shows.',
      href: '/floor',
      action: 'Set up floor',
      done: inBranch(config.areas).length > 0 && inBranch(config.tables as unknown[]).length > 0,
    },
    {
      title: 'Kitchen stations',
      why: 'Where each dish is prepared (kitchen, grill, drinks) and whether screens show prices.',
      href: '/routing',
      action: 'Set up stations',
      done: inBranch(config.stations).length > 0,
    },
    {
      title: 'Staff',
      why: 'Cashiers, waiters and cooks, each with their own PIN.',
      href: '/staff',
      action: 'Add staff',
      done: activeStaff > 1,
    },
    {
      title: 'Menu',
      why: 'Categories, dishes, prices, options and photos.',
      href: '/menu',
      action: 'Add menu',
      done: (config.products as Row[]).length > 0,
    },
    {
      title: 'Recipes and stock',
      why: 'Ingredients and recipes, so every sale updates stock and cost.',
      href: '/inventory',
      action: 'Add stock items',
      done: stockItems > 0,
      optional: true,
    },
    {
      title: 'Receipt settings',
      why: 'The thank-you message at the bottom of every receipt.',
      href: '/settings',
      action: 'Add message',
      done: Boolean(config.restaurant.receiptFooter),
      optional: true,
    },
    {
      title: 'Customer display',
      why: 'The screen that shows customers when their order is ready.',
      href: '/devices',
      action: 'Connect display',
      done: paired('customer_display'),
      optional: true,
    },
    {
      title: 'POS devices',
      why: 'Pair each till so staff can sign in with their PIN.',
      href: '/devices',
      action: 'Pair a till',
      done: paired('pos'),
    },
  ];
}
