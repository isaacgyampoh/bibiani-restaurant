import type { MeView } from '@rp/contracts';
import { useCallback, useEffect, useState } from 'react';
import { AdminScreen } from './features/admin/AdminScreen';
import { LoginScreen } from './features/auth/LoginScreen';
import { PairScreen } from './features/auth/PairScreen';
import { SetPasswordScreen } from './features/auth/SetPasswordScreen';
import { CustomerDisplay } from './features/display/CustomerDisplay';
import { KdsScreen } from './features/kds/KdsScreen';
import { PosScreen } from './features/pos/PosScreen';
import { navigate, useLocation } from './infra/router';
import { api, currentSession, hasPermission, supabase } from './infra/session';
import { ErrorBox } from './ui/components';

/** Picks the right screen for who is signed in. The server still authorizes every action. */
function homeFor(me: MeView): string {
  if (me.kind === 'device') {
    if (me.device?.kind === 'kds') return '/kds';
    if (me.device?.kind === 'customer_display') return '/display';
  }
  if (hasPermission(me, 'order.create')) return '/pos';
  if (hasPermission(me, 'kitchen.operate')) return '/kds';
  if (hasPermission(me, 'config.manage') || hasPermission(me, 'device.manage')) return '/admin';
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
  if (path.startsWith('/admin')) return <AdminScreen me={me} />;
  return <PosScreen me={me} />;
}
