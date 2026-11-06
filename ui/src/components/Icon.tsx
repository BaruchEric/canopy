import type { ReactNode } from "react";

/** One stroke weight and one grid, so a row of tools reads as a set. Sized in
 *  em, so an icon follows the type around it, the screen's scale included. */
const PATHS = {
  terminal: (
    <>
      <path d="m5 8 4 4-4 4" />
      <path d="M12 17h7" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m7 10 2.5 2L7 14" />
      <path d="M12.5 14H16" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="m13.5 5-3 14" />
    </>
  ),
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.4a2 2 0 0 1 1.5.7l1 1.1a2 2 0 0 0 1.5.7h5.6A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z" />,
  spark: (
    <>
      <path d="M12 3.5c.7 4.6 3.4 7.3 8 8-4.6.7-7.3 3.4-8 8-.7-4.6-3.4-7.3-8-8 4.6-.7 7.3-3.4 8-8Z" />
      <path d="M19 3.5v3M20.5 5h-3" />
    </>
  ),
  herd: (
    <>
      <rect x="3.5" y="4" width="7.5" height="7" rx="1.8" />
      <rect x="13" y="4" width="7.5" height="7" rx="1.8" />
      <rect x="3.5" y="13" width="17" height="7" rx="1.8" />
    </>
  ),
  book: (
    <>
      <path d="M12 7c-1.6-1.6-4-2.5-8-2.5V18c4 0 6.4.9 8 2.5 1.6-1.6 4-2.5 8-2.5V4.5c-4 0-6.4.9-8 2.5Z" />
      <path d="M12 7v13.5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 9 5-9 5-9-5Z" />
      <path d="m3.5 13 8.5 4.7 8.5-4.7" />
      <path d="m3.5 17 8.5 4 8.5-4" />
    </>
  ),
  front: (
    <>
      <path d="M8 4H6a2 2 0 0 0-2 2v2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M16 20h2a2 2 0 0 0 2-2v-2" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" />
    </>
  ),
  close: (
    <>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </>
  ),
  down: <path d="M12 4.5v12M7 12l5 5 5-5M6 20.5h12" />,
  up: <path d="M12 17V5M7 9.5 12 4.5l5 5M6 20.5h12" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
