import React from 'react';
import { WORKER, TEAM_DB } from './constants.js';
import { useDebounce } from '../components/AddPickModal.jsx';

// Top-of-page search box, extracted from App.jsx (E-8). Owns the query/suggestions/dropdown
// state, the debounced ESPN `/athletes` fetch, the instant client-side team match, and the
// keyboard navigation (arrow keys + enter/escape).
//
// selectPlayer (in App.jsx) clears query + suggestions + dropdown state on selection AND is
// called from handleKeyDown's Enter handler. Same circular-dep shape as useRouting — App
// assigns `selectPlayerRef.current = selectPlayer` once selectPlayer is defined, hook reads
// the ref inside the event handler so it's always populated by call time.
//
// `highlight` (the matched-substring renderer) stays in App.jsx since it's just a pure JSX
// helper used inside the dropdown render — nothing to gain from moving it.
export function usePlayerSearch({ selectPlayerRef }) {
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState([]);
  const [showDrop, setShowDrop] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const [searching, setSearching] = React.useState(false);

  const debouncedQuery = useDebounce(query, 300);
  const dropRef = React.useRef(null);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const h = e => {
      if (!dropRef.current?.contains(e.target) && !inputRef.current?.contains(e.target))
        setShowDrop(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Client-side team search (instant, no API call)
  const teamSuggestions = React.useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return TEAM_DB.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.short.toLowerCase().includes(q) ||
      t.abbr.toLowerCase() === q ||
      t.abbr.toLowerCase().startsWith(q)
    ).slice(0, 5);
  }, [debouncedQuery]);

  // Show dropdown immediately when team suggestions exist
  React.useEffect(() => {
    if (teamSuggestions.length > 0) setShowDrop(true);
  }, [teamSuggestions]);

  React.useEffect(() => {
    if (debouncedQuery.trim().length < 2) { setSuggestions([]); setShowDrop(false); return; }
    setSearching(true);
    fetch(`${WORKER}/athletes?q=${encodeURIComponent(debouncedQuery)}`)
      .then(r => r.json())
      .then(data => {
        const items = (data.items || []);
        setSuggestions(items);
        setShowDrop(items.length > 0 || teamSuggestions.length > 0);
      })
      .catch(e => { console.error("search error:", e); setSuggestions([]); })
      .finally(() => setSearching(false));
  // teamSuggestions intentionally excluded from deps to preserve pre-extraction behavior
  // (closes over the latest value at fetch resolution, which has matched the call sites
  // in practice).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  const handleKeyDown = React.useCallback(e => {
    if (!showDrop) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i+1, suggestions.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter" && activeIdx >= 0) selectPlayerRef.current?.(suggestions[activeIdx]);
    else if (e.key === "Escape") setShowDrop(false);
  // selectPlayerRef is a ref — intentionally not in deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrop, suggestions, activeIdx]);

  return {
    query, setQuery,
    suggestions, setSuggestions,
    showDrop, setShowDrop,
    activeIdx, setActiveIdx,
    searching,
    teamSuggestions,
    handleKeyDown,
    dropRef, inputRef,
  };
}
