import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  LINES, STATIONS as FALLBACK_STATIONS,
  demoPredictions, demoIncidents,
  type LineCode, type Station, type Train, type Incident,
} from './lib/metro-data';
import * as api from './lib/metro-api';
import { parseStationSlug, stationFromSlug, stationPath, SLUG_ALIASES } from './lib/urls';

const REFRESH_MS = 10_000;
const LS = { station: 'simply-wmata.station' };

// ── helpers ───────────────────────────────────────────────────
const minRank = (m: string): number => {
  if (m === 'BRD') return -2;
  if (m === 'ARR') return -1;
  const n = parseInt(m, 10);
  return Number.isNaN(n) ? 999 : n;
};
const lineOf = (code: LineCode | null) =>
  code && LINES[code] ? LINES[code] : { name: String(code ?? '—'), color: '#888', ink: '#fff' };

// ── presentational bits ───────────────────────────────────────
function LineTile({ code, size = 22 }: { code: LineCode | null; size?: number }) {
  const ln = lineOf(code);
  return (
    <span className="mx-tile" style={{
      width: size, height: size, lineHeight: `${size}px`,
      background: ln.color, color: ln.ink,
    }}>{ln.name[0]}</span>
  );
}

function MinDisplay({ min }: { min: string }) {
  if (min === 'BRD' || min === 'ARR') return <span className="mx-minword">{min}</span>;
  const n = parseInt(min, 10);
  if (Number.isNaN(n)) return <span className="mx-minword dim">—</span>;
  return (
    <span className="mx-minnum">
      {n}<span className="mx-minunit">min</span>
    </span>
  );
}

function ArrivalRow({ t, lead }: { t: Train; lead: boolean }) {
  return (
    <div className={'mx-row' + (lead ? ' lead' : '')}>
      <span className="mx-railaccent" style={{ background: lineOf(t.line).color }} />
      <LineTile code={t.line} />
      <div className="mx-rowmid">
        <div className="mx-dest">{t.dest}</div>
        {t.cars && <div className="mx-cars">{t.cars} car</div>}
      </div>
      <div className="mx-min"><MinDisplay min={t.min} /></div>
    </div>
  );
}

function Platform({ trains }: { trains: Train[] }) {
  const sorted = [...trains].sort((a, b) => minRank(a.min) - minRank(b.min)).slice(0, 4);
  return (
    <div className="mx-plat-block">
      {sorted.length === 0
        ? <div className="mx-empty">No trains scheduled</div>
        : sorted.map((t, i) => <ArrivalRow key={i} t={t} lead={i === 0} />)}
    </div>
  );
}

