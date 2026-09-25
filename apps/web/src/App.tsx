import type { MeView } from '@rp/contracts';
import { useCallback, useEffect, useState } from 'react';
import { LoginScreen } from './features/auth/LoginScreen';
import { PairScreen } from './features/auth/PairScreen';
import { SetPasswordScreen } from './features/auth/SetPasswordScreen';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CustomerDisplay } from './features/display/CustomerDisplay';
import { ExpoScreen } from './features/expo/ExpoScreen';
import { InventoryPage } from './features/inventory/InventoryPage';
import { StockTakePage } from './features/inventory/StockTakePage';
import { KdsScreen } from './features/kds/KdsScreen';
import { MenuPage } from './features/menu/MenuPage';
import { OrdersPage } from './features/orders/OrdersPage';
import { PosScreen } from './features/pos/PosScreen';
import { ReportsPage } from './features/reports/ReportsPage';
import { DevicesPage, FloorPage, RoutingPage, SettingsPage, StaffPage } from './features/setup/SetupPages';
import { navigate, useLocation } from './infra/router';
import { api, currentSession, hasPermission, supabase } from './infra/session';
import { ErrorBox } from './ui/components';

/** Picks the right screen for who is signed in. The server still authorizes every action. */
function homeFor(me: MeView): string {
  if (me.kind === 'device') {
    if (me.device?.kind === 'kds') return '/kds';
    if (me.device?.kind === 'customer_display') return '/display';
  }
  if (hasPermission(me, 'reports.view')) return '/dashboard';
  if (hasPermission(me, 'order.create')) return '/pos';
  if (hasPermission(me, 'kitchen.operate')) return '/kds';
  if (hasPermission(me, 'inventory.manage') || hasPermission(me, 'stock.count')) return '/inventory';
  if (hasPermission(me, 'config.manage') || hasPermission(me, 'device.manage')) return '/devices';
  return '/pos';
}

export function App() {
  const { path, query } = useLocation();
  const [me, setMe] = useState<MeView | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const loadMe = useCallback(async () => {
    setError(null);
    if (!(await currentSession())) {
      setMe(null);
      setChecked(true);
      return;
    }
    try {
      setMe(await api.me());
    } catch (e) {
      setMe(null);
      setError(e);
    }
    setChecked(true);
  }, []);

  useEffect(() => {
    void loadMe();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      // Opened from a password email: always ask for the new password, wherever the link landed.
      if (event === 'PASSWORD_RECOVERY') navigate('/set-password', true);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void loadMe();
    });
    return () => data.subscription.unsubscribe();
  }, [loadMe]);

  useEffect(() => {
    if (checked && me && (path === '/' || path === '/login')) navigate(homeFor(me), true);
  }, [checked, me, path]);

  if (path === '/pair') return <PairScreen onPaired={loadMe} />;
  if (path === '/set-password') return <SetPasswordScreen onDone={loadMe} />;
  if (!checked) return <div className="page muted">Loading…</div>;
  if (!me) {
    return (
      <div>
        {error ? (
          <div className="page">
            <ErrorBox error={error} />
          </div>
        ) : null}
        <LoginScreen onSignedIn={loadMe} />
      </div>
    );
  }
  if (path.startsWith('/kds')) return <KdsScreen me={me} stationParam={query.get('station')} />;
  if (path.startsWith('/display')) return <CustomerDisplay me={me} />;
  if (path.startsWith('/expo')) return <ExpoScreen me={me} />;
  if (path.startsWith('/dashboard')) return <DashboardPage me={me} />;
  if (path.startsWith('/orders')) return <OrdersPage me={me} />;
  if (path.startsWith('/inventory')) return <InventoryPage me={me} />;
  if (path.startsWith('/stock-takes'))
    return <StockTakePage me={me} countId={path.split('/')[2] || null} key={path} />;
  if (path.startsWith('/menu')) return <MenuPage me={me} />;
  if (path.startsWith('/routing')) return <RoutingPage me={me} />;
  if (path.startsWith('/floor')) return <FloorPage me={me} />;
  if (path.startsWith('/staff')) return <StaffPage me={me} />;
  if (path.startsWith('/devices') || path.startsWith('/admin')) return <DevicesPage me={me} />;
  if (path.startsWith('/reports')) return <ReportsPage me={me} />;
  if (path.startsWith('/settings')) return <SettingsPage me={me} />;
  if (path.startsWith('/pos')) return <PosScreen me={me} />;
  return <PosScreen me={me} />;
}
