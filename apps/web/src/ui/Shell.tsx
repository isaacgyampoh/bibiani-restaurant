import type { MeView } from '@rp/contracts';
import { type ReactNode, useState } from 'react';
import { linkTo, useLocation } from '../infra/router';
import { hasPermission, signOut } from '../infra/session';

export interface NavItem {
  path: string;
  label: string;
  icon: string;
  /** Any one of these permissions shows the item. */
  anyOf: string[];
  /** Opens as a full-screen operational view (POS, kitchen, display). */
  fullScreen?: boolean;
}

export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Service',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: '◧', anyOf: ['reports.view'] },
      { path: '/pos', label: 'POS', icon: '▦', anyOf: ['order.create'], fullScreen: true },
      { path: '/orders', label: 'Orders', icon: '☰', anyOf: ['order.view'] },
      { path: '/kds', label: 'Kitchen', icon: '♨', anyOf: ['kitchen.operate'], fullScreen: true },
      {
        path: '/expo',
        label: 'Supervisor',
        icon: '✓',
        anyOf: ['kitchen.operate', 'order.fulfil'],
        fullScreen: true,
      },
      {
        path: '/display',
        label: 'Customer display',
        icon: '▭',
        anyOf: ['reports.view', 'config.manage'],
        fullScreen: true,
      },
    ],
  },
  {
    title: 'Stock',
    items: [
      { path: '/inventory', label: 'Inventory', icon: '▤', anyOf: ['inventory.manage', 'stock.count'] },
      { path: '/stock-takes', label: 'Stock taking', icon: '✎', anyOf: ['stock.count', 'inventory.manage'] },
    ],
  },
  {
    title: 'Setup',
    items: [
      { path: '/menu', label: 'Menu', icon: '❏', anyOf: ['menu.manage'] },
      { path: '/routing', label: 'Stations & routing', icon: '⇉', anyOf: ['menu.manage', 'config.manage'] },
      { path: '/floor', label: 'Floor & tables', icon: '▣', anyOf: ['config.manage'] },
      { path: '/staff', label: 'Staff & roles', icon: '☺', anyOf: ['staff.manage'] },
      { path: '/devices', label: 'Devices & printing', icon: '⎙', anyOf: ['device.manage', 'print.manage'] },
    ],
  },
  {
    title: 'Business',
    items: [
      { path: '/reports', label: 'Reports', icon: '◔', anyOf: ['reports.view'] },
      { path: '/settings', label: 'Settings', icon: '⚙', anyOf: ['config.manage'] },
    ],
  },
];

export const allowed = (me: MeView, item: NavItem) => item.anyOf.some((p) => hasPermission(me, p));

/** Back-office layout: sidebar navigation + page header. Operational screens (POS, KDS) are full screen. */
export function Shell({
  me,
  title,
  subtitle,
  actions,
  children,
}: {
  me: MeView;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="logo" aria-hidden>
            {me.restaurant.name.slice(0, 1)}
          </span>
          <span className="name">{me.restaurant.name}</span>
        </div>
        <nav>
          {NAV.map((group) => {
            const items = group.items.filter((i) => allowed(me, i));
            if (items.length === 0) return null;
            return (
              <div key={group.title} className="nav-group">
                <div className="nav-title">{group.title}</div>
                {items.map((i) => (
                  <a
                    key={i.path}
                    href={i.path}
                    className={`nav-item ${path.startsWith(i.path) ? 'active' : ''}`}
                    onClick={(e) => {
                      setOpen(false);
                      linkTo(i.path)(e);
                    }}
                  >
                    <span className="icon" aria-hidden>
                      {i.icon}
                    </span>
                    {i.label}
                    {i.fullScreen ? (
                      <span className="fs" aria-hidden>
                        ↗
                      </span>
                    ) : null}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="me">
          <div className="who">{me.displayName}</div>
          <button type="button" className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="page-head">
          <button type="button" className="btn menu-toggle" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
          <div className="grow">
            <h1>{title}</h1>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          {actions}
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/** A friendly empty state: what this is, why it is empty, what to do next. */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="muted">{children}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="sk-line" />
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'info';
  href?: string;
}) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </>
  );
  return href ? (
    <a className={`stat ${tone ?? ''}`} href={href} onClick={linkTo(href)}>
      {body}
    </a>
  ) : (
    <div className={`stat ${tone ?? ''}`}>{body}</div>
  );
}
