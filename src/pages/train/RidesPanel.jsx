// ─── Rides — the cycling room inside Train ───────────────────────────────────
// A recap screen for one sport, built on the data that actually exists: the
// rides Apple Health already holds, copied over by the Shortcuts automation in
// Train → Apple Watch (netlify/functions/workout-import.js) and stored as the
// same cardio session rows History reads. No new table, no second sync path.
//
// What it answers, in the order you ask it:
//   1. how much have I ridden lately, and is that more or less than before
//   2. what does the last three months look like as a shape
//   3. what are my best rides, ever
//   4. how hard have these rides been
//   5. what exactly happened on any one of them
//
// The rule that shapes every number here: a metric a ride didn't record reads
// "—", never 0. An indoor spin has no distance and a ride without a strap has
// no heart rate; averaging those in as zeros would make the whole tab lie in a
// flattering direction. Where a total is built from only some of the rides,
// the card says so out loud ("distance from 4 of 6 rides").
//
// Every derived number comes from src/lib/ride-engine.js (planted-problem
// smoke test in scripts/ride-smoke.mjs, wired into `npm run verify`).
import { useState, useMemo } from "react";
import {
  Card, SectionHeader, CellGroup, Cell, StatTile, Button, PillRow, Segmented,
  Sheet, useConfirm, Field, EmptyState, Grid, Dot,
} from "../../ui/kit.jsx";
import { IcBike, IcPlus, IcTrash } from "../../ui/icons.jsx";
import WatchSheet from "./WatchSheet.jsx";
import {
  listRides, summarize, compareSummaries, rangeWindow, inWindow, RANGES,
  weeklyRideSeries, ridingStreak, ridePRs, zoneMix, hrZoneOf, rideContext,
  estimateMaxHr, toDistance, fromDistance, toElevation, fromElevation,
  distanceLabel, elevationLabel, speedLabel, fmtDuration, fmtNum, fmtPace,
  PR_MIN_SPEED_KM, PR_MIN_SPEED_SEC, PR_MIN_POWER_SEC,
} from "../../lib/ride-engine.js";

