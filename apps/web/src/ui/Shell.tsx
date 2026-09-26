import type { MeView } from '@rp/contracts';
import { type ReactNode, useState } from 'react';
import { linkTo, useLocation } from '../infra/router';
import { hasPermission, signOut } from '../infra/session';

/* One consistent 18px line-icon set for navigation only. */
const I = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const ICON = {
  dashboard: I('M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z'),
  pos: I('M4 4h16v12H4zM8 20h8M12 16v4'),
  orders: I('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'),
  kitchen: I('M6 3v8a3 3 0 0 0 6 0V3M9 3v18M17 3c-2 2-2 6 0 8v10'),
  expo: I('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'),
  display: I('M3 5h18v11H3zM8 21h8'),
  stock: I('M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8'),
  count: I('M9 3h6l1 2h3v16H5V5h3zM9 12l2 2 4-4'),
  menu: I('M4 5h16M4 12h16M4 19h10'),
  routing: I('M4 6h6l4 6h6M14 12l-4 6H4M18 9l3 3-3 3'),
  floor: I('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z'),
  devices: I('M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z'),
  activity: I('M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),
  promo: I('M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01'),
  staff: I('M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
  reports: I('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  settings: I('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4'),
};

export interface NavItem {
  path: string;
  label: string;
  icon: keyof typeof ICON;
  /** Any one of these permissions shows the item (the server still checks every action). */
  anyOf: string[];
  /** Opens a full-screen operational view (POS, kitchen, supervisor, display). */
  fullScreen?: boolean;
}

export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Operations',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', anyOf: ['reports.view'] },
      { path: '/pos', label: 'POS', icon: 'pos', anyOf: ['order.create'], fullScreen: true },
      { path: '/orders', label: 'Orders', icon: 'orders', anyOf: ['order.view'] },
      { path: '/kds', label: 'Kitchen', icon: 'kitchen', anyOf: ['kitchen.operate'], fullScreen: true },
      {
        path: '/expo',
        label: 'Supervisor',
        icon: 'expo',
        anyOf: ['kitchen.operate', 'order.fulfil'],
        fullScreen: true,
      },
      {
        path: '/display',
        label: 'Customer display',
        icon: 'display',
        anyOf: ['reports.view', 'config.manage'],
        fullScreen: true,
      },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { path: '/inventory', label: 'Stock', icon: 'stock', anyOf: ['inventory.manage', 'stock.count'] },
      {
        path: '/stock-takes',
        label: 'Stock taking',
        icon: 'count',
        anyOf: ['stock.count', 'inventory.manage'],
      },
    ],
  },
  {
    title: 'Menu & setup',
    items: [
      { path: '/menu', label: 'Menu & recipes', icon: 'menu', anyOf: ['menu.manage'] },
      {
        path: '/routing',
        label: 'Stations & routing',
        icon: 'routing',
        anyOf: ['menu.manage', 'config.manage'],
      },
      { path: '/floor', label: 'Floor & tables', icon: 'floor', anyOf: ['config.manage'] },
      {
        path: '/devices',
        label: 'Devices & printing',
        icon: 'devices',
        anyOf: ['device.manage', 'print.manage'],
      },
    ],
  },
  {
    title: 'Management',
    items: [
      { path: '/promotions', label: 'Promotions', icon: 'promo', anyOf: ['promotions.manage'] },
      { path: '/staff', label: 'Staff', icon: 'staff', anyOf: ['staff.manage'] },
      { path: '/reports', label: 'Reports', icon: 'reports', anyOf: ['reports.view'] },
      { path: '/activity', label: 'Activity', icon: 'activity', anyOf: ['audit.view'] },
      { path: '/settings', label: 'Settings', icon: 'settings', anyOf: ['config.manage'] },
    ],
  },
];

export const allowed = (me: MeView, item: NavItem) => item.anyOf.some((p) => hasPermission(me, p));
export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Back-office layout: sidebar navigation + page header. Operational screens are full screen. */
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
          <img className="logo-img" src="/logo-64.png" alt="" />
          <div className="brand-name">
            <span className="brand-kicker">MY FOOD</span>
            <span className="brand-title">{me.restaurant.name}</span>
          </div>
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
                    aria-current={path.startsWith(i.path) ? 'page' : undefined}
                    onClick={(e) => {
                      setOpen(false);
                      linkTo(i.path)(e);
                    }}
                  >
                    {ICON[i.icon]}
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
          <span className="avatar" aria-hidden>
            {initials(me.displayName)}
          </span>
          <div className="who">
            {me.displayName}
            <span>Signed in</span>
          </div>
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
          {actions ? <div className="actions">{actions}</div> : null}
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
      {children ? <div>{children}</div> : null}
      {action ? <div>{action}</div> : null}
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

/** One figure in a metrics strip. `tone` only when the number needs attention. */
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
  const cls = `metric ${tone === 'danger' ? 'alert' : tone === 'warn' ? 'attention' : ''}`;
  const body = (
    <>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {hint ? <div className="metric-hint">{hint}</div> : null}
    </>
  );
  return href ? (
    <a className={cls} href={href} onClick={linkTo(href)}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}
