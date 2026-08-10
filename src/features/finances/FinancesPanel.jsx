// ─── Finances — where the money actually went ────────────────────────────────
// A month at a time, because that is the unit a budget is kept in and the unit a
// statement arrives in. Everything on this page answers one of four questions,
// in the order you actually ask them:
//
//   What did I spend?          the three figures at the top
//   On what?                   the breakdown, biggest first
//   Am I over?                 budgets, only where you've set one
//   What's on autopilot?       the recurring charges you forgot you signed up for
//
// HOW THE DATA GETS HERE. Chase exports CSV — card and checking both — and this
// imports either without asking which you're holding. That is not a placeholder
// for a real connection: it needs no third-party account, no bank credentials in
// anyone's hands, and it works on the years of history Chase will hand you,
// which a live feed generally won't. A live Plaid connection can sit behind the
// same table later; nothing on this page would change, because the import path
// ends at the same rows.
//
// THE IMPORT IS IDEMPOTENT and that's load-bearing. Every row's id is derived
// from the transaction (financeLogic.txKey), so re-importing an export that
// overlaps one you already loaded updates those rows rather than doubling your
// month. You can export "last 90 days" every month and never think about it.

import { useEffect, useMemo, useRef, useState } from "react";
import { isMissingTable } from "../../data/db.js";
import { useTransactions, useImportTransactions, useSetCategory, useForgetAccount } from "../../data/finances.js";
import {
  Card, Button, Field, Pill, PillRow, Segmented, Dot, StatTile, Sheet, EmptyState, useConfirm,
} from "../../ui/kit.jsx";
import { IcFinances, IcChevronDown, IcClose } from "../../ui/icons.jsx";
import { connectBank, callPlaid, PLAID_SQL } from "./plaid.js";
import {
  CATEGORIES, SPEND_CATEGORIES, catMeta, isSpendCategory, SETUP_SQL,
  parseChaseCsv, money, monthsOf, monthLabel, summarise, compare, budgetStatus,
  recurring, largest, merchantKey, effectiveCategory, applyRule, ruleReach,
  netWorth, groupAccounts, accountKind, accountCents,
} from "./financeLogic.js";

const pct = (n, d) => (d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0);

/* The three figures. In, out, and what's left — the only numbers you'd read out
   loud. Net is coloured because it's the one with a verdict attached. */
function Totals({ s, delta }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
      <StatTile value={money(s.spent, { centsShown: false })} label="Spent"
        delta={delta == null ? undefined : `${delta > 0 ? "+" : "−"}${money(Math.abs(delta), { centsShown: false }).slice(1)}`}
        deltaTone={delta > 0 ? "var(--red)" : "var(--green)"} />
      <StatTile value={money(s.income, { centsShown: false })} label="In" valueTone="var(--green)" />
      <StatTile value={money(s.net, { centsShown: false })} label="Net"
        valueTone={s.net >= 0 ? "var(--green)" : "var(--red)"} />
    </div>
  );
}

/* Balances — where you stand, as opposed to where the month went.

   This sits above the month because it answers the question you open the tab
   for most often, and because it's the number a budget is actually kept against:
   "spent $2,100" means something different with $400 in checking than with
   $9,000. Three figures for the same reason the month has three — cash on hand,
   what's owed, and the difference, which is the one with a verdict attached.

   Never persisted. A balance written to a table is a number that goes stale
   silently and then gets read as current; these are fetched when the tab opens
   and gone when it closes, so what's on screen is either fresh or absent. */