const uuid = () => crypto.randomUUID();
const fmtDate = (t) => new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtDateLong = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtTime = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const signed = (n, digits = 1) => (n == null ? null : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtNum(Math.abs(n), digits)}`);

// ════════════════════════════════════════════════════════════════════════════
export default function RidesPanel({ sessions, wdb, ws, setWs, onRefresh }) {
  const [range, setRange] = useState("d30");
  const [detail, setDetail] = useState(null);   // a ride
  const [logOpen, setLogOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  // Distance unit follows the weight unit unless it's been set on its own —
  // someone lifting in lb reads miles, someone lifting in kg reads km, and
  // either can override it here without touching the barbell.
  const unit = ws.rideUnit === "km" || ws.rideUnit === "mi" ? ws.rideUnit : ws.unit === "kg" ? "km" : "mi";
  const dLabel = distanceLabel(unit), eLabel = elevationLabel(unit), sLabel = speedLabel(unit);

  const rides = useMemo(() => listRides(sessions || []), [sessions]);
  const win = useMemo(() => rangeWindow(range), [range]);
  const inRange = useMemo(() => inWindow(rides, win), [rides, win]);
  const prevRange = useMemo(() => (win.prev ? rides.filter((r) => r.t >= win.prev.from && r.t < win.prev.to) : []), [rides, win]);
  const sum = useMemo(() => summarize(inRange), [inRange]);
  const cmp = useMemo(() => (win.prev ? compareSummaries(sum, summarize(prevRange)) : null), [sum, prevRange, win]);
  const series = useMemo(() => weeklyRideSeries(rides, { weeks: 12 }), [rides]);
  const streak = useMemo(() => ridingStreak(rides), [rides]);
  const prs = useMemo(() => ridePRs(rides), [rides]);

  const maxHr = Number(ws.maxHr) > 0 ? Math.round(Number(ws.maxHr)) : estimateMaxHr(Number(ws.age));
  const maxHrSource = Number(ws.maxHr) > 0 ? "set" : maxHr ? "age" : null;
  const zones = useMemo(() => zoneMix(inRange, maxHr), [inRange, maxHr]);

  const rangeLabel = RANGES.find((r) => r.key === range)?.label || "All time";

  if (sessions === null) return <Card pad="md"><div className="sk" style={{ height: 180, borderRadius: 12 }} /></Card>;

  // ─── nothing has arrived yet ───────────────────────────────────────────────
  if (!rides.length) {
    return (
      <>
        <Card pad="md">
          <EmptyState
            icon={<IcBike size={26} />}
            title="No rides yet"
            sub="Rides ride in from Apple Health: finish one on the watch and the Shortcuts automation posts it here — distance, climbing, heart rate, power. Or log one by hand."
            action={
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <Button kind="primary" size="md" onClick={() => setWatchOpen(true)}>Connect Apple Health</Button>
                <Button kind="quiet" size="md" onClick={() => setLogOpen(true)}>Log a ride</Button>
              </div>
            }
          />
        </Card>
        <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10, lineHeight: 1.5 }}>
          Anything Apple calls cycling counts — Outdoor Cycle, Indoor Cycle, a Peloton class, a hand cycle.
          Runs, rows and lifts stay in History where they belong.
        </div>
        {watchOpen && <WatchSheet ws={ws} setWs={setWs} watchCount={0} onClose={() => setWatchOpen(false)} />}
        {logOpen && <LogRideSheet unit={unit} wdb={wdb} onDone={() => { setLogOpen(false); onRefresh?.(); }} onClose={() => setLogOpen(false)} />}
      </>
    );
  }

  const shown = showAll ? inRange : inRange.slice(0, 12);
  const km = (v) => toDistance(v, unit);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {/* The row already sits inside the page's 16px gutter — the pill row's
          own horizontal padding would double it. 2px keeps the focus ring. */}
      <PillRow options={RANGES} value={range} onChange={setRange} style={{ padding: "2px 0" }} />

      {/* ─── the scoreboard ─────────────────────────────────────────────── */}
      <Card pad="md">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">{rangeLabel}</span>
          <span className="t-cap" style={{ color: streak.weeks > 0 ? "var(--accent)" : "var(--faint)", fontWeight: 600 }}>
            {streak.weeks > 0 ? `${streak.weeks}-week riding streak` : "a ride any week starts a streak"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span className="t-num" style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1 }}>
            {sum.distanceKm == null ? "—" : fmtNum(km(sum.distanceKm), 1)}
          </span>
          <span className="t-head" style={{ color: "var(--sub)" }}>{dLabel}</span>
          <span className="t-foot" style={{ color: "var(--faint)", marginLeft: "auto" }}>
            {sum.count} ride{sum.count === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 12 }}>
          <StatTile value={fmtDuration(sum.durationSec)} label="Time" />
          <StatTile value={sum.avgSpeedKph == null ? "—" : fmtNum(km(sum.avgSpeedKph), 1)} label={`Avg ${sLabel}`}
            valueTone={sum.avgSpeedKph == null ? "var(--faint)" : undefined} />
          <StatTile value={sum.elevationM == null ? "—" : fmtNum(toElevation(sum.elevationM, unit), 0)} label={`Climb (${eLabel})`}
            valueTone={sum.elevationM == null ? "var(--faint)" : undefined} />
          <StatTile value={sum.kcal == null ? "—" : fmtNum(sum.kcal, 0)} label="Calories"
            valueTone={sum.kcal == null ? "var(--faint)" : undefined} />
        </div>

        {cmp && (
          <div className="t-foot" style={{ color: "var(--sub)", marginTop: 10, lineHeight: 1.5 }}>
            vs the previous {win.spanDays} days:{" "}
            <b style={{ color: cmp.count > 0 ? "var(--green)" : "var(--sub)" }}>
              {cmp.count >= 0 ? "+" : "−"}{Math.abs(cmp.count)} ride{Math.abs(cmp.count) === 1 ? "" : "s"}
            </b>
            {cmp.distanceKm != null && <> · {signed(km(cmp.distanceKm))} {dLabel}</>}
            {cmp.durationSec !== 0 && <> · {cmp.durationSec > 0 ? "+" : "−"}{fmtDuration(Math.abs(cmp.durationSec))}</>}
            {cmp.avgSpeedKph != null && Math.abs(cmp.avgSpeedKph) >= 0.05 && <> · {signed(km(cmp.avgSpeedKph))} {sLabel} average</>}
          </div>
        )}

        <Coverage sum={sum} />

        {streak.daysSinceLast != null && (
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6 }}>
            Last ride {streak.daysSinceLast === 0 ? "today" : streak.daysSinceLast === 1 ? "yesterday" : `${streak.daysSinceLast} days ago`}
            {sum.indoorCount > 0 || sum.outdoorCount > 0
              ? ` · ${sum.outdoorCount} outdoor / ${sum.indoorCount} indoor in this window`
              : ""}
          </div>
        )}
      </Card>

      <Grid min={340} gap={12}>
        {/* ─── the shape of the last twelve weeks ───────────────────────── */}
        <Card pad="md" style={{ minWidth: 0 }}>
          <span className="t-head">Last 12 weeks</span>
          <WeeklyRideBars rows={series} unit={unit} />
        </Card>

        {/* ─── all-time bests ──────────────────────────────────────────── */}
        <Card pad="md" style={{ minWidth: 0 }}>
          <span className="t-head">All-time bests</span>
          <BestsList prs={prs} unit={unit} onPick={setDetail} />
          <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10, lineHeight: 1.5 }}>
            Judged against your own rides only. A fastest average needs at least{" "}
            {fmtNum(toDistance(PR_MIN_SPEED_KM, unit), 0)} {dLabel} and {Math.round(PR_MIN_SPEED_SEC / 60)} minutes,
            best power at least {Math.round(PR_MIN_POWER_SEC / 60)} — otherwise a coast down one hill would own the board forever.
          </div>
        </Card>

        {/* ─── effort ──────────────────────────────────────────────────── */}
        <Card pad="md" style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span className="t-head">Effort</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
              <NumIn value={ws.maxHr || ""} placeholder={maxHr ? String(maxHr) : "max HR"} width={72} aria-label="Your maximum heart rate"
                onChange={(v) => setWs({ maxHr: v > 0 ? Math.round(v) : null })} />
              <span className="t-cap" style={{ color: "var(--faint)" }}>max HR</span>
            </span>
          </div>
          {zones ? (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12 }}>
                {zones.rows.map((z) => {
                  const pct = zones.totalSec > 0 ? (z.sec / zones.totalSec) * 100 : 0;
                  return (
                    <div key={z.key} style={{ display: "grid", gridTemplateColumns: "112px 1fr 52px", gap: 10, alignItems: "center" }}>
                      <span className="t-call" style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{z.label}</span>
                      <div style={{ height: 5, borderRadius: 99, background: "var(--ink-a06)", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 99, background: z.tone }} />
                      </div>
                      <span className="t-num" style={{ fontSize: 12, textAlign: "right", color: z.sec ? "var(--ink)" : "var(--faint)" }}>
                        {z.sec ? fmtDuration(z.sec) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="t-cap" style={{ color: "var(--faint)", marginTop: 10, lineHeight: 1.5 }}>
                Each ride placed by its <b>average</b> heart rate — the import carries one average per ride, not a
                beat-by-beat trace, so this is not time-in-zone and never pretends to be.
                {" "}Zones off {maxHr} bpm{maxHrSource === "age" ? " (220 − your age — a population average, ±10 bpm; type your real max above)" : ""}.
                {zones.missing > 0 && ` ${zones.missing} ride${zones.missing === 1 ? "" : "s"} in this window recorded no heart rate.`}
              </div>
            </>
          ) : (
            <div className="t-foot" style={{ color: "var(--faint)", padding: "12px 0", lineHeight: 1.55 }}>
              {maxHr
                ? "No ride in this window recorded a heart rate. Wear the watch on the ride and the zone mix fills itself in."
                : "Set your max heart rate above and every ride's average lands in a zone. No age on file, so nothing is guessed for you."}
            </div>
          )}
          <EffortTiles sum={sum} unit={unit} />
        </Card>

        {/* ─── the log ─────────────────────────────────────────────────── */}
        <section style={{ minWidth: 0 }}>
          <SectionHeader title={`Rides · ${rangeLabel.toLowerCase()}`} trailing="Log a ride" onTrailing={() => setLogOpen(true)} />
          {inRange.length === 0 ? (
            <Card pad="md">
              <div className="t-foot" style={{ color: "var(--faint)", lineHeight: 1.55 }}>
                No rides in this window — {rides.length} in your history overall. Widen the range above.
              </div>
            </Card>
          ) : (
            <CellGroup>
              {shown.map((r) => (
                <Cell key={r.id} onClick={() => setDetail(r)} chevron
                  leading={<IcBike size={18} />}
                  leadingTone={r.indoor === true ? "var(--blue)" : r.indoor === false ? "var(--green)" : undefined}
                  title={r.activity}
                  sub={
                    <span className="t-num" style={{ fontSize: 11.5 }}>
                      {fmtDate(r.t)} · {fmtDuration(r.durationSec)}
                      {r.distanceKm != null && <> · {fmtNum(km(r.distanceKm), 1)} {dLabel}</>}
                      {r.avgHr != null && <> · {Math.round(r.avgHr)} bpm</>}
                      {r.source === "watch" && <span style={{ color: "var(--green)", fontWeight: 600 }}> · watch</span>}
                    </span>
                  }
                  value={r.speedKph != null ? `${fmtNum(km(r.speedKph), 1)} ${sLabel}` : undefined}
                />
              ))}
              {inRange.length > shown.length && (
                <Cell title={`Show all ${inRange.length}`} onClick={() => setShowAll(true)} />
              )}
            </CellGroup>
          )}
        </section>

        {/* ─── the source ──────────────────────────────────────────────── */}
        <section style={{ minWidth: 0 }}>
          <SectionHeader title="Where this comes from" />
          <CellGroup>
            <Cell title="Apple Health auto-import" chevron onClick={() => setWatchOpen(true)}
              sub={rides.filter((r) => r.source === "watch").length > 0
                ? `${rides.filter((r) => r.source === "watch").length} of ${rides.length} rides arrived from the watch`
                : "Not receiving yet — one-time Shortcuts setup"}
              trailing={rides.some((r) => r.source === "watch") ? <Dot tone="var(--green)" size={7} /> : undefined} />
            <Cell title="Distance units" sub="Miles and feet, or kilometres and metres"
              trailing={
                <Segmented style={{ width: 128, flex: "none" }}
                  options={[{ key: "mi", label: "mi" }, { key: "km", label: "km" }]}
                  value={unit} onChange={(u) => setWs({ rideUnit: u })} />
              } />
            <Cell title="Log a ride by hand" sub="For the ride the watch missed" onClick={() => setLogOpen(true)}
              trailing={<span className="cell-chevron" style={{ display: "inline-flex" }}><IcPlus size={16} /></span>} />
          </CellGroup>
        </section>
      </Grid>

      {detail && (
        <RideSheet
          ride={detail} rides={rides} unit={unit} maxHr={maxHr}
          onClose={() => setDetail(null)}
          onDelete={async () => {
            const ok = await confirm({ title: "Delete this ride?", message: "It leaves History too. Apple Health keeps its own copy.", confirmLabel: "Delete", destructive: true });
            if (!ok) return;
            await wdb.deleteSession(detail.id);
            setDetail(null);
            onRefresh?.();
          }}
        />
      )}
      {logOpen && <LogRideSheet unit={unit} wdb={wdb} onDone={() => { setLogOpen(false); onRefresh?.(); }} onClose={() => setLogOpen(false)} />}
      {watchOpen && (
        <WatchSheet ws={ws} setWs={setWs} rideCount={rides.length}
          watchCount={(sessions || []).filter((s) => s.exercises?.[0]?.source === "watch").length}
          onClose={() => setWatchOpen(false)} />
      )}
      {confirmEl}
    </div>
  );
}

// ─── the honesty line under the scoreboard ───────────────────────────────────
// Totals built from a subset say so. Silence here would be the whole tab's
// worst bug: a rider whose indoor sessions carry no distance would read the
// distance total as everything they did.
function Coverage({ sum }) {
  const gaps = [];
  if (sum.count > 0 && sum.distanceRides < sum.count) gaps.push(`distance from ${sum.distanceRides} of ${sum.count}`);
  if (sum.count > 0 && sum.elevationRides > 0 && sum.elevationRides < sum.count) gaps.push(`climb from ${sum.elevationRides}`);
  if (sum.count > 0 && sum.kcalRides > 0 && sum.kcalRides < sum.count) gaps.push(`calories from ${sum.kcalRides}`);
  if (!gaps.length) return null;
  return (
    <div className="t-cap" style={{ color: "var(--faint)", marginTop: 8 }}>
      Not every ride recorded everything — {gaps.join(", ")}.
    </div>
  );
}

// ─── twelve quiet bars ───────────────────────────────────────────────────────
// Distance is the natural axis; a rider whose history is all indoor has no
// distance at all, so the chart falls back to time and SAYS it switched
// rather than drawing twelve empty weeks.
function WeeklyRideBars({ rows, unit }) {
  const hasDistance = rows.some((r) => r.distanceKm > 0);
  const metric = hasDistance ? "distanceKm" : "durationSec";
  const values = rows.map((r) => r[metric]);
  const max = Math.max(1, ...values);
  const W = 300, H = 96, PAD = 2, bw = (W - PAD * 2) / rows.length;
  const last = rows[rows.length - 1];
  const bestIdx = values.indexOf(Math.max(...values));
  const show = (v) => (hasDistance ? `${fmtNum(toDistance(v, unit), 1)} ${distanceLabel(unit)}` : fmtDuration(v));
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <div style={{ marginTop: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }} aria-hidden>
        {rows.map((r, i) => {
          const v = values[i];
          const h = v > 0 ? Math.max(3, (v / max) * (H - 18)) : 2;
          return <rect key={r.weekStart} x={PAD + i * bw + bw * 0.18} y={H - h} width={bw * 0.64} height={h} rx="3"
            fill={i === rows.length - 1 ? "var(--blue)" : "color-mix(in srgb, var(--blue) 45%, transparent)"} />;
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
        <span className="t-cap" style={{ color: "var(--faint)" }}>{rows[0].weekStart.slice(5)}</span>
        <span className="t-num" style={{ fontSize: 12, fontWeight: 600 }}>
          {show(last[metric])} · {last.count} ride{last.count === 1 ? "" : "s"} this wk
        </span>
      </div>
      <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6, lineHeight: 1.5 }}>
        {hasDistance ? "Distance" : "Time — no ride in this stretch recorded a distance"} per Monday-week.
        {total > 0 && bestIdx === rows.length - 1 && last[metric] > 0 && <b style={{ color: "var(--accent)" }}> Your biggest week of the twelve.</b>}
        {total === 0 && " Nothing here yet."}
      </div>
    </div>
  );
}

// ─── all-time bests ──────────────────────────────────────────────────────────
function BestsList({ prs, unit, onPick }) {
  const rows = [
    { key: "distance", label: "Longest ride", fmt: (v) => `${fmtNum(toDistance(v, unit), 1)} ${distanceLabel(unit)}` },
    { key: "duration", label: "Longest time", fmt: (v) => fmtDuration(v) },
    { key: "elevation", label: "Biggest climb", fmt: (v) => `${fmtNum(toElevation(v, unit), 0)} ${elevationLabel(unit)}` },
    { key: "speed", label: "Fastest average", fmt: (v) => `${fmtNum(toDistance(v, unit), 1)} ${speedLabel(unit)}` },
    { key: "power", label: "Best power", fmt: (v) => `${Math.round(v)} W` },
    { key: "kcal", label: "Biggest burn", fmt: (v) => `${fmtNum(v, 0)} kcal` },
  ];
  const live = rows.filter((r) => prs[r.key]);
  if (!live.length) {
    return (
      <div className="t-foot" style={{ color: "var(--faint)", padding: "10px 0", lineHeight: 1.55 }}>
        Bests appear as soon as a ride carries the number — distance, climbing, power. A ride with only a
        clock sets a "longest time" and nothing else, which is the honest answer.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
      {live.map((row) => {
        const pr = prs[row.key];
        return (
          <button key={row.key} onClick={() => onPick(pr.ride)}
            style={{ display: "flex", alignItems: "baseline", gap: 8, background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px", border: "none", width: "100%", textAlign: "left", cursor: "pointer" }}>
            <span style={{ color: "var(--accent)", flex: "none" }}>◆</span>
            <span className="t-call" style={{ fontWeight: 600 }}>{row.label}</span>
            <span className="t-num" style={{ fontSize: 12.5, color: "var(--sub)", marginLeft: "auto", flex: "none" }}>
              {row.fmt(pr.value)} · {fmtDate(pr.ride.t)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Average heart rate / power / cadence across the window — the three numbers
// that describe how the riding FELT, as opposed to how much of it there was.
function EffortTiles({ sum, unit }) {
  const any = sum.avgHr != null || sum.avgWatts != null || sum.maxHr != null;
  if (!any) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 12 }}>
      <StatTile value={sum.avgHr == null ? "—" : Math.round(sum.avgHr)} label="Avg HR (bpm)" valueTone={sum.avgHr == null ? "var(--faint)" : undefined} />
      <StatTile value={sum.maxHr == null ? "—" : Math.round(sum.maxHr)} label="Peak HR" valueTone={sum.maxHr == null ? "var(--faint)" : undefined} />
      <StatTile value={sum.avgWatts == null ? "—" : `${Math.round(sum.avgWatts)} W`} label="Avg power" valueTone={sum.avgWatts == null ? "var(--faint)" : undefined} />
    </div>
  );
}

// ─── one ride, in full ───────────────────────────────────────────────────────
function RideSheet({ ride, rides, unit, maxHr, onClose, onDelete }) {
  const ctx = useMemo(() => rideContext(ride, rides), [ride, rides]);
  const km = (v) => toDistance(v, unit);
  const dLabel = distanceLabel(unit), sLabel = speedLabel(unit);
  const zone = ride.avgHr != null && maxHr ? hrZoneOf(ride.avgHr, maxHr) : null;

  // The comparisons only speak when there is something to compare against.
  const notes = [];
  if (ctx?.distanceRank && ride.distanceKm != null && ctx.distanceRank.of > 1) {
    notes.push(`${ordinal(ctx.distanceRank.place)} longest of your ${ctx.distanceRank.of} rides with a distance`);
  }
  if (ctx?.medianKm != null && ride.distanceKm != null) {
    const d = ride.distanceKm - ctx.medianKm;
    notes.push(`${fmtNum(Math.abs(km(d)), 1)} ${dLabel} ${d >= 0 ? "longer than" : "shorter than"} your typical ride`);
  }
  if (ctx?.medianSpeedKph != null && ride.speedKph != null) {
    const d = ride.speedKph - ctx.medianSpeedKph;
    notes.push(`${fmtNum(Math.abs(km(d)), 1)} ${sLabel} ${d >= 0 ? "quicker" : "easier"} than your usual pace`);
  }
  if (ctx?.elevationRank && ride.elevationM != null && ctx.elevationRank.of > 1) {
    notes.push(`${ordinal(ctx.elevationRank.place)} biggest climb of ${ctx.elevationRank.of}`);
  }

  const stats = [
    ride.distanceKm != null && { v: `${fmtNum(km(ride.distanceKm), 2)}`, l: `Distance (${dLabel})` },
    { v: fmtDuration(ride.durationSec), l: "Moving time" },
    ride.speedKph != null && { v: fmtNum(km(ride.speedKph), 1), l: `Avg ${sLabel}` },
    ride.speedKph != null && { v: fmtPace(ride.speedKph, unit), l: `Pace (min/${dLabel})` },
    ride.elevationM != null && { v: fmtNum(toElevation(ride.elevationM, unit), 0), l: `Climb (${elevationLabel(unit)})` },
    ride.kcal != null && { v: fmtNum(ride.kcal, 0), l: "Calories" },
    ride.avgHr != null && { v: Math.round(ride.avgHr), l: "Avg HR" },
    ride.maxHr != null && { v: Math.round(ride.maxHr), l: "Max HR" },
    ride.avgWatts != null && { v: `${Math.round(ride.avgWatts)} W`, l: "Avg power" },
    ride.avgCadence != null && { v: Math.round(ride.avgCadence), l: "Cadence (rpm)" },
  ].filter(Boolean);

  return (
    <Sheet onClose={onClose} title={ride.activity} z={330}
      footer={<Button kind="quiet" size="lg" full onClick={onDelete} style={{ color: "var(--red)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><IcTrash size={16} /> Delete ride</span>
      </Button>}>
      <div className="t-foot" style={{ color: "var(--sub)" }}>
        {fmtDateLong(ride.t)} · {fmtTime(ride.t)}
        {ride.indoor === true ? " · indoor" : ride.indoor === false ? " · outdoor" : ""}
        {ride.source === "watch" ? " · from Apple Health" : ride.source === "manual" ? " · logged by hand" : ""}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 12 }}>
        {stats.map((s, i) => <StatTile key={i} value={s.v} label={s.l} />)}
      </div>

      {zone && (
        <div className="t-call" style={{ marginTop: 12, background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <Dot tone={zone.tone} size={8} />
          <span><b>{zone.label}</b> — {Math.round((ride.avgHr / maxHr) * 100)}% of a {maxHr} bpm max, on this ride's average.</span>
        </div>
      )}

      {notes.length > 0 && (
        <>
          <div className="t-label" style={{ margin: "16px 0 8px" }}>Against your own history</div>
          <ul className="t-call" style={{ color: "var(--sub)", lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </>
      )}

      {ride.notes && (
        <div className="t-call" style={{ marginTop: 14, color: "var(--sub)", whiteSpace: "pre-wrap" }}>{ride.notes}</div>
      )}

      <div className="t-cap" style={{ color: "var(--faint)", marginTop: 16, lineHeight: 1.5 }}>
        Only what the ride actually recorded is shown — a missing tile means the metric never arrived, not that it was zero.
      </div>
    </Sheet>
  );
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ─── log a ride by hand ──────────────────────────────────────────────────────
// The watch is the main road; this is the shoulder. Same row shape as the
// import writes, tagged source:"manual" so the tab never claims a hand-typed
// ride came from Apple Health.
function LogRideSheet({ unit, wdb, onDone, onClose }) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const [date, setDate] = useState(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  const [time, setTime] = useState(`${pad(today.getHours())}:${pad(today.getMinutes())}`);
  const [indoor, setIndoor] = useState("outdoor");
  const [minutes, setMinutes] = useState(0);
  const [distance, setDistance] = useState(0);
  const [elevation, setElevation] = useState(0);
  const [kcal, setKcal] = useState(0);
  const [avgHr, setAvgHr] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const durationSec = Math.round((minutes || 0) * 60);
  const valid = durationSec >= 60;

  const save = async () => {
    if (!valid) { setErr("A ride needs a duration of at least a minute."); return; }
    setBusy(true); setErr(null);
    try {
      const startedAt = new Date(`${date}T${time || "08:00"}:00`);
      if (Number.isNaN(startedAt.getTime())) throw new Error("that date and time don't parse");
      const activity = indoor === "indoor" ? "Indoor Cycle" : "Outdoor Cycle";
      await wdb.saveSession({
        id: uuid(), template_id: null, template_name: activity, unit: "lb",
        started_at: startedAt.toISOString(),
        ended_at: new Date(startedAt.getTime() + durationSec * 1000).toISOString(),
        duration_sec: durationSec, notes: "",
        exercises: [{
          cardio: true, activity,
          ...(kcal > 0 ? { kcal } : {}),
          ...(avgHr > 0 ? { avgHr } : {}),
          ...(distance > 0 ? { distanceKm: fromDistance(distance, unit) } : {}),
          ...(elevation > 0 ? { elevationM: fromElevation(elevation, unit) } : {}),
          indoor: indoor === "indoor",
          source: "manual",
        }],
        total_volume: 0, total_sets: 0, pr_count: 0,
      });
      onDone();
    } catch (e) {
      setErr(`Couldn't save it: ${e.message || "unknown error"}`);
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} title="Log a ride" z={330}
      footer={<Button kind="primary" size="lg" full disabled={!valid || busy} onClick={save}>{busy ? "Saving…" : "Save ride"}</Button>}>
      <Segmented options={[{ key: "outdoor", label: "Outdoor" }, { key: "indoor", label: "Indoor" }]} value={indoor} onChange={setIndoor} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
        <label style={{ display: "block" }}>
          <span className="t-label">Date</span>
          <Field type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ marginTop: 6 }} />
        </label>
        <label style={{ display: "block" }}>
          <span className="t-label">Start</span>
          <Field type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ marginTop: 6 }} />
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
        <LabeledNum label="Minutes" value={minutes} onChange={setMinutes} />
        <LabeledNum label={`Distance (${distanceLabel(unit)})`} value={distance} onChange={setDistance} decimals />
        <LabeledNum label={`Climb (${elevationLabel(unit)})`} value={elevation} onChange={setElevation} />
        <LabeledNum label="Calories" value={kcal} onChange={setKcal} />
        <LabeledNum label="Avg HR" value={avgHr} onChange={setAvgHr} />
      </div>

      {err && <div className="t-call" style={{ color: "var(--red)", marginTop: 12 }}>{err}</div>}
      <div className="t-cap" style={{ color: "var(--faint)", marginTop: 14, lineHeight: 1.5 }}>
        Duration is the only required field — leave anything you don't know at zero and it stays blank rather
        than counting as nothing. It lands in History alongside your watch rides.
      </div>
    </Sheet>
  );
}

