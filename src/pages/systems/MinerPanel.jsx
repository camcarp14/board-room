// ─── Miner — the NerdQaxe++ in plain English ─────────────────────────────────
// Every stat is three parts: a human label, the number, and one line saying
// what the number MEANS. The real mining term rides along in parentheses inside
// the helper, so the vocabulary gets learned without gating the reading. The
// helpers are deliberately outgrowable — they cost one line each and can be
// deleted in a single pass once they stop earning their space.
//
// Numbers here are tabular/mono but NOT tweened: this polls every 5s and the
// hashrate genuinely wobbles, so counting animations would leave the panel in
// permanent motion — the opposite of "numbers never jiggle" (DESIGN.md §3).

import { Card, SectionHeader, Status, Dot, EmptyState, Grid } from "../../ui/kit.jsx";
import {
  useMiner, MIXED_CONTENT_BLOCKED, fmtDiff, fmtUptime, fmtAgo, fmtNum,
  efficiency, tempTone, vrTempTone, rejectTone,
} from "../../lib/miner.js";

/* ── the stat shape: label · value · what it means ─────────────────────────── */

// `dim` fades the VALUE ROW only, never the label or the helper. Two reasons,
// both found by measuring: (1) semantically only the numbers go stale — "watts
// it's pulling from the wall" is true whether or not we reached the miner this
// second; (2) fading the helper to 0.55 measured 3.05:1 against the card, under
// WCAG AA, and light mode is worse because it washes toward white. The cached
// state is precisely when someone still learning the vocabulary is reading
// those lines, so they stay at full strength. The value keeps 3.3:1 at 0.5,
// which clears AA for large text (21px+/600). Badge + banner carry the rest of
// the "this is stale" signal.
function Stat({ label, value, unit, helper, tone, aside, big, valueSize, dim }) {
  return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <span className="t-call" style={{ fontWeight: 600, color: "var(--ink)" }}>{label}</span>
      {/* flexWrap matters on a phone: at 166px a card carrying value + unit +
          aside (Shares, Pool) can't fit them on one baseline, and without wrap
          the flex squeeze clipped the VALUE — the one thing that must never be
          cut. Wrapped, the aside drops to its own right-aligned line. */}
      <span style={{
        display: "flex", alignItems: "baseline", gap: 5, rowGap: 3, flexWrap: "wrap", minWidth: 0,
        opacity: dim ? 0.5 : 1, transition: "opacity var(--dur-2) var(--ease-out)",
      }}>
        <span className="t-num" style={{
          fontSize: valueSize || (big ? 29 : 21), fontWeight: 600, letterSpacing: "-0.02em",
          color: tone || "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{value}</span>
        {unit && <span className="t-num" style={{ fontSize: big ? 13 : 11.5, color: "var(--faint)", flex: "none" }}>{unit}</span>}
        {aside && <span style={{ flex: "none", marginLeft: "auto" }}>{aside}</span>}
      </span>
      <span className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.42 }}>{helper}</span>
    </Card>
  );
}

/* ── the panel ─────────────────────────────────────────────────────────────── */