function Balances({ data, onRefresh, busy }) {
  const accounts = data?.accounts || [];
  if (!accounts.length) return null;
  const nw = netWorth(accounts);
  const groups = groupAccounts(accounts);
  return (
    <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="t-label" style={{ flex: 1 }}>Balances</span>
        <Button kind="plain" size="sm" onClick={onRefresh} disabled={busy} style={{ paddingRight: 0 }}>
          {busy ? "Checking…" : "Refresh"}
        </Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <StatTile value={money(nw.cash, { centsShown: false })} label="Cash" />
        <StatTile value={money(nw.debts, { centsShown: false })} label="Owed"
          valueTone={nw.debts > 0 ? "var(--red)" : undefined} />
        <StatTile value={money(nw.net, { centsShown: false })} label="Net"
          valueTone={nw.net >= 0 ? "var(--green)" : "var(--red)"} />
      </div>

      {groups.map((g) => (
        <div key={g.institution} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="t-cap" style={{ color: "var(--faint)" }}>{g.institution}</span>
          {g.accounts.map((a) => {
            const owed = accountKind(a) === "debt";
            const signed = accountCents(a);
            return (
              <div key={a.account_id || a.name} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "5px 0" }}>
                <span className="t-call" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name}
                </span>
                {/* Available, not just current, on anything where the two differ:
                    a card's current balance is what you owe, and the number you
                    actually need before buying something is what's left to spend. */}
                {owed && Number.isFinite(a.available_cents) && (
                  <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>
                    {money(a.available_cents, { centsShown: false })} open
                  </span>
                )}
                <span className="t-call t-num" style={{ flex: "none", fontWeight: 600, color: signed < 0 ? "var(--red)" : "inherit" }}>
                  {Number.isFinite(a.current_cents) ? money(signed) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {/* Both of these are the difference between a wrong total and a partial
          one. Silence here would present an understated net worth as the truth. */}
      {nw.unknown > 0 && (
        <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
          {nw.unknown} account{nw.unknown === 1 ? "" : "s"} didn't report a balance and {nw.unknown === 1 ? "isn't" : "aren't"} in the total.
        </span>
      )}
      {data?.failed?.length > 0 && (
        <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
          Couldn't reach {data.failed.join(", ")} — the total is missing whatever is there.
        </span>
      )}
    </Card>
  );
}

/* The breakdown. A bar per category, widest first, each tinted with its own
   tone so the shape of a month is recognisable at a glance rather than read.
   Tapping one filters the ledger below — the follow-up question is always
   "on what, exactly". */
function Breakdown({ categories, spent, active, onPick }) {
  if (!categories.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {categories.map((c) => (
        <button key={c.key} className="press hoverable" onClick={() => onPick(active === c.key ? "" : c.key)}
          aria-pressed={active === c.key}
          style={{
            background: active === c.key ? "var(--ink-a05)" : "none", border: 0, borderRadius: 10,
            padding: "9px 8px", cursor: "pointer", textAlign: "left", width: "100%", color: "inherit",
          }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Dot tone={c.tone} size={7} />
            <span className="t-call" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
            <span className="t-cap t-num" style={{ color: "var(--faint)", flex: "none" }}>{c.pct}%</span>
            <span className="t-call t-num" style={{ flex: "none", fontWeight: 600 }}>{money(c.cents, { centsShown: false })}</span>
          </div>
          <div style={{ height: 5, borderRadius: 999, background: "var(--ink-a05)", overflow: "hidden" }}>
            <i style={{ display: "block", height: "100%", width: `${pct(c.cents, spent)}%`, background: c.tone, borderRadius: 999 }} />
          </div>
        </button>
      ))}
    </div>
  );
}

/* Budgets. Only categories you've budgeted or actually spent in — a wall of
   twelve zeroes is not a budget, it's a form. An unbudgeted category that ate
   $600 still appears, because that's the row worth seeing. */
function Budgets({ status, onEdit }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {status.rows.map((r) => (
        <button key={r.key} className="press hoverable" onClick={() => onEdit(r.key)}
          style={{ background: "none", border: 0, borderRadius: 10, padding: "10px 8px", cursor: "pointer", textAlign: "left", width: "100%", color: "inherit" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <Dot tone={r.tone} size={7} />
            <span className="t-call" style={{ flex: 1, minWidth: 0 }}>{r.label}</span>
            <span className="t-cap t-num" style={{ color: r.over ? "var(--red)" : "var(--faint)", flex: "none" }}>
              {r.limit == null ? "no budget"
                : r.over ? `${money(r.spent - r.limit, { centsShown: false })} over`
                : `${money(r.left, { centsShown: false })} left`}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 999, background: "var(--ink-a05)", overflow: "hidden" }}>
              {/* Width is the clamped percentage, not the raw one — 4,000% of a
                  $5 budget would render a bar wider than the phone. */}
              <i style={{ display: "block", height: "100%", width: `${Math.min(100, r.pct ?? 0)}%`, background: r.over ? "var(--red)" : r.tone, borderRadius: 999 }} />
            </div>
            <span className="t-cap t-num" style={{ color: "var(--sub)", flex: "none", minWidth: 92, textAlign: "right" }}>
              {money(r.spent, { centsShown: false })}{r.limit != null && ` / ${money(r.limit, { centsShown: false })}`}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

/* One transaction. The name, what it cost, and the category as a tappable chip —
   recategorising is the thing you do most while reading a month, so it's one tap
   from the row rather than behind an edit mode. */
function TxRow({ t, onCat }) {
  const cat = catMeta(t.category);
  const inflow = t.amount > 0;
  return (
    <div className="cell" style={{ minHeight: 54, gap: 8, alignItems: "center" }}>
      <div className="cell-body" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.merchant || t.description}
        </span>
        <span className="t-cap" style={{ color: "var(--faint)" }}>{t.date.slice(5).replace("-", "/")} · {t.account || "—"}</span>
      </div>
      <button className="press" onClick={() => onCat(t)} aria-label={`Category: ${cat.label}. Change it.`}
        style={{ background: "var(--ink-a05)", border: 0, borderRadius: 999, padding: "3px 9px", cursor: "pointer", flex: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <Dot tone={cat.tone} size={5} />
        <span className="t-cap" style={{ color: "var(--sub)", whiteSpace: "nowrap" }}>{cat.label}</span>
      </button>
      <span className="t-call t-num" style={{ flex: "none", fontWeight: 600, color: inflow ? "var(--green)" : "var(--ink)" }}>
        {money(t.amount, { signed: inflow })}
      </span>
    </div>
  );
}

/* The import. A textarea, not only a file picker: on a phone you're as likely to
   have the CSV in a share sheet or a mail attachment you can copy from as on a
   filesystem you can browse. Both paths land in the same place. */
function ImportSheet({ onClose, onDone }) {
  const [account, setAccount] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);   // parse preview
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const importMut = useImportTransactions();

  const parse = (raw, acct) => {
    const r = parseChaseCsv(raw, { account: (acct ?? account).trim() });
    setResult(r);
    setErr(r.error);
  };
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const raw = await f.text();
    setText(raw);
    // The file name is a better account label than nothing, and you can edit it.
    const guess = account.trim() || f.name.replace(/\.[a-z]+$/i, "").replace(/[_-]+/g, " ").slice(0, 40);
    setAccount(guess);
    parse(raw, guess);
  };

  const save = async () => {
    if (!result?.rows?.length) return;
    setSaving(true); setErr(null);
    try {
      const n = await importMut.mutateAsync(result.rows);
      onDone(n, result);
    } catch (e) {
      setErr(e?.message || "Couldn't save those transactions.");
    } finally { setSaving(false); }
  };

  return (
    <Sheet onClose={onClose} title="Import from Chase"
      footer={
        <>
          <Button kind="quiet" size="md" onClick={onClose} style={{ flex: 1 }}>Cancel</Button>
          <Button kind="primary" size="md" onClick={save} disabled={!result?.rows?.length || saving} style={{ flex: 1 }}>
            {saving ? "Importing…" : result?.rows?.length ? `Import ${result.rows.length}` : "Import"}
          </Button>
        </>
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5, margin: 0 }}>
          On chase.com open the account, then <b>Download account activity</b> and choose CSV. Card and
          checking exports both work — you don't have to say which this is.
        </p>

        <div style={{ display: "flex", gap: 8 }}>
          <Field value={account} onChange={(e) => { setAccount(e.target.value); if (text) parse(text, e.target.value); }}
            placeholder="Account name — e.g. Sapphire, or Checking" style={{ flex: 1, minWidth: 0 }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Button kind="tinted" size="md" onClick={() => fileRef.current?.click()} style={{ flex: 1 }}>Choose a file</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} style={{ display: "none" }} />
        </div>

        <textarea value={text} onChange={(e) => { setText(e.target.value); parse(e.target.value); }}
          placeholder="…or paste the CSV here"
          spellCheck={false}
          style={{
            width: "100%", minHeight: 120, resize: "vertical", padding: "10px 12px", borderRadius: 12,
            background: "var(--surface-2)", border: "0.5px solid var(--line)", color: "var(--ink)",
            font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
          }} />

        {err && <div className="t-cap" style={{ color: "var(--red)", lineHeight: 1.45 }}>{err}</div>}

        {result?.rows?.length > 0 && (
          <div style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px" }}>
            <div className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5 }}>
              Read as a <b>{result.format.label}</b> export · {result.rows.length} transaction{result.rows.length === 1 ? "" : "s"} ·
              {" "}{result.rows[0].date} to {result.rows.at(-1).date}
            </div>
            {/* Rows that couldn't be read are SAID, not swallowed. A 400-row
                export with three bad lines should import 397 and tell you. */}
            {result.skipped.length > 0 && (
              <div className="t-cap" style={{ color: "var(--amber)", marginTop: 6, lineHeight: 1.45 }}>
                {result.skipped.length} line{result.skipped.length === 1 ? "" : "s"} couldn't be read and will be skipped
                {" "}(line {result.skipped.slice(0, 3).map((s) => s.line).join(", ")}
                {result.skipped.length > 3 ? "…" : ""}).
              </div>
            )}
            <div className="t-cap" style={{ color: "var(--faint)", marginTop: 6, lineHeight: 1.45 }}>
              Re-importing an overlapping export is safe — rows are matched on the transaction itself, so
              nothing doubles.
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function FinancesPanel({ isMobile, settings, updateSetting }) {
  // useTransactions returns an envelope now, not a bare array — the read caps at
  // 5,000 rows and nothing used to say so, which made every total on this page a
  // number computed over a silent slice and presented as the whole history.
  const { data: txData = null, error, refetch } = useTransactions();
  const rows = txData ? txData.rows : null;
  const txCapped = txData?.capped ? { total: txData.total, limit: txData.limit } : null;
  const needsSetup = !!error && isMissingTable(error, "transactions");
  const loadErr = error && !needsSetup ? (error.message || "Couldn't load your transactions.") : null;
  const setCat = useSetCategory();
  const forget = useForgetAccount();

  const [tab, setTab] = useState("month");      // month | budgets | recurring
  const [month, setMonth] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [catFor, setCatFor] = useState(null);   // the row whose category sheet is open
  const [onlyThis, setOnlyThis] = useState(false);
  const [budgetFor, setBudgetFor] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // Plaid. `banks` is null until asked — the status call is only made when you
  // open the accounts card, so a page view never touches the function.
  const [banks, setBanks] = useState(null);
  const [linking, setLinking] = useState(null);   // a human progress string
  const [linkErr, setLinkErr] = useState(null);
  const [plaidSql, setPlaidSql] = useState(false);
  const [diag, setDiag] = useState(null);
  // Balances live only here — see the Balances card for why they are never
  // written to a table.
  const [balances, setBalances] = useState(null);
  const [balancing, setBalancing] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const all = rows || [];
  const budgets = settings?.finance_budgets || {};
  // Merchant rules: "Blue Bottle is always Dining". Kept in settings rather than
  // on the rows, so setting one costs no write and re-files every past charge
  // from that merchant at once — see effectiveCategory.
  const rules = settings?.finance_rules || {};
  const months = useMemo(() => monthsOf(all), [all]);
  // The month must not survive its data: import a different year and a stale
  // selection would show an empty month you can't explain.
  const activeMonth = months.includes(month) ? month : (months[0] || "");
  const prevMonth = months[months.indexOf(activeMonth) + 1] || "";
  const cmp = useMemo(() => compare(all, activeMonth, prevMonth, rules), [all, activeMonth, prevMonth, rules]);
  const s = cmp.now;
  const budgetView = useMemo(() => budgetStatus(s, budgets), [s, budgets]);
  const subs = useMemo(() => recurring(all, { rules }), [all, rules]);
  const accounts = useMemo(() => [...new Set(all.map((t) => t.account).filter(Boolean))].sort(), [all]);

  const ledger = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.rows
      // s.rows already carry the resolved category — re-deriving here would
      // ignore a rule and make the filter disagree with the bar you tapped.
      .filter((t) => !catFilter || t.category === catFilter)
      .filter((t) => !needle || `${t.merchant} ${t.description}`.toLowerCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date) || a.amount - b.amount);
  }, [s.rows, catFilter, q]);

  const saveBudget = () => {
    const cents = Math.round(parseFloat(String(budgetDraft).replace(/[^0-9.]/g, "")) * 100);
    const next = { ...budgets };
    if (Number.isFinite(cents) && cents > 0) next[budgetFor] = cents;
    else delete next[budgetFor];     // clearing the field removes the budget
    updateSetting?.("finance_budgets", next);
    setBudgetFor(null); setBudgetDraft("");
  };

  const refreshBanks = () => callPlaid("status").then(setBanks).catch(() => setBanks({ items: [], unavailable: true }));

  /* Balances, on demand. Silent on failure for the same reason the auto-sync is:
     the card simply doesn't appear, and the month — which is the thing you came
     for and which needs no network at all — is not covered in red because a
     bank was slow. */
  const refreshBalances = async () => {
    setBalancing(true);
    try { setBalances(await callPlaid("balances")); }
    catch { /* leave whatever was last shown; the month stands on its own */ }
    finally { setBalancing(false); }
  };

  /* The connect-failure surface, in ONE place because it is rendered twice — on
     the empty first screen and in the Accounts card — and a message improved in
     only one of them is the kind of thing nobody notices until it matters.

     "Check config" reports SHAPE, never values: which Plaid environment the
     function is talking to and whether each key is the right length and format.
     That distinguishes the three causes of a rejected key — wrong environment, a
     truncated paste, client_id and secret swapped — which Plaid's own message
     ("invalid client_id or secret provided") does not. */
  const linkErrorBlock = !linkErr ? null : (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span className="t-cap" style={{ color: "var(--red)", flex: 1, lineHeight: 1.45 }}>{linkErr}</span>
        <Button kind="plain" size="sm" style={{ flex: "none" }}
          onClick={() => callPlaid("diag").then(setDiag).catch((e) => setDiag({ error: e.message }))}>
          Check config
        </Button>
        <Button kind="plain" size="sm" onClick={() => setPlaidSql((v) => !v)} style={{ flex: "none" }}>Setup SQL</Button>
      </div>
      {diag && (
        <div className="t-cap" style={{ background: "var(--surface-2)", borderRadius: 12, padding: "10px 12px", lineHeight: 1.6, color: "var(--sub)" }}>
          {diag.error ? <span style={{ color: "var(--red)" }}>{diag.error}</span> : (
            <>
              <div>Environment: <b>{diag.env}</b> → {diag.host}</div>
              <div>Client ID: {diag.clientIdLength} chars {diag.looksLikeClientId ? "· looks right" : "· NOT the usual 24-character format"}</div>
              <div>Secret: {diag.secretLength} chars {diag.looksLikeSecret ? "· looks right" : "· NOT the usual 30-character format"}</div>
              {diag.probe && (
                <div style={{ marginTop: 4 }}>
                  Plaid was asked directly: production <b>{diag.probe.production}</b> · sandbox <b>{diag.probe.sandbox}</b>
                </div>
              )}
              {/* A fact rather than a hypothesis. Shape alone could only ever say
                  "well-formed", which is where the previous version stopped. */}
              {diag.mismatch && (
                <div style={{ marginTop: 6, color: "var(--ink)" }}>
                  Your keys are <b>{diag.worksIn}</b> keys, but PLAID_ENV is set to <b>{diag.env}</b>. Either set
                  PLAID_ENV to <b>{diag.worksIn}</b> and redeploy, or paste the <b>{diag.env}</b> secret from
                  Plaid → Developers → Keys.
                  {diag.worksIn === "sandbox" && " Sandbox is Plaid's test bank — real-looking data, not your money."}
                </div>
              )}
              {!diag.worksIn && diag.probe && (
                <div style={{ marginTop: 6, color: "var(--ink)" }}>
                  Neither environment accepted these keys, so it isn't the environment — the client_id and secret
                  don't belong together. Re-copy both from Plaid → Developers → Keys.
                </div>
              )}
            </>
          )}
        </div>
      )}
      {plaidSql && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <pre style={{
            margin: 0, padding: 12, borderRadius: 12, background: "var(--surface-2)", overflowX: "auto",
            font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", color: "var(--sub)",
          }}>{PLAID_SQL}</pre>
          <Button kind="tinted" size="sm" style={{ alignSelf: "flex-start" }}
            onClick={() => navigator.clipboard?.writeText(PLAID_SQL)}>Copy</Button>
        </div>
      )}
    </div>
  );

  /* Auto-sync. The point of connecting a bank was to stop doing this by hand, so
     opening the tab syncs if the last pull is more than SYNC_AFTER old.

     Three guards, each for a thing that would otherwise be worse than no
     auto-sync at all:
       · once per mount (autoSynced), so a re-render can't fire a second pull;
       · only when something is actually connected, so an unconfigured install
         never calls the function at all;
       · silent on failure. A background sync that paints a red banner over a
         month you were reading is a worse trade than a stale number — the
         explicit Sync now button is there to surface a real error on demand. */
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current) return;
    let alive = true;
    (async () => {
      try {
        const st = await callPlaid("status");
        if (!alive) return;
        setBanks(st);
        if (!st.items?.length) return;
        // Balances first, and regardless of whether a sync is due: it's one call
        // per bank, it writes nothing, and it's the number at the top of the
        // page — waiting for a six-hourly transaction pull to refresh it would
        // mean opening the tab and reading yesterday's figure.
        callPlaid("balances").then((b) => alive && setBalances(b)).catch(() => {});
        const SYNC_AFTER = 6 * 60 * 60 * 1000;   // six hours; banks post once a day
        const freshest = st.items.reduce((m, b) => Math.max(m, b.synced_at ? Date.parse(b.synced_at) : 0), 0);
        if (Date.now() - freshest < SYNC_AFTER) return;
        autoSynced.current = true;
        setLinking("Syncing…");
        const out = await callPlaid("sync");
        if (!alive) return;
        // A sync already asked each bank for its accounts, so the fresher
        // numbers come back with it — free, and one round trip sooner.
        if (out.balances?.length) setBalances({ accounts: out.balances });
        if (out.added || out.removed) { refetch(); setReceipt({ n: out.added || 0, skipped: 0, synced: true }); }
        callPlaid("status").then((s2) => alive && setBanks(s2)).catch(() => {});
      } catch { /* silent — see above */ }
      finally { if (alive) setLinking(null); }
    })();
    return () => { alive = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setLinkErr(null);
    try {
      const out = await connectBank({ onEvent: setLinking });
      setLinking(null);
      if (out) {
        setReceipt({ n: out.added || 0, skipped: 0, bank: out.institution });
        if (out.balances?.length) setBalances({ accounts: out.balances });
        refetch(); refreshBanks();
      }
    } catch (e) {
      setLinking(null);
      // A closed Link sheet resolves to null rather than an error — changing
      // your mind is not a failure and must not paint the screen red.
      if (e) setLinkErr(e.message || "Couldn't connect that bank.");
    }
  };

  const syncNow = async () => {
    setLinkErr(null); setLinking("Syncing…");
    try {
      const out = await callPlaid("sync");
      setReceipt({ n: out.added || 0, skipped: 0, synced: true });
      if (out.balances?.length) setBalances({ accounts: out.balances });
      refetch(); refreshBanks();
    } catch (e) { setLinkErr(e.message || "Sync failed."); }
    finally { setLinking(null); }
  };

  const dropAccount = async (name) => {
    const n = all.filter((t) => t.account === name).length;
    const ok = await confirm({
      title: `Forget ${name}?`,
      message: `Removes the ${n} transaction${n === 1 ? "" : "s"} imported under that name. Nothing at Chase changes — you can re-import the same export and get them back.`,
      confirmLabel: "Forget", destructive: true,
    });
    if (ok) forget.mutate(name);
  };

  // ── the table isn't there yet ──────────────────────────────────────────────
  if (needsSetup) {
    return (
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="t-head">One-time setup</span>
        <p className="t-cap" style={{ color: "var(--sub)", lineHeight: 1.5, margin: 0 }}>
          Finances needs a table to keep transactions in. Paste this into the Supabase SQL editor and run
          it once — it's safe to run again, and it creates the table in the <b>boardroom</b> schema, which
          is the one this app reads.
        </p>
        <pre style={{
          margin: 0, padding: 12, borderRadius: 12, background: "var(--surface-2)", overflowX: "auto",
          font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", color: "var(--sub)",
        }}>{SETUP_SQL}</pre>
        <div style={{ display: "flex", gap: 8 }}>
          <Button kind="tinted" size="md" onClick={() => {
            navigator.clipboard?.writeText(SETUP_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
          }}>{copied ? "Copied" : "Copy SQL"}</Button>
          <Button kind="quiet" size="md" onClick={() => refetch()}>I've run it</Button>
        </div>
      </Card>
    );
  }

  // ── nothing imported yet ───────────────────────────────────────────────────
  // THE FIRST SCREEN HAS TO OFFER THE CONNECTION. This early-returned with only
  // "Import from Chase" on it, while Connect a bank sat in the Accounts card at
  // the bottom of the FULL page — which you cannot reach until you already have
  // transactions. So the one path that ends manual work was unreachable until
  // you had done the manual work. Connecting is the primary action here now, and
  // the CSV is the alternative rather than the only door.
  if (rows !== null && all.length === 0) {
    return (
      <>
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <EmptyState icon={<IcFinances size={26} />} title="Connect your bank"
            sub="Chase connects through Plaid and syncs on its own — nothing to export, nothing to remember. You can import a CSV instead if you'd rather, or to backfill years of history a live feed won't give you."
            action={
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                <Button kind="primary" size="md" onClick={connect} disabled={!!linking}>
                  {linking || "Connect a bank"}
                </Button>
                <Button kind="plain" size="sm" onClick={() => setImporting(true)}>Import a CSV instead</Button>
              </div>
            }
            style={{ padding: "26px 12px" }} />

          {/* The same error surface as the Accounts card — without it, a failure
              on the very first screen would have nowhere to appear. */}
          {linkErrorBlock}
        </Card>
        {importing && <ImportSheet onClose={() => setImporting(false)}
          onDone={(n, r) => { setImporting(false); setReceipt({ n, skipped: r.skipped.length }); }} />}
      </>
    );
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      {loadErr && (
        <Card pad="md" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="t-cap" style={{ color: "var(--red)", flex: 1 }}>{loadErr}</span>
          <Button kind="tinted" size="sm" onClick={() => refetch()}>Retry</Button>
        </Card>
      )}

      {/* THE READ WAS CAPPED, so say so above everything computed from it. Amber,
          not red: nothing failed and nothing on this page is fabricated — but the
          month totals, the budget status and the recurring detector are all
          derived from this slice, and a budget you are under by 3,000 missing
          transactions is a budget you only think you are under. */}
      {txCapped && (
        <Card pad="md">
          <span className="t-cap" style={{ color: "var(--amber)" }}>
            Showing the newest {txCapped.limit.toLocaleString()} of {txCapped.total.toLocaleString()} transactions —
            every total on this page is computed over that slice, not your whole history.
          </span>
        </Card>
      )}

      {/* Only when a bank is connected — it renders nothing on a CSV-only
          install, because a CSV has no balance in it to show. */}
      <Balances data={balances} onRefresh={refreshBalances} busy={balancing} />

      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Which month. Newest first, because that's the one you came to look at. */}
        {months.length > 1 && (
          <PillRow options={months.map((m) => ({ key: m, label: monthLabel(m).replace(/ \d{4}$/, (y) => (m.slice(0, 4) === months[0].slice(0, 4) ? "" : y)) }))}
            value={activeMonth} onChange={(m) => { setMonth(m); setCatFilter(""); }} />
        )}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <span className="t-head">{monthLabel(activeMonth)}</span>
          <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{s.count} transaction{s.count === 1 ? "" : "s"}</span>
        </div>
        <Totals s={s} delta={prevMonth ? cmp.spentDelta : null} />
        {/* Transfers are stated rather than hidden. Money did move; it just
            wasn't spending, and a total that silently omits $1,200 invites the
            question this line answers. */}
        {s.transfers > 0 && (
          <div className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            {money(s.transfers, { centsShown: false })} moved between accounts (card payments and transfers) — not counted as spending.
          </div>
        )}
      </Card>

      <Segmented
        options={[{ key: "month", label: "Breakdown" }, { key: "budgets", label: "Budgets" }, { key: "recurring", label: "Recurring" }]}
        value={tab} onChange={setTab} />

      {tab === "month" && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ margin: "0 -8px" }}>
            <Breakdown categories={s.categories} spent={s.spent} active={catFilter} onPick={setCatFilter} />
          </div>
          {largest(s).length > 0 && !catFilter && (
            <div style={{ borderTop: "0.5px solid var(--line)", paddingTop: 10 }}>
              <span className="t-label">Biggest this month</span>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                {largest(s, 3).map((t) => (
                  <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span className="t-call" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.merchant || t.description}</span>
                    <span className="t-call t-num" style={{ fontWeight: 600 }}>{money(-t.amount, { centsShown: false })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === "budgets" && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span className="t-label">Monthly budgets</span>
            {budgetView.overCount > 0 && (
              <span className="t-cap" style={{ color: "var(--red)" }}>{budgetView.overCount} over</span>
            )}
          </div>
          <div style={{ margin: "0 -8px" }}><Budgets status={budgetView} onEdit={(k) => {
            setBudgetFor(k);
            setBudgetDraft(budgets[k] ? String(budgets[k] / 100) : "");
          }} /></div>
          <p className="t-cap" style={{ color: "var(--faint)", margin: 0, lineHeight: 1.45 }}>
            Tap a category to set or clear its monthly limit. Budgets are per account and sync to every device.
          </p>
        </Card>
      )}

      {tab === "recurring" && (
        <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {subs.length === 0 ? (
            <EmptyState icon={<IcFinances size={24} />} title="Nothing recurring yet"
              sub="A charge has to appear in at least three separate months, at a steady amount, before it counts. Import a few more months and subscriptions surface on their own."
              style={{ padding: "18px 8px" }} />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="t-label">Recurring · {subs.length}</span>
                <span className="t-cap t-num" style={{ color: "var(--sub)" }}>
                  {money(subs.reduce((n, x) => n + x.typical, 0), { centsShown: false })}/mo
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {subs.map((x) => (
                  <div key={x.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "0.5px solid var(--line)" }}>
                    <Dot tone={catMeta(x.category).tone} size={6} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="t-call" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.merchant}</div>
                      <div className="t-cap" style={{ color: "var(--faint)" }}>{x.months} months · last {x.lastDate.slice(5).replace("-", "/")}</div>
                    </div>
                    <div style={{ textAlign: "right", flex: "none" }}>
                      <div className="t-call t-num" style={{ fontWeight: 600 }}>{money(x.typical)}</div>
                      <div className="t-cap t-num" style={{ color: "var(--faint)" }}>{money(x.yearly, { centsShown: false })}/yr</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* The ledger. Always present under whatever you're reading, because every
          number above eventually makes you ask "which ones?". */}
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Field value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this month" style={{ flex: 1, minWidth: 0 }} />
          {(catFilter || q) && <Button kind="quiet" size="md" onClick={() => { setCatFilter(""); setQ(""); }} style={{ flex: "none" }}>Clear</Button>}
        </div>
        {catFilter && (
          <div className="t-cap" style={{ color: "var(--sub)" }}>
            Showing {catMeta(catFilter).label} · {ledger.length} of {s.count}
          </div>
        )}
        <div style={{ margin: "0 -16px -10px" }}>
          {ledger.length === 0 ? (
            <div className="t-cap" style={{ color: "var(--faint)", textAlign: "center", padding: "18px 0" }}>Nothing matches.</div>
          ) : ledger.map((t) => <TxRow key={t.id} t={t} onCat={setCatFor} />)}
        </div>
      </Card>

      {/* Accounts and importing, at the bottom — you set this up rarely and read
          the numbers daily, so the machinery goes where it doesn't compete. */}
      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="t-label" style={{ flex: 1 }}>Accounts</span>
          <Button kind="quiet" size="sm" onClick={() => setImporting(true)}>Import CSV</Button>
          <Button kind="tinted" size="sm" onClick={connect} disabled={!!linking}>
            {linking || "Connect a bank"}
          </Button>
        </div>

        {/* Connected banks. Only rendered once you've asked — see refreshBanks. */}
        {banks === null ? (
          <Button kind="plain" size="sm" onClick={refreshBanks} style={{ alignSelf: "flex-start", paddingLeft: 0 }}>
            Show connected banks
          </Button>
        ) : banks.unavailable ? (
          <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            Plaid isn't configured yet — CSV import still works.
          </span>
        ) : banks.items?.length ? (
          <>
            {banks.items.map((b) => (
              <div key={b.item_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Dot tone="var(--green)" size={6} />
                <span className="t-call" style={{ flex: 1, minWidth: 0 }}>{b.institution}</span>
                <span className="t-cap" style={{ color: "var(--faint)" }}>
                  {b.synced_at ? `synced ${b.synced_at.slice(5, 10).replace("-", "/")}` : "never synced"}
                </span>
                <Button kind="plain" size="sm" style={{ paddingRight: 0 }}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Disconnect ${b.institution}?`,
                      message: "Stops the sync and tells Plaid to drop the connection. Transactions already imported stay — remove them separately if you want them gone.",
                      confirmLabel: "Disconnect", destructive: true,
                    });
                    if (ok) { await callPlaid("disconnect", { item_id: b.item_id }).catch(() => {}); refreshBanks(); }
                  }}>Disconnect</Button>
              </div>
            ))}
            <Button kind="quiet" size="sm" onClick={syncNow} disabled={!!linking} style={{ alignSelf: "flex-start" }}>
              {linking === "Syncing…" ? "Syncing…" : "Sync now"}
            </Button>
          </>
        ) : (
          <span className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.45 }}>
            No bank connected. Connecting one replaces the monthly CSV export with an automatic sync.
          </span>
        )}

        {linkErrorBlock}
        {accounts.length === 0 ? (
          <span className="t-cap" style={{ color: "var(--faint)" }}>Nothing imported under a name yet.</span>
        ) : accounts.map((a) => (
          <div key={a} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="t-call" style={{ flex: 1, minWidth: 0 }}>{a}</span>
            <span className="t-cap t-num" style={{ color: "var(--faint)" }}>{all.filter((t) => t.account === a).length}</span>
            <Button kind="plain" size="sm" onClick={() => dropAccount(a)} style={{ paddingRight: 0 }}>Forget</Button>
          </div>
        ))}
        {receipt && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)", borderRadius: 12, padding: "9px 12px" }}>
            <span className="t-cap" style={{ color: "var(--sub)", flex: 1 }}>
              {receipt.synced ? "Synced" : "Imported"} {receipt.n} transaction{receipt.n === 1 ? "" : "s"}
              {receipt.bank ? ` from ${receipt.bank}` : ""}
              {receipt.skipped ? ` · ${receipt.skipped} line${receipt.skipped === 1 ? "" : "s"} skipped` : ""}
            </span>
            <Button kind="plain" size="sm" onClick={() => setReceipt(null)}>Dismiss</Button>
          </div>
        )}
      </Card>

      {importing && <ImportSheet onClose={() => setImporting(false)}
        onDone={(n, r) => { setImporting(false); setReceipt({ n, skipped: r.skipped.length }); }} />}

      {/* Recategorising. A sheet rather than an inline picker: twelve options
          don't fit beside a row, and this is a deliberate correction. */}
      {catFor && (() => {
        const mk = merchantKey(catFor.description);
        const reach = ruleReach(all, mk);
        return (
          <Sheet onClose={() => setCatFor(null)} title={catFor.merchant || catFor.description}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CATEGORIES.map((c) => (
                <Pill key={c.key} active={catFor.category === c.key}
                  onClick={() => {
                    // A RULE by default, not a one-row edit. With a live sync the
                    // same merchants come back every month, and a per-row fix
                    // means recategorising the same coffee shop forever.
                    if (onlyThis) setCat.mutate({ id: catFor.id, category: c.key });
                    else updateSetting?.("finance_rules", applyRule(rules, mk, c.key));
                    setCatFor(null); setOnlyThis(false);
                  }}>
                  {c.label}
                </Pill>
              ))}
            </div>
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span className="t-cap" style={{ color: "var(--sub)", flex: 1, lineHeight: 1.45 }}>
                {onlyThis
                  ? "Just this one transaction."
                  : reach > 1
                    ? `Applies to all ${reach} charges from this merchant, past and future.`
                    : "Applies to this merchant, including future charges."}
              </span>
              <Button kind="quiet" size="sm" onClick={() => setOnlyThis((v) => !v)} style={{ flex: "none" }}>
                {onlyThis ? "Whole merchant" : "Just this one"}
              </Button>
            </div>
            {rules[mk] && !onlyThis && (
              <Button kind="plain" size="sm" style={{ marginTop: 6, paddingLeft: 0 }}
                onClick={() => { updateSetting?.("finance_rules", applyRule(rules, mk, "")); setCatFor(null); }}>
                Clear the rule for this merchant
              </Button>
            )}
          </Sheet>
        );
      })()}

      {budgetFor && (
        <Sheet onClose={() => setBudgetFor(null)} title={`${catMeta(budgetFor).label} budget`}
          footer={
            <>
              <Button kind="quiet" size="md" onClick={() => setBudgetFor(null)} style={{ flex: 1 }}>Cancel</Button>
              <Button kind="primary" size="md" onClick={saveBudget} style={{ flex: 1 }}>Save</Button>
            </>
          }>
          <Field value={budgetDraft} onChange={(e) => setBudgetDraft(e.target.value)} autoFocus
            inputMode="decimal" placeholder="Monthly limit — e.g. 400"
            onKeyDown={(e) => { if (e.key === "Enter") saveBudget(); }} />
          <p className="t-cap" style={{ color: "var(--faint)", marginTop: 10, lineHeight: 1.45 }}>
            Leave it empty to remove the budget. You spent {money(budgetView.rows.find((r) => r.key === budgetFor)?.spent || 0)} here in {monthLabel(activeMonth)}.
          </p>
        </Sheet>
      )}
      {confirmEl}
    </section>
  );
}

export default FinancesPanel;
