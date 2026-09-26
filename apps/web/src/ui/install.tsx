import { useEffect, useState } from 'react';

/**
 * Installing MY FOOD as an app on a till computer (Chrome / Edge "Install app"): it then opens in
 * its own window with the MY FOOD icon and updates itself with every release. The browser's
 * install offer arrives once, early, so it is captured at startup.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    for (const l of listeners) l();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    for (const l of listeners) l();
  });
}

export const isInstalledApp = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;

export function InstallAppButton({ className = 'btn' }: { className?: string }) {
  const [available, setAvailable] = useState(Boolean(deferred));
  useEffect(() => {
    const update = () => setAvailable(Boolean(deferred));
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  if (!available || isInstalledApp()) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (!deferred) return;
        await deferred.prompt();
        await deferred.userChoice;
        deferred = null;
        setAvailable(false);
      }}
    >
      Install MY FOOD on this computer
    </button>
  );
}
