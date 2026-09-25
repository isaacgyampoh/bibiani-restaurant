import { useEffect, useState } from 'react';

/** Minimal client-side router: the app has a handful of top-level screens. */
export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Click handler for in-app links: keeps normal links (new tab, copy) but navigates without reload. */
export function linkTo(path: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [loc, setLoc] = useState(() => ({
    path: location.pathname,
    query: new URLSearchParams(location.search),
  }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, query: new URLSearchParams(location.search) });
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}