export function MinerPanel({ active, isMobile }) {
  const { data: d, at, live, tried } = useMiner(active);

  // Nothing cached and nothing reachable — the only case with no numbers to show.
  if (!d) {
    return (
      <Card pad="md">
        <EmptyState
          title={MIXED_CONTENT_BLOCKED ? "Can't reach the miner from here" : tried ? "Miner not answering" : "Looking for the miner…"}
          sub={MIXED_CONTENT_BLOCKED
            ? "This page is served over HTTPS, which browsers won't let talk to the miner's local HTTP address. Run Board Room locally to see live stats."
            : tried
              ? "Nothing cached yet. Connect to Pirate WiFi and make sure the miner is powered on — stats will appear here and stay cached afterwards."
              : "Checking 10.0.0.157 on the local network."}
        />
      </Card>
    );
  }

  const hash10m = d.hashRate_10m ?? d.hashRate;          // steadier than the instantaneous figure
  const eff = efficiency(d.power, hash10m);
  const overheat = d.overheat_temp ?? 70;
  const pool = d.stratum?.pools?.[0];
  const connected = !!pool?.connected;

  // Truthful per cause: on HTTPS the WiFi was never the problem, so don't send
  // anyone to go check their router (see the header comment in lib/miner.js).
  const banner = live ? null : MIXED_CONTENT_BLOCKED
    ? "This page is served over HTTPS and can't reach the miner's local address. Run Board Room locally for live stats."
    : "Reconnect to Pirate WiFi to refresh.";

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>

      {/* header — live pulse vs. cached badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 4px 10px" }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span className="t-head">{d.deviceModel || "Miner"}</span>
          <span className="t-cap" style={{ color: "var(--faint)", whiteSpace: "nowrap" }}>{d.ASICModel}</span>
        </span>
        {live ? <Status state="live" /> : <Status state="stale" label="Cached" />}
      </div>

      {banner && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 12,
          background: "color-mix(in srgb, var(--amber) 10%, var(--surface))",
          borderRadius: "var(--r-well, 12px)", padding: "11px 13px",
        }}>
          <span style={{ display: "flex", alignItems: "center", height: 16, flex: "none" }}>
            <Dot tone="var(--amber)" size={7} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span className="t-foot" style={{ color: "var(--ink)", fontWeight: 600 }}>Last updated {fmtAgo(at)}</span>
            <span className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.42 }}>{banner}</span>
          </span>
        </div>
      )}

      {/* Dimmed, not hidden: stale numbers are still the truth as of `at`. The
          fade is applied per-stat (see Stat) rather than to this whole block,
          so the helper copy stays legible while the values recede. */}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>

        {/* The four checked most. min=200 (not 220): the content column is
            914px, and 4×220 + 3×12 gap = 916 — two pixels over, which silently
            dropped the row to three cards. 200 keeps all four on one line on
            desktop and still falls to 2×2 on a phone. */}
        <Grid min={isMobile ? 150 : 200} gap={12}>
          <Stat dim={!live}
            big label="Mining Speed" value={fmtNum(hash10m)} unit="GH/s"
            helper="How many billions of guesses per second it's making (hashrate). Higher = more chances."
          />
          <Stat dim={!live}
            big label="Chip Temp" value={fmtNum(d.temp, 1)} unit="°C" tone={tempTone(d.temp, overheat)}
            helper={`Keep under ${overheat}°C. It'll auto-shutoff there to protect itself.`}
          />
          <Stat dim={!live}
            big label="Efficiency" value={eff == null ? "—" : fmtNum(eff, 1)} unit="W/Th"
            helper="Watts per unit of work (W/Th). Lower is better — same as MPG for a car."
          />
          <Stat dim={!live}
            big label="Best Lucky Share" value={fmtDiff(d.bestDiff)}
            helper="Your rarest guess so far (best difficulty). A personal record to beat — not a win."
          />
        </Grid>

        <SectionHeader title="Everything else" style={{ marginTop: 22 }} />
        <Grid min={isMobile ? 150 : 200} gap={12}>
          <Stat dim={!live}
            label="Regulator Temp" value={fmtNum(d.vrTemp, 1)} unit="°C" tone={vrTempTone(d.vrTemp)}
            helper="The power components' temp. Watch this too — it climbs fast under load."
          />
          <Stat dim={!live}
            label="Power Use" value={fmtNum(d.power, 1)} unit="W"
            helper="Watts it's pulling from the wall right now."
          />
          <Stat dim={!live}
            label="Shares" value={fmtNum(d.sharesAccepted)} unit="accepted"
            aside={<span className="t-num" style={{ fontSize: 11.5, color: rejectTone(d.sharesAccepted, d.sharesRejected) }}>
              {fmtNum(d.sharesRejected)} rejected
            </span>}
            helper="Valid work the pool counted. Rejected should stay at/near zero."
          />
          <Stat dim={!live}
            label="Uptime" value={fmtUptime(d.uptimeSeconds)}
            helper="How long it's run without a restart."
          />
          <Stat dim={!live}
            label="Speed Setting" value={fmtNum(d.frequency)} unit={`MHz · ${fmtNum(d.coreVoltageActual)} mV`}
            helper="Clock speed and voltage — what we tuned during overclocking."
          />
          <Stat dim={!live}
            label="Fan" value={fmtNum(d.fanrpm)} unit={`RPM · ${fmtNum(d.fanspeed)}%`}
            helper="Cooling. % is how hard it's working to hold the target temp."
          />
          {/* A plain dot, not <Status state="live">: that one pulses, and a
              pulsing "Connected" under a Cached badge would claim liveness the
              panel doesn't have. */}
          <Stat dim={!live}
            label="Pool" value={d.stratumURL || "—"} valueSize={15}
            aside={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Dot tone={connected ? "var(--green)" : "var(--red)"} size={6} />
                <span className="t-cap" style={{ color: connected ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                  {connected ? "Connected" : "Offline"}
                </span>
              </span>
            }
            helper="The mining pool it's connected to."
          />
        </Grid>
      </div>
    </div>
  );
}

export default MinerPanel;
