/* URL <-> station resolution.
   Slugs are derived from the canonical station name (lowercased, punctuation
   stripped, non-alphanum collapsed to hyphens). A small alias map covers the
   stations whose canonical names are inconveniently long or have well-known
   short forms (DCA, IAD). */

import type { Station } from './metro-data';

const STATIONS_PATH_PREFIX = '/stations/';

// Short, memorable shortcuts. Keys are slugs; values are canonical station
// names (must match Station.name exactly). Resolved before the generated-slug
// path so a typed `dca` doesn't have to round-trip through the long form.
export const SLUG_ALIASES: Record<string, string> = {
  reagan: 'Reagan National Airport',
  'reagan-airport': 'Reagan National Airport',
  dca: 'Reagan National Airport',
  dulles: 'Washington Dulles Intl Airport',
  iad: 'Washington Dulles Intl Airport',
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    // Strip combining accents (NFD splits them out; the range matches them).
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Drop apostrophe variants (typewriter, curly, etc.) without inserting a hyphen.
    .replace(/['‘’ʼ]/g, '')
    // Any remaining non-alphanumeric becomes a hyphen (collapsed).
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function stationPath(name: string): string {
  return STATIONS_PATH_PREFIX + slugify(name);
}

// Returns the slug portion of /stations/<slug>, or null for any other path.
export function parseStationSlug(pathname: string): string | null {
  if (!pathname.startsWith(STATIONS_PATH_PREFIX)) return null;
  const rest = pathname.slice(STATIONS_PATH_PREFIX.length).replace(/\/+$/, '');
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest).toLowerCase();
  } catch {
    return rest.toLowerCase();
  }
}

export function stationFromSlug(slug: string, stations: Station[]): Station | undefined {
  const lowered = slug.toLowerCase();
  const aliasName = SLUG_ALIASES[lowered];
  if (aliasName) {
    const aliased = stations.find((s) => s.name === aliasName);
    if (aliased) return aliased;
  }
  return stations.find((s) => slugify(s.name) === lowered);
}