// ── station picker (custom popover; replaces native select to bound height) ──
// Native <select> sprawls to viewport height on desktop and OS-styled in ways
// CSS can't reach. This button-anchored popover stays bounded and matches the
// rest of the board's styling. Opens upward (picker sits at card bottom).
function StationPicker({
  stations, value, onChange,
}: {
  stations: Station[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // True only while a finger is actually on the list, so the scroll-driven
  // keyboard dismissal can ignore the reflow/clamp scrolls that fire while
  // typing (and the programmatic scroll-into-view on open).
  const touchingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the query when the picker closes so the next open starts fresh.
  // Focus is NOT done here: iOS Safari only raises the on-screen keyboard when
  // focus() runs synchronously inside the tap's own call stack, so it's handled
  // in the trigger's onClick (a focus from an effect/rAF gets the caret but no
  // keyboard on iOS — though it works on Android).
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // Only scroll the active option into view on a fresh, unfiltered open —
  // once the user is typing, the list reorders to the matches anyway.
  useEffect(() => {
    if (!open || query || !menuRef.current) return;
    const active = menuRef.current.querySelector<HTMLElement>('.mx-selectopt.active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, query]);

  // Dismiss the keyboard once the user scrolls the list. touchmove alone (see
  // the menu below) is unreliable on iOS for a position:fixed overflow
  // container while the keyboard is up, so listen for scroll too — but only
  // while a finger is down. Typing shrinks the filtered list, which clamps the
  // scroll position and fires 'scroll' with no touch; without this gate that
  // would blur the field after a single character.
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const onScroll = () => {
      if (!touchingRef.current) return;
      if (document.activeElement === inputRef.current) inputRef.current?.blur();
    };
    menu.addEventListener('scroll', onScroll, { passive: true });
    return () => menu.removeEventListener('scroll', onScroll);
  }, [open]);

  // Filter by station name, plus the short slug aliases (e.g. "dca" → Reagan,
  // "iad" → Dulles) so the well-known shortcuts find their station too.
  const q = query.trim().toLowerCase();
  const filtered = q === ''
    ? stations
    : stations.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        Object.entries(SLUG_ALIASES).some(
          ([slug, name]) => name === s.name && slug.includes(q)));

  return (
    <div ref={wrapRef} className={'mx-selectwrap' + (open ? ' open' : '')}>
      <button type="button" className="mx-select"
              onClick={() => {
                if (open) { setOpen(false); return; }
                // flushSync mounts the menu (and its input) before this handler
                // returns, so the focus() below still runs inside the tap's
                // gesture — the only way iOS Safari will raise the keyboard.
                flushSync(() => setOpen(true));
                inputRef.current?.focus();
              }}
              aria-haspopup="listbox" aria-expanded={open}>
        {value}
      </button>
      <svg className="mx-chev" width="14" height="14" viewBox="0 0 14 14">
        <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="2"
              fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {open && (
        <div ref={menuRef} className="mx-selectmenu" role="listbox"
             // Track real touches so the scroll listener can tell a finger-drag
             // apart from the reflow scroll that fires while typing.
             onTouchStart={() => { touchingRef.current = true; }}
             onTouchEnd={() => { touchingRef.current = false; }}
             onTouchCancel={() => { touchingRef.current = false; }}
             // Fast path: blur the instant the finger starts dragging, before
             // the list moves. Typing never fires touchmove, so this is safe.
             onTouchMove={() => {
               if (document.activeElement === inputRef.current) inputRef.current?.blur();
             }}>
          <div className="mx-searchwrap">
            <input
              ref={inputRef}
              type="text"
              className="mx-search"
              placeholder="Search stations…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) {
                  onChange(filtered[0].name);
                  setOpen(false);
                }
              }}
              aria-label="Search stations"
            />
            {/* Dismiss control for the mobile full-screen overlay (hidden on
                desktop, which closes via outside-click / Escape). */}
            <button type="button" className="mx-searchclose"
                    onClick={() => setOpen(false)} aria-label="Close station search">
              Done
            </button>
          </div>
          {filtered.length === 0
            ? <div className="mx-nomatch">No stations match “{query}”</div>
            : filtered.map((s) => (
                <button key={s.codes.join('-')} type="button" role="option"
                        aria-selected={s.name === value}
                        className={'mx-selectopt' + (s.name === value ? ' active' : '')}
                        onClick={() => { onChange(s.name); setOpen(false); }}>
                  {s.name}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}

// ── data-source / debug sheet ─────────────────────────────────
// The API key lives on the backend now, so the sheet just explains where the
// data is coming from. Kept as a tap target on the "Live/Demo" label so we have
// a place to surface backend status if needed later.
function InfoSheet({ open, source, onClose }: {
  open: boolean;
  source: 'live' | 'demo' | 'loading';
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="mx-scrim" onClick={onClose}>
      <div className="mx-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mx-sheet-grip" />
        <div className="mx-sheet-title">Data source</div>
        <div className="mx-sheet-sub">
          {source === 'live'
            ? 'Live arrivals from the WMATA Rail API, served via the metro.alexr-co.com backend.'
            : source === 'demo'
            ? 'Backend unreachable — falling back to deterministic demo data. Live arrivals will resume automatically.'
            : 'Connecting to the WMATA backend…'}
        </div>
        <div className="mx-sheet-actions">
          <button className="mx-btn solid" onClick={onClose}>Close</button>
        </div>
        <a className="mx-sheet-link" href="https://developer.wmata.com/" target="_blank" rel="noreferrer">
          About the WMATA developer API →
        </a>
      </div>
    </div>
  );
}

// ── main app ──────────────────────────────────────────────────
export default function App() {
  // Theme follows the device's system setting.
  const [dark, setDark] = useState(() =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const [stations, setStations] = useState<Station[]>(FALLBACK_STATIONS);
  // Initial station resolution: URL → localStorage → default.
  // FALLBACK_STATIONS matches the live list for slug lookup; once live data
  // arrives the same name flows through unchanged.
  const [stationName, setStationName] = useState<string>(() => {
    const slug = parseStationSlug(window.location.pathname);
    if (slug) {
      const matched = stationFromSlug(slug, FALLBACK_STATIONS);
      if (matched) return matched.name;
      console.warn('[urls] unknown station slug; falling back', { slug });
    }
    return localStorage.getItem(LS.station) || 'Metro Center';
  });
  const [trains, setTrains] = useState<Train[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [source, setSource] = useState<'loading' | 'live' | 'demo'>('loading');
  const [updatedAt, setUpdatedAt] = useState<number>(Date.now());
  const [, setNowTick] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [spin, setSpin] = useState(0);
  const reqId = useRef(0);

  const station = stations.find((s) => s.name === stationName) ?? stations[0];

  // Try to upgrade the fallback list with the authoritative one from the backend.
  useEffect(() => {
    let cancelled = false;
    api.getStations()
      .then((list) => { if (!cancelled && list.length) setStations(list); })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!station) return;
    const id = ++reqId.current;
    try {
      const [tr, inc] = await Promise.all([
        api.getPredictions(station.codes),
        api.getIncidents().catch(() => [] as Incident[]),
      ]);
      if (id !== reqId.current) return;
      setTrains(tr);
      setIncidents(inc.filter((i) => i.lines.some((l) => station.lines.includes(l))));
      setSource('live');
      setUpdatedAt(Date.now());
      return;
    } catch {
      if (id !== reqId.current) return;
      const seed = Math.floor(Date.now() / REFRESH_MS);
      setTrains(demoPredictions(station, seed));
      setIncidents(demoIncidents(station));
      setSource('demo');
      setUpdatedAt(Date.now());
    }
  }, [station]);

  useEffect(() => {
    setSource('loading');
    load();
    const iv = setInterval(load, REFRESH_MS);
    return () => clearInterval(iv);
  }, [load]);

  // 1s ticker for the "updated Xs ago" line.
  useEffect(() => {
    const iv = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const pickStation = (name: string) => {
    setStationName(name);
    localStorage.setItem(LS.station, name);
    const path = stationPath(name);
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
  };
  const refresh = () => { setSpin((s) => s + 1); load(); };

  // Browser back/forward → re-resolve the URL and update the active station.
  // Uses the latest `stations` list so navigation reflects live data once it
  // arrives.
  useEffect(() => {
    const onPop = () => {
      const slug = parseStationSlug(window.location.pathname);
      if (!slug) return;
      const matched = stationFromSlug(slug, stations);
      if (matched) {
        setStationName(matched.name);
        localStorage.setItem(LS.station, matched.name);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stations]);

  // Keep the URL in sync with the displayed station. Handles three cases:
  //   - root "/" on first load → replace with /stations/<current-slug>
  //   - unknown slug landed and we fell back → URL gets corrected
  //   - any other drift between URL and resolved station
  // replaceState (not pushState) so it doesn't create a back-button entry.
  useEffect(() => {
    if (!station) return;
    const expected = stationPath(station.name);
    if (window.location.pathname !== expected) {
      window.history.replaceState({}, '', expected);
    }
  }, [station?.name]);

  // Document title: lets iOS Add-to-Home-Screen and tab/bookmark labels show
  // the active station rather than the generic landing title.
  useEffect(() => {
    document.title = station ? `${station.name} | Metro` : 'Next Trains | Metro';
  }, [station?.name]);

  // Group trains by physical platform = station code + WMATA Group. Transfer
  // stations (Metro Center A01+C01, L'Enfant D03+F03) get all four platforms.
  const groups: Record<string, Train[]> = {};
  trains.forEach((tr) => {
    const k = (tr.loc || '') + '|' + (tr.group || '1');
    (groups[k] = groups[k] || []).push(tr);
  });
  const groupKeys = Object.keys(groups).sort();

  const elapsed = Math.floor((Date.now() - updatedAt) / 1000);
  const agoText = source === 'loading' ? 'updating…'
    : elapsed < 2 ? 'updated just now'
    : `updated ${elapsed}s ago`;

  return (
    <div className="mx-root" data-theme={dark ? 'dark' : 'light'}>
      <section className="mx-station">
        <div className="mx-stationhead">
          <h1 className="mx-stationName">{station ? station.name : '—'}</h1>
          <div className="mx-tiles">
            {(station ? station.lines : []).map((l) =>
              <LineTile key={l} code={l} size={20} />)}
          </div>
        </div>
        <div className="mx-live">
          <button className="mx-srcbtn" onClick={() => setSheet(true)} title="Data source">
            <span className={'mx-dot ' + source} />
            <span className="mx-srclabel">{source === 'demo' ? 'Demo' : 'Live'}</span>
          </button>
          <span className="mx-livesep">·</span>
          <span className="mx-ago">{agoText}</span>
          <button className="mx-refresh" onClick={refresh} aria-label="Refresh now">
            <svg key={spin} width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.95" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M13.7 2.3v3h-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Header alerts are collapsible context when there ARE trains. When
            the board is empty (closure/end-of-service/etc.), alerts move down
            into the empty-state block so they're immediately visible there. */}
        {incidents.length > 0 && trains.length > 0 && (
          <div className={'mx-alertbox' + (alertsOpen ? ' open' : '')}>
            <button className="mx-alerttoggle" onClick={() => setAlertsOpen((o) => !o)}>
              <svg className="mx-tri" width="13" height="13" viewBox="0 0 18 18">
                <path d="M9 1.5 17 16H1L9 1.5Z" fill="var(--warn)" />
                <rect x="8.1" y="6.4" width="1.8" height="5" rx="0.9" fill="#14130E" />
                <circle cx="9" cy="13.2" r="1" fill="#14130E" />
              </svg>
              <span className="mx-alertcount">
                {incidents.length} service alert{incidents.length > 1 ? 's' : ''}
              </span>
              <svg className="mx-alertchev" width="12" height="12" viewBox="0 0 14 14">
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="2"
                      fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {alertsOpen && (
              <div className="mx-alertlist">
                {incidents.slice(0, 6).map((inc, i) =>
                  <div className="mx-alerttext" key={i}>{inc.text}</div>)}
              </div>
            )}
          </div>
        )}
      </section>

      <main className="mx-board">
        {source === 'loading' && trains.length === 0 && (
          <div className="mx-loading">Loading arrivals…</div>
        )}
        {/* Empty-state: all platforms returned no trains. Could be a closure,
            end of service hours, or a transient hiccup. If incidents apply to
            this station's lines, render their text inline so the user sees
            the explanation without tapping. */}
        {source !== 'loading' && groupKeys.length === 0 && (
          <div className="mx-noarrivals">
            <div className="mx-noarrivals-title">No arrivals at this station</div>
            {incidents.length > 0 && (
              <div className="mx-noarrivals-alerts">
                {incidents.slice(0, 4).map((inc, i) => (
                  <div className="mx-noarrivals-alert" key={i}>
                    <svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M9 1.5 17 16H1L9 1.5Z" fill="var(--warn)" />
                      <rect x="8.1" y="6.4" width="1.8" height="5" rx="0.9" fill="#14130E" />
                      <circle cx="9" cy="13.2" r="1" fill="#14130E" />
                    </svg>
                    <span>{inc.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {groupKeys.map((g) => <Platform key={g} trains={groups[g]} />)}
      </main>

      <footer className="mx-picker">
        <div className="mx-pickerlabel">Station</div>
        <StationPicker stations={stations} value={stationName} onChange={pickStation} />
      </footer>

      <InfoSheet open={sheet} source={source} onClose={() => setSheet(false)} />
    </div>
  );
}
