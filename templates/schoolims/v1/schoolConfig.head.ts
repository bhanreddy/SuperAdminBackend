/**
 * Global School Configuration
 * Generated from a SuperAdmin school configuration revision.
 * Shared helpers below are copied from the pinned SchoolIMS template.
 */

import type { SchoolTheme } from '../theme/types';
import { defaultDarkTheme, defaultLightTheme } from '../theme/types';

/**
 * Build `rgba(...)` from `#RRGGBB` / `#RGB` for ribbon overlays and dividers.
 *
 * Marked as a Reanimated worklet so it can be called from inside `useAnimatedStyle`
 * on the UI thread (the scroll-driven dashboard headers do this). Reanimated 4 throws
 * a hard "tried to synchronously call a non-worklet function on the UI thread" error
 * otherwise, which blanks every dashboard after login. It remains a normal function
 * when called from the JS thread (PDFs, welcome screen, ribbon, etc.).
 */
export function schoolColorWithAlpha(hex: string | undefined | null, alpha: number): string {
  'worklet';
  if (hex == null || typeof hex !== 'string') {
    return `rgba(212,175,55,${alpha})`;
  }
  let h = hex.trim().replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return `rgba(212,175,55,${alpha})`;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
