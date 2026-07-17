// ─── SESSION icon set ─────────────────────────────────────────────────────────
// 24×24 grid, 1.8 stroke, round caps and joins — SF-Symbols-adjacent geometry.
// Tab icons ship outline + filled pairs; the filled form marks the active tab.
// No emoji anywhere in chrome.

const base = (p) => ({
  width: p.size || 24, height: p.size || 24, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor", strokeWidth: p.weight || 1.8,
  strokeLinecap: "round", strokeLinejoin: "round",
  style: p.style, "aria-hidden": true,
});
const solid = (p) => ({ ...base(p), fill: "currentColor", stroke: "none" });

/* ── tab bar / sidebar ─────────────────────────────────────────────────────── */
export const IcBrief = (p = {}) => ( // sunrise — the morning brief
  <svg {...base(p)}>
    <path d="M5.5 17.5a6.5 6.5 0 0 1 13 0" />
    <line x1="12" y1="4" x2="12" y2="7.5" />
    <line x1="4.9" y1="9.4" x2="6.9" y2="11.4" /><line x1="19.1" y1="9.4" x2="17.1" y2="11.4" />
    <line x1="3" y1="21" x2="21" y2="21" />
  </svg>
);
export const IcBriefFill = (p = {}) => (
  <svg {...solid(p)}>
    <path d="M5.5 18a6.5 6.5 0 0 1 13 0z" />
    <path d="M12 3.1c.5 0 .9.4.9.9v2.5a.9.9 0 0 1-1.8 0V4c0-.5.4-.9.9-.9zM4.3 8.8a.9.9 0 0 1 1.3 0l1.7 1.7a.9.9 0 1 1-1.3 1.3L4.3 10a.9.9 0 0 1 0-1.2zm15.4 0a.9.9 0 0 1 0 1.3l-1.7 1.7a.9.9 0 1 1-1.3-1.3l1.7-1.7a.9.9 0 0 1 1.3 0z" />
    <rect x="3" y="20.1" width="18" height="1.8" rx="0.9" />
  </svg>
);
export const IcPersonal = (p = {}) => ( // person — the private wing
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
  </svg>
);
export const IcPersonalFill = (p = {}) => (
  <svg {...solid(p)}>
    <circle cx="12" cy="8" r="4.4" />
    <path d="M12 13.6c-3.9 0-7 2.4-7.8 6.1-.1.7.4 1.3 1.1 1.3h13.4c.7 0 1.2-.6 1.1-1.3-.8-3.7-3.9-6.1-7.8-6.1z" />
  </svg>
);
export const IcBoard = (p = {}) => ( // Mini Me — your delegate, a small stand-in
  <svg {...base(p)}>
    <line x1="12" y1="3.7" x2="12" y2="5.9" />
    <circle cx="12" cy="2.8" r="1" fill="currentColor" stroke="none" />
    <rect x="4.6" y="5.9" width="14.8" height="12" rx="3.6" />
    <circle cx="9.5" cy="11.7" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="11.7" r="1.15" fill="currentColor" stroke="none" />
    <path d="M9.8 15h4.4" />
  </svg>
);
export const IcBoardFill = (p = {}) => (
  <svg {...solid(p)}>
    <circle cx="12" cy="2.8" r="1.1" />
    <rect x="11.1" y="3" width="1.8" height="3.2" rx="0.9" />
    <rect x="4.4" y="5.7" width="15.2" height="12.4" rx="3.8" />
    <circle cx="9.4" cy="11.6" r="1.35" fill="var(--bg)" />
    <circle cx="14.6" cy="11.6" r="1.35" fill="var(--bg)" />
    <path d="M9.7 15h4.6" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
export const IcAssets = (p = {}) => ( // the bank — what you own
  <svg {...base(p)}>
    <path d="M3.5 9 12 4l8.5 5v.8h-17z" />
    <line x1="6" y1="12.5" x2="6" y2="17.5" /><line x1="12" y1="12.5" x2="12" y2="17.5" /><line x1="18" y1="12.5" x2="18" y2="17.5" />
    <line x1="3.5" y1="20.5" x2="20.5" y2="20.5" />
  </svg>
);
export const IcAssetsFill = (p = {}) => (
  <svg {...solid(p)}>
    <path d="M11.6 3.2a.9.9 0 0 1 .8 0l8.1 4.7c.9.5.5 1.9-.5 1.9H4c-1 0-1.4-1.4-.5-1.9z" />
    <path d="M5.1 11.5h1.8v6H5.1zM11.1 11.5h1.8v6h-1.8zM17.1 11.5h1.8v6h-1.8z" />
    <rect x="3.5" y="19.4" width="17" height="1.8" rx="0.9" />
  </svg>
);
export const IcSystems = (p = {}) => ( // control sliders — the machine room
  <svg {...base(p)}>
    <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9.5" cy="7" r="2.1" fill="var(--bg)" />
    <line x1="4" y1="13.5" x2="20" y2="13.5" /><circle cx="15" cy="13.5" r="2.1" fill="var(--bg)" />
    <line x1="4" y1="20" x2="20" y2="20" /><circle cx="7.5" cy="20" r="2.1" fill="var(--bg)" />
  </svg>
);
export const IcSystemsFill = (p = {}) => (
  <svg {...base({ ...p, weight: 2.4 })}>
    <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9.5" cy="7" r="2.4" fill="currentColor" stroke="var(--bg)" strokeWidth="1.6" />
    <line x1="4" y1="13.5" x2="20" y2="13.5" /><circle cx="15" cy="13.5" r="2.4" fill="currentColor" stroke="var(--bg)" strokeWidth="1.6" />
    <line x1="4" y1="20" x2="20" y2="20" /><circle cx="7.5" cy="20" r="2.4" fill="currentColor" stroke="var(--bg)" strokeWidth="1.6" />
  </svg>
);

/* ── chrome & actions ──────────────────────────────────────────────────────── */
export const IcChevronRight = (p = {}) => <svg {...base({ size: 14, weight: 2.2, ...p })}><polyline points="9 5 16 12 9 19" /></svg>;
export const IcChevronLeft = (p = {}) => <svg {...base({ size: 14, weight: 2.2, ...p })}><polyline points="15 5 8 12 15 19" /></svg>;
export const IcChevronDown = (p = {}) => <svg {...base({ size: 14, weight: 2.2, ...p })}><polyline points="5 9 12 16 19 9" /></svg>;
export const IcPlus = (p = {}) => <svg {...base({ weight: 2, ...p })}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
export const IcClose = (p = {}) => <svg {...base({ weight: 2, ...p })}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
export const IcCheck = (p = {}) => <svg {...base({ weight: 2.2, ...p })}><polyline points="5 12.5 10 17.5 19 6.5" /></svg>;
export const IcSearch = (p = {}) => <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><line x1="15.8" y1="15.8" x2="20.5" y2="20.5" /></svg>;
export const IcRefresh = (p = {}) => <svg {...base({ weight: 2, ...p })}><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" /></svg>;
export const IcSend = (p = {}) => <svg {...solid(p)}><path d="M12 3.5c.3 0 .6.1.8.3l6.4 6.4a1.1 1.1 0 0 1-1.6 1.6l-4.5-4.5V19a1.1 1.1 0 0 1-2.2 0V7.3l-4.5 4.5a1.1 1.1 0 0 1-1.6-1.6l6.4-6.4c.2-.2.5-.3.8-.3z" /></svg>;
export const IcTrash = (p = {}) => <svg {...base(p)}><path d="M4.5 6.5h15" /><path d="M9 6V4.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3V6" /><path d="M6.3 6.5 7 19c.05.8.7 1.5 1.5 1.5h7c.8 0 1.45-.7 1.5-1.5l.7-12.5" /><line x1="10" y1="10.5" x2="10" y2="16.5" /><line x1="14" y1="10.5" x2="14" y2="16.5" /></svg>;
export const IcPencil = (p = {}) => <svg {...base(p)}><path d="M14.5 5 19 9.5 8.5 20H4v-4.5z" /><line x1="12.5" y1="7" x2="17" y2="11.5" /></svg>;
export const IcPin = (p = {}) => <svg {...base(p)}><path d="M12 3.5 15.5 7c1.8-.2 3.4.3 4.5 1.3l-9.7 9.7c-1-1.1-1.5-2.7-1.3-4.5L5.5 10z" transform="rotate(45 12 12)" /><line x1="12" y1="15.5" x2="12" y2="21" /></svg>;
export const IcCalendar = (p = {}) => <svg {...base(p)}><rect x="3.5" y="5" width="17" height="15.5" rx="2.6" /><line x1="3.5" y1="10" x2="20.5" y2="10" /><line x1="8" y1="3" x2="8" y2="6.8" /><line x1="16" y1="3" x2="16" y2="6.8" /></svg>;
export const IcNote = (p = {}) => <svg {...base(p)}><path d="M5 5.8C5 4.8 5.8 4 6.8 4h10.4c1 0 1.8.8 1.8 1.8v9.1L13.9 20H6.8c-1 0-1.8-.8-1.8-1.8z" /><path d="M19 14.5h-3.7a1.3 1.3 0 0 0-1.3 1.3V20" /></svg>;
export const IcClock = (p = {}) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><polyline points="12 7 12 12 15.5 14" /></svg>;
export const IcExternal = (p = {}) => <svg {...base(p)}><path d="M13.5 5H7.3A2.3 2.3 0 0 0 5 7.3v9.4A2.3 2.3 0 0 0 7.3 19h9.4a2.3 2.3 0 0 0 2.3-2.3v-6.2" /><line x1="11.5" y1="12.5" x2="19.5" y2="4.5" /><polyline points="14 4.5 19.5 4.5 19.5 10" /></svg>;
export const IcSpark = (p = {}) => <svg {...solid(p)}><path d="M12 2.5c.5 3.4 1.2 5.4 2.4 6.6 1.2 1.2 3.2 1.9 6.6 2.4-3.4.5-5.4 1.2-6.6 2.4-1.2 1.2-1.9 3.2-2.4 6.6-.5-3.4-1.2-5.4-2.4-6.6C8.4 12.7 6.4 12 3 11.5c3.4-.5 5.4-1.2 6.6-2.4 1.2-1.2 1.9-3.2 2.4-6.6z" /></svg>;
export const IcSun = (p = {}) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><line x1="12" y1="3" x2="12" y2="5.2" /><line x1="12" y1="18.8" x2="12" y2="21" /><line x1="3" y1="12" x2="5.2" y2="12" /><line x1="18.8" y1="12" x2="21" y2="12" /><line x1="5.6" y1="5.6" x2="7.2" y2="7.2" /><line x1="16.8" y1="16.8" x2="18.4" y2="18.4" /><line x1="5.6" y1="18.4" x2="7.2" y2="16.8" /><line x1="16.8" y1="7.2" x2="18.4" y2="5.6" /></svg>;
export const IcMoon = (p = {}) => <svg {...base(p)}><path d="M20 13.2A8.2 8.2 0 0 1 10.8 4a8.2 8.2 0 1 0 9.2 9.2z" /></svg>;
export const IcAutoTheme = (p = {}) => <svg {...base(p)}><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></svg>;
export const IcCommand = (p = {}) => <svg {...base(p)}><path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0v6m0-6h6M9 15H6.5A2.5 2.5 0 1 0 9 17.5V15zm6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15z" /></svg>;
export const IcDumbbell = (p = {}) => <svg {...base(p)}><rect x="2.5" y="9.2" width="3.2" height="5.6" rx="1.1" /><rect x="6.6" y="7" width="3.2" height="10" rx="1.1" /><rect x="18.3" y="9.2" width="3.2" height="5.6" rx="1.1" /><rect x="14.2" y="7" width="3.2" height="10" rx="1.1" /><line x1="9.8" y1="12" x2="14.2" y2="12" /></svg>;
export const IcBook = (p = {}) => <svg {...base(p)}><path d="M4 5.5C4 4.7 4.7 4 5.5 4H10c1.1 0 2 .9 2 2v14c0-1.1-.9-2-2-2H5.5c-.8 0-1.5-.7-1.5-1.5z" /><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H14c-1.1 0-2 .9-2 2v14c0-1.1.9-2 2-2h4.5c.8 0 1.5-.7 1.5-1.5z" /></svg>;
export const IcHeart = (p = {}) => <svg {...base(p)}><path d="M12 20s-7.5-4.7-7.5-10A4.4 4.4 0 0 1 9 5.6c1.3 0 2.4.6 3 1.6.6-1 1.7-1.6 3-1.6a4.4 4.4 0 0 1 4.5 4.4c0 5.3-7.5 10-7.5 10z" /></svg>;
export const IcGift = (p = {}) => <svg {...base(p)}><rect x="4" y="10.5" width="16" height="9.5" rx="1.6" /><line x1="12" y1="7" x2="12" y2="20" /><path d="M4.8 7h14.4v3.5H4.8z" /><path d="M12 7s-.7-3.5-3-3.5A1.75 1.75 0 0 0 9 7zm0 0s.7-3.5 3-3.5A1.75 1.75 0 0 1 15 7z" /></svg>;
export const IcFilm = (p = {}) => <svg {...base(p)}><rect x="3.5" y="4.5" width="17" height="15" rx="2.2" /><line x1="8" y1="4.5" x2="8" y2="19.5" /><line x1="16" y1="4.5" x2="16" y2="19.5" /><line x1="3.5" y1="9.5" x2="8" y2="9.5" /><line x1="3.5" y1="14.5" x2="8" y2="14.5" /><line x1="16" y1="9.5" x2="20.5" y2="9.5" /><line x1="16" y1="14.5" x2="20.5" y2="14.5" /></svg>;
export const IcFood = (p = {}) => <svg {...base(p)}><path d="M5.5 3.5v6.2c0 1 .8 1.8 1.8 1.8h1.4c1 0 1.8-.8 1.8-1.8V3.5" /><line x1="8" y1="3.5" x2="8" y2="20.5" /><path d="M18.5 3.5c-2.2 1-3.5 3.4-3.5 6.5 0 1.7 1 2.5 2 2.7v7.8" /><line x1="18.5" y1="3.5" x2="18.5" y2="20.5" /></svg>;
export const IcWrench = (p = {}) => <svg {...base(p)}><path d="M14.2 6.3a4.6 4.6 0 0 1 5.6-.9l-3 3 .7 2.2 2.2.7 3-3v-.1a4.6 4.6 0 0 1-6.4 5.8L9 21.3a2 2 0 0 1-2.8-2.8L13.5 11a4.6 4.6 0 0 1 .7-4.7z" transform="scale(0.92) translate(1 1)" /></svg>;
export const IcCompass = (p = {}) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor" stroke="none" /></svg>;
export const IcSeal = (p = {}) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="0.8" transform="rotate(45 12 12)" fill="currentColor" stroke="none" /></svg>;

export const IcUpstream = (p = {}) => ( // arrow rising against the current — upstream
  <svg {...base(p)}>
    <line x1="12" y1="14.5" x2="12" y2="4.5" />
    <polyline points="7.8 8.7 12 4.5 16.2 8.7" />
    <path d="M3.5 19c1.4 1.2 2.85 1.2 4.25 0s2.85-1.2 4.25 0 2.85 1.2 4.25 0 2.85-1.2 4.25 0" />
  </svg>
);
export const IcUpstreamFill = (p = {}) => (
  <svg {...base(p)}>
    <path d="M12 3.2c.3 0 .6.1.8.3l4.6 4.6a1.05 1.05 0 0 1-1.5 1.5L13 6.75v8.05a1 1 0 0 1-2 0V6.75L8.1 9.6a1.05 1.05 0 0 1-1.5-1.5l4.6-4.6c.2-.2.5-.3.8-.3z" fill="currentColor" stroke="none" />
    <path d="M3.5 19c1.4 1.2 2.85 1.2 4.25 0s2.85-1.2 4.25 0 2.85 1.2 4.25 0 2.85-1.2 4.25 0" strokeWidth="2.4" />
  </svg>
);

/* ── tab registry — one place decides what the tabs look like ──────────────── */
export const NAV_ICONS = {
  brief: { line: IcBrief, fill: IcBriefFill },
  personal: { line: IcPersonal, fill: IcPersonalFill },
  boardroom: { line: IcBoard, fill: IcBoardFill },
  assets: { line: IcAssets, fill: IcAssetsFill },
  systems: { line: IcSystems, fill: IcSystemsFill },
  upstream: { line: IcUpstream, fill: IcUpstreamFill },
};
