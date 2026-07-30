// ─── Ideas ────────────────────────────────────────────────────────────────────
// What the ideafeed pipeline (github.com/camcarp14/Scanner) turned up on
// GitHub, read straight out of Postgres.
//
// The pipeline already writes every run into this same Pentagon project — the
// `ideafeed_*` tables in `public` — so this page reads those rather than the
// static feed.json the standalone site serves. One dataset, two front ends, no
// sync to keep honest.
//
// Two things live here, in the order they get used: Ideas (repos worth a look)
// and Saved (the ones kept). Skills — the SKILL.md files the pipeline writes —
// sit behind the third pill; they're the pipeline's output rather than the
// thing being browsed, and most days there are none.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase.js";
import { sm } from "../../lib/storage.js";
import { Card, PillRow, Segmented, StatTile, EmptyState, Button, Spinner } from "../../ui/kit.jsx";

// `public`, not `boardroom`: the client is scoped to Board Room's own schema,
// and the ideafeed tables are written by an external pipeline into the default
// one. Per-request schema selection keeps this to one client and one session.
const db = () => supabase?.schema("public");

const TABS = [
  { key: "ideas", label: "Ideas" },
  { key: "saved", label: "Saved" },
  { key: "skills", label: "Skills" },
];

// Matching the standalone app: newest means when it turned up HERE, and the
// tiebreak is score, because everything found in one run shares a timestamp.
const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "popping", label: "Popping" },
  { key: "stars", label: "Stars" },
];

const RANGES = [
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
  { key: 0, label: "All" },
];

const PAGE = 25;
const SAVED_KEY = "ideas_saved";

const compact = (n) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n ?? 0);

const ageLabel = (d) =>
  d == null ? "" : d <= 1 ? "today" : d < 30 ? `${d}d old` : d < 365 ? `${Math.round(d / 30)}mo old` : `${Math.round(d / 365)}y old`;

const ago = (ts) => {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const LANG_COLORS = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Rust: "#dea584",
  Go: "#00ADD8", Java: "#b07219", "C++": "#f34b7d", C: "#555555", Ruby: "#701516",
  Swift: "#F05138", Kotlin: "#A97BFF", Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c",
  Zig: "#ec915c", Lua: "#000080", Jupyter: "#DA5B0B", "Jupyter Notebook": "#DA5B0B",
};

/* ── one repo ─────────────────────────────────────────────────────────────── */

