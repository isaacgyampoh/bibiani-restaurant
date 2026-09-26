/**
 * The product's only icon set: thin line icons drawn in the current text colour. No emoji and no
 * symbol characters are used as icons anywhere in the interface.
 */
const PATHS = {
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  check: 'M5 12.5l4.5 4.5L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  external: 'M14 5h5v5M19 5l-8 8M18 14v5H5V6h5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  backspace: 'M9 5h11v14H9l-6-7zM12 9l6 6M18 9l-6 6',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {label ? <title>{label}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