function LabeledNum({ label, value, onChange, decimals }) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span className="t-label">{label}</span>
      <NumIn value={value || ""} onChange={onChange} decimals full style={{ marginTop: 6 }} />
    </label>
  );
}

// A plain numeric input that keeps its own text while focused (so "12." on the
// way to 12.4 survives) — the same contract as the Train tab's steppers,
// without the gym-glove − / + targets a form doesn't need.
// Zero means "not recorded" in every field here, so it shows as empty — the
// placeholder can speak, and a form full of 0s never looks like data.
function NumIn({ value, onChange, placeholder, width = 80, decimals, full, style, "aria-label": ariaLabel }) {
  const [txt, setTxt] = useState("");
  const [focused, setFocused] = useState(false);
  return (
    <Field
      className="t-num"
      value={focused ? txt : (Number(value) > 0 ? String(value) : "")}
      placeholder={placeholder}
      aria-label={ariaLabel}
      inputMode={decimals ? "decimal" : "numeric"}
      onFocus={() => { setFocused(true); setTxt(Number(value) > 0 ? String(value) : ""); }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, "");
        setTxt(v);
        const n = Number(v);
        onChange(v !== "" && !Number.isNaN(n) ? Math.max(0, n) : 0);
      }}
      style={{ ...(full ? {} : { width }), textAlign: full ? undefined : "center", ...style }}
    />
  );
}