function IdeaCard({ item, saved, onSave }) {
  return (
    <Card pad="md" style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="t-num"
          style={{ fontSize: 13.5, fontWeight: 650, color: "var(--ink)", flex: 1, minWidth: 0, textDecoration: "none", overflowWrap: "anywhere" }}
        >
          <span style={{ color: "var(--sub)", fontWeight: 500 }}>{item.owner}/</span>
          {item.name}
        </a>
        <button
          onClick={() => onSave(item.id)}
          aria-pressed={saved}
          aria-label={saved ? "Remove from saved" : "Save for later"}
          style={{
            flex: "none", background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
            margin: "-2px -4px", fontSize: 15, lineHeight: 1,
            color: saved ? "var(--accent)" : "var(--faint)",
          }}
        >
          {saved ? "★" : "☆"}
        </button>
      </div>

      {item.hook && (
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, marginTop: 6 }}>
          {item.hook}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
        {item.language && (
          <span className="t-cap" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--faint)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: LANG_COLORS[item.language] || "var(--faint)" }} />
            {item.language}
          </span>
        )}
        <span className="t-num" style={{ fontSize: 11, color: "var(--faint)" }}>{compact(item.stars)}★</span>
        {item.stars > (item.stars_at_first_seen ?? item.stars) && (
          <span className="t-num" style={{ fontSize: 11, color: "var(--green)" }}>
            +{compact(item.stars - item.stars_at_first_seen)}
          </span>
        )}
        <span className="t-cap" style={{ color: "var(--faint)" }}>{ageLabel(item.age_days)}</span>
        {item.skills_extracted > 0 && (
          <span className="t-cap" style={{ color: "var(--accent)" }}>
            {item.skills_extracted} skill{item.skills_extracted === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </Card>
  );
}

function SkillCard({ skill }) {
  const [open, setOpen] = useState(false);
  const verdict = skill.verdict || "hold";
  const tone = verdict === "approve" ? "var(--green)" : verdict === "reject" ? "var(--red)" : "var(--amber)";
  return (
    <Card pad="md" style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="t-num" style={{ fontSize: 13, fontWeight: 650, color: "var(--ink)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {skill.slug || skill.name}
        </span>
        <span className="t-cap" style={{ color: tone, flex: "none" }}>
          {skill.published ? "Published" : verdict === "approve" ? "Approved" : verdict === "reject" ? "Rejected" : "Held"}
        </span>
      </div>
      {skill.description && (
        <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.5, marginTop: 6 }}>{skill.description}</div>
      )}
      {skill.source?.full_name && (
        <a
          href={skill.source.url}
          target="_blank"
          rel="noreferrer noopener"
          className="t-num"
          style={{ fontSize: 11, color: "var(--faint)", textDecoration: "none", display: "inline-block", marginTop: 7 }}
        >
          {skill.source.full_name} ↗
        </a>
      )}
      {skill.body && (
        <>
          <Button kind="quiet" size="sm" full onClick={() => setOpen((v) => !v)} style={{ marginTop: 10 }}>
            {open ? "Hide SKILL.md" : "Read SKILL.md"}
          </Button>
          <div className={`expand${open ? " open" : ""}`}>
            <div className="t-foot" style={{ color: "var(--sub)", lineHeight: 1.6, whiteSpace: "pre-wrap", paddingTop: 10, overflowWrap: "anywhere" }}>
              {skill.body}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export function IdeasPage({ isMobile }) {
  const [tab, setTab] = useState("ideas");
  const [sort, setSort] = useState("newest");
  const [range, setRange] = useState(30);
  const [rows, setRows] = useState(null); // null = loading
  const [skills, setSkills] = useState(null);
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [nonce, setNonce] = useState(0);
  const [saved, setSaved] = useState(() => new Set(sm.get(SAVED_KEY) || []));

  const toggleSave = useCallback((id) => {
    setSaved((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      sm.set(SAVED_KEY, [...next]);
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!supabase) { setErr("Supabase isn't configured in this build."); return; }
      setErr(null);
      setRows(null);
      setSkills(null);

      // 500 is the whole feed — the pipeline caps it there, so this is one
      // request rather than a paginated reader over a table that never grows.
      const [c, s, r] = await Promise.all([
        db().from("ideafeed_candidates")
          .select("id,full_name,owner,name,url,hook,language,stars,star_velocity,age_days,score,skills_extracted,stars_at_first_seen,first_seen")
          .order("first_seen", { ascending: false })
          .limit(500),
        db().from("ideafeed_skills")
          .select("id,name,slug,description,body,verdict,published,skill_score,source,first_seen")
          .order("first_seen", { ascending: false })
          .limit(60),
        db().from("ideafeed_runs")
          .select("ran_at,scanned,kept_by_filter,skills_generated,cost_usd")
          .order("ran_at", { ascending: false })
          .limit(1),
      ]);

      if (!alive) return;
      if (c.error) { setErr(c.error.message); setRows([]); return; }
      setRows(c.data || []);
      setSkills(s.error ? [] : s.data || []);
      setRun(r.error ? null : r.data?.[0] || null);
    };
    load();
    return () => { alive = false; };
  }, [nonce]);

  useEffect(() => { setShown(PAGE); }, [tab, sort, range]);

  const visible = useMemo(() => {
    if (!rows) return null;
    let list = tab === "saved" ? rows.filter((r) => saved.has(r.id)) : rows;
    if (range > 0) list = list.filter((r) => (r.age_days ?? 0) <= range);

    const num = (v) => Number(v ?? 0);
    return [...list].sort((a, b) => {
      if (sort === "popping") return num(b.star_velocity) - num(a.star_velocity);
      if (sort === "stars") return num(b.stars) - num(a.stars);
      // Newest: found-at first, then score — one run stamps every row it adds
      // with the same timestamp, so the tiebreak orders the whole batch.
      return (
        new Date(b.first_seen) - new Date(a.first_seen) || num(b.score) - num(a.score)
      );
    });
  }, [rows, tab, sort, range, saved]);

  const newToday = useMemo(() => {
    if (!rows?.length) return 0;
    const newest = rows[0]?.first_seen;
    return newest ? rows.filter((r) => r.first_seen === newest).length : 0;
  }, [rows]);

  const loading = rows === null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, flex: 1 }}>
      <PillRow options={TABS} value={tab} onChange={setTab} style={{ flex: "none" }} />

      {err && (
        <EmptyState
          title="Ideas unreachable"
          sub={err}
          action={<Button kind="tinted" size="sm" onClick={() => setNonce((n) => n + 1)}>Retry</Button>}
          style={{ padding: "24px 12px" }}
        />
      )}

      {!err && tab !== "skills" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr 1fr" : "repeat(3, 1fr)", gap: 8 }}>
            <StatTile value={loading ? "…" : String(rows.length)} label="In the feed" />
            <StatTile value={loading ? "…" : String(newToday)} label="Newest batch" />
            <StatTile value={loading ? "…" : String(saved.size)} label="Saved" />
          </div>

          {/* Segmented, not two PillRows sharing a line: a scrolling pill row
              inside a flex child clipped "Popping" and "Stars" mid-word at
              390px, which reads as a broken control rather than a scrollable
              one. Equal-width thumbs fit three and four options exactly. */}
          <Segmented options={SORTS} value={sort} onChange={setSort} />
          <Segmented options={RANGES} value={range} onChange={setRange} />

          {run && (
            <div className="t-cap" style={{ color: "var(--faint)", padding: "0 2px" }}>
              Last scan {ago(run.ran_at)} · {run.scanned} scanned · {run.kept_by_filter} kept
              {run.cost_usd != null && Number(run.cost_usd) > 0 ? ` · $${Number(run.cost_usd).toFixed(3)}` : " · free"}
            </div>
          )}

          {loading && (
            <div style={{ display: "flex", justifyContent: "center", padding: "28px 0" }}><Spinner /></div>
          )}

          {!loading && visible.length === 0 && (
            <EmptyState
              title={tab === "saved" ? "Nothing saved yet" : "Nothing in this window"}
              sub={tab === "saved" ? "Tap the star on an idea to keep it here." : "Widen the range to see more."}
              style={{ padding: "28px 12px" }}
            />
          )}

          {!loading && visible.slice(0, shown).map((item) => (
            <IdeaCard key={item.id} item={item} saved={saved.has(item.id)} onSave={toggleSave} />
          ))}

          {!loading && visible.length > shown && (
            <Button kind="plain" size="md" full onClick={() => setShown((n) => n + PAGE)}>
              Show more ({visible.length - shown} more)
            </Button>
          )}
        </>
      )}

      {!err && tab === "skills" && (
        <>
          {skills === null && (
            <div style={{ display: "flex", justifyContent: "center", padding: "28px 0" }}><Spinner /></div>
          )}
          {skills?.length === 0 && (
            <EmptyState
              title="No skills yet"
              sub="The reviewer holds anything it can't trace back to the source docs, which is most of what gets written."
              style={{ padding: "28px 12px" }}
            />
          )}
          {skills?.map((s) => <SkillCard key={s.id} skill={s} />)}
        </>
      )}
    </div>
  );
}
