// ─── Daily Plan — how the day is meant to go, written once ────────────────────
// Two templates, Weekdays and Weekends, each a run of time blocks and a short
// list of guardrails. Nothing is set per day: the tab opens on whichever
// template today is, and the Now card works out where in it you should be. See
// features/plan/planLogic.js for the shape and why it lives in app_settings.
//
// THE PAGE IS FOR SETTING IT AND CHECKING IT, IN THAT ORDER OF RARITY. Setting it
// happens a handful of times; checking it happens every morning. So the top of
// the page is the check (Now, the work day, the guardrails) and the editing is
// one tap on the row you want to change — no edit mode, no reorder handles.
// Blocks sort themselves by time, which is the only order a day has.
//
// Writes go out whole through updateSetting, like every other setting, so a
// failed save lands in the top bar's unsaved chip with its Retry rather than in
// a second error surface invented here.
import { useMemo, useRef, useState, useEffect } from "react";
import { Card, SectionHeader, CellGroup, Cell, Button, Segmented, Field, TextArea, SwitchRow, Sheet, useConfirm, closeSheet } from "../../ui/kit.jsx";
import { usePlanClock } from "../../features/plan/usePlanClock.js";
import { PlanNow, splitTime } from "../../features/plan/PlanNow.jsx";
import {
  PLAN_SETTING, DAY_TYPES, KINDS, kindMeta, normalizePlan, planIsEmpty, dayTypeOf, whereAmI, workWindow,
  withSpans, upsertBlock, removeBlock, upsertRule, removeRule, restoreRule, copyDay, blockProblem,
  parseHM, toHM, fmtTime, fmtDur, STARTER, MAX_TITLE, MAX_NOTE, MAX_RULE,
} from "../../features/plan/planLogic.js";

// A full-width row button that wears the kit's .cell anatomy (same as Creed's).
const rowBtn = { background: "none", border: 0, margin: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", width: "100%" };
const diamond = (size, color) => ({ width: size, height: size, flex: "none", transform: "rotate(45deg)", borderRadius: 1.5, background: color });
const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const otherType = (t) => (t === "weekday" ? "weekend" : "weekday");
const typeMeta = (t) => DAY_TYPES.find((d) => d.key === t);

export function PlanPage({ isMobile, settings, updateSetting }) {
  const loaded = settings != null;
  const stored = settings?.[PLAN_SETTING];
  const plan = useMemo(() => normalizePlan(stored), [stored]);
  // The undo after a delete has to apply to the plan as it is WHEN Undo is
  // tapped, not as it was when the toast went up — anything saved in between
  // would otherwise be written over by the stale copy the closure captured.
  const planRef = useRef(plan);
  planRef.current = plan;

  const now = usePlanClock();
  const todayType = dayTypeOf(now);
  const [type, setType] = useState(todayType);
  // Follow the day across midnight Friday→Saturday while the tab sits open, but
  // only if he hasn't chosen to look at the other template himself.
  const chose = useRef(false);
  useEffect(() => { if (!chose.current) setType(todayType); }, [todayType]);

  const day = plan[type];
  const isToday = type === todayType;
  const where = useMemo(() => whereAmI(plan, now), [plan, now]);
  const work = useMemo(() => workWindow(day.blocks), [day]);
  const spans = useMemo(() => withSpans(day.blocks), [day]);
  const currentId = isToday && where.current && !where.current.carried ? where.current.id : null;

  const [blockForm, setBlockForm] = useState(null); // { id, start, title, note, kind, protected, isNew }
  const [ruleForm, setRuleForm] = useState(null);   // { id, text, isNew }
  const [formErr, setFormErr] = useState(null);
  const blockClose = useRef(null);
  const ruleClose = useRef(null);
  const [confirmEl, confirm] = useConfirm();

  // ─── undo ───
  // Deletes are one tap with an Undo after, not a confirm before: a block is a
  // line in a template, cheap to put back, and a confirm on every removal is a
  // tax on the one session where you're reshaping the whole day.
  const [toast, setToast] = useState(null); // { label, undo }
  const toastTimer = useRef(null);
  const showToast = (t) => { clearTimeout(toastTimer.current); setToast(t); toastTimer.current = setTimeout(() => setToast(null), 6000); };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const runUndo = () => { const t = toast; setToast(null); clearTimeout(toastTimer.current); t?.undo?.(); };

  const save = (next) => updateSetting(PLAN_SETTING, next);

  const pickType = (t) => { chose.current = t !== todayType; setType(t); };

  // ─── blocks ───
  const openNewBlock = () => {
    setFormErr(null);
    // Default the time to an hour after the last block, which is where the next
    // one usually goes when a day is being written top to bottom.
    const last = day.blocks[day.blocks.length - 1];
    const guess = last ? parseHM(last.start) + 60 : 7 * 60;
    setBlockForm({ id: newId(), start: guess < 1440 ? toHM(guess) : "", title: "", note: "", kind: "work", protected: false, isNew: true });
  };
  const openBlock = (b) => { setFormErr(null); setBlockForm({ ...b, isNew: false }); };
  const saveBlock = () => {
    const problem = blockProblem(day, blockForm);
    if (problem) { setFormErr(problem); return; }
    const { isNew, ...block } = blockForm;
    save(upsertBlock(plan, type, block));
    closeSheet(blockClose, () => setBlockForm(null));
  };
  const deleteBlock = () => {
    const gone = day.blocks.find((b) => b.id === blockForm.id);
    const t = type;
    save(removeBlock(plan, t, blockForm.id));
    closeSheet(blockClose, () => setBlockForm(null));
    if (gone) showToast({ label: `${gone.title} removed`, undo: () => save(upsertBlock(planRef.current, t, gone)) });
  };

  // ─── guardrails ───
  const openNewRule = () => { setFormErr(null); setRuleForm({ id: newId(), text: "", isNew: true }); };
  const openRule = (r) => { setFormErr(null); setRuleForm({ ...r, isNew: false }); };
  const saveRule = () => {
    if (!ruleForm.text.trim()) { setFormErr("Write the line first."); return; }
    save(upsertRule(plan, type, { id: ruleForm.id, text: ruleForm.text }));
    closeSheet(ruleClose, () => setRuleForm(null));
  };
  const deleteRule = () => {
    const at = day.rules.findIndex((r) => r.id === ruleForm.id);
    const gone = day.rules[at];
    const t = type;
    save(removeRule(plan, t, ruleForm.id));
    closeSheet(ruleClose, () => setRuleForm(null));
    if (gone) showToast({ label: "Guardrail removed", undo: () => save(restoreRule(planRef.current, t, gone, at)) });
  };

  // ─── whole templates ───
  const adoptStarter = () => {
    // Only ever offered on an empty plan, but the check is here too: a second
    // device could have saved one since this screen loaded, and the starter must
    // never land on top of a plan he wrote.
    if (!planIsEmpty(plan)) return;
    save(normalizePlan(STARTER));
  };
  const copyFromOther = async () => {
    const from = otherType(type);
    if (day.blocks.length || day.rules.length) {
      const ok = await confirm({
        title: `Replace your ${typeMeta(type).label.toLowerCase()} plan?`,
        message: `It becomes a copy of ${typeMeta(from).label.toLowerCase()} — every block and guardrail. You can edit it from there.`,
        confirmLabel: "Replace", destructive: true,
      });
      if (!ok) return;
    }
    const before = planRef.current[type];
    save(copyDay(plan, from, type));
    showToast({ label: `Copied ${typeMeta(from).label.toLowerCase()}`, undo: () => save({ ...planRef.current, [type]: before }) });
  };

  const segOptions = DAY_TYPES.map((d) => ({ key: d.key, label: d.label, sub: d.key === todayType ? "Today" : d.days }));
  const wrap = { width: "100%", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12, minWidth: 0, padding: isMobile ? "0 16px" : 0 };

  // ─── not loaded: say what it's waiting for, draw nothing it could save ───
  // A null settings object reads exactly like "no plan yet", and that state's
  // first button writes the starter — over a plan that is really there and just
  // hasn't arrived. So until it arrives there is nothing here to press.
  if (!loaded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
        <div style={wrap} aria-busy="true">
          <div className="sk" style={{ height: 44, borderRadius: 10 }} />
          <div className="sk sk-card" style={{ height: 150 }} />
          <div className="sk sk-card" style={{ height: 220 }} />
          <span className="t-cap" style={{ color: "var(--faint)", padding: "0 4px" }}>
            Waiting for your saved plan. Editing opens once it has loaded.
          </span>
        </div>
      </div>
    );
  }

  const empty = planIsEmpty(plan);
  const otherHas = plan[otherType(type)].blocks.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: isMobile ? "4px 0 24px" : "6px 0 40px" }}>
      <div style={wrap}>
        {empty ? (
          <FirstRun onStarter={adoptStarter} onBlank={() => { pickType(todayType); openNewBlock(); }} />
        ) : (
          <>
            <Segmented options={segOptions} value={type} onChange={pickType} style={{ flex: "none" }} />

            {/* key={type} restarts the fade when the template switches. */}
            <div key={type} className="pagefade" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
              {/* ── the check: where you should be ── */}
              {isToday && (where.current || where.next) && (
                <Card pad={isMobile ? "md" : "lg"}>
                  <PlanNow where={where} />
                </Card>
              )}

              {!day.blocks.length ? (
                <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <span className="t-head">No {typeMeta(type).short.toLowerCase()} plan yet</span>
                  <span className="t-foot" style={{ lineHeight: 1.6 }}>
                    {typeMeta(type).label} are {typeMeta(type).days}.{" "}
                    {otherHas ? `Start from your ${typeMeta(otherType(type)).label.toLowerCase()} and change what's different, or build it a block at a time.` : "Build it a block at a time."}
                  </span>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {otherHas && <Button kind="primary" size="md" onClick={copyFromOther}>Copy {typeMeta(otherType(type)).label.toLowerCase()}</Button>}
                    <Button kind={otherHas ? "quiet" : "primary"} size="md" onClick={openNewBlock}>Add a block</Button>
                  </div>
                </Card>
              ) : (
                <>
                  {/* ── the work day, in numbers ── */}
                  {work && (
                    <CellGroup>
                      <Cell
                        title="Work day"
                        sub={work.open
                          ? "Your last work block runs into the night — add a stop after it."
                          : `${fmtDur(work.minutes)} in work blocks`}
                        value={work.open ? `from ${fmtTime(work.start)}` : `${fmtTime(work.start)} – ${fmtTime(work.end)}`}
                      />
                    </CellGroup>
                  )}

                  {/* ── guardrails ── */}
                  <div>
                    <SectionHeader title="Guardrails" trailing={day.rules.length ? "Add" : null} onTrailing={day.rules.length ? openNewRule : undefined} />
                    {day.rules.length ? (
                      <CellGroup>
                        {day.rules.map((r) => (
                          <button key={r.id} className="cell tappable" onClick={() => openRule(r)} style={{ ...rowBtn, alignItems: "flex-start" }}>
                            <span aria-hidden style={{ ...diamond(7, "var(--sub)"), marginTop: 7 }} />
                            <span className="t-call" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>{r.text}</span>
                          </button>
                        ))}
                      </CellGroup>
                    ) : (
                      <Card pad="md" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <span className="t-foot" style={{ lineHeight: 1.6 }}>
                          The lines you'd want to hear at 7am when you're about to open the laptop early. They show on the Brief with the plan.
                        </span>
                        <div><Button kind="tinted" size="sm" onClick={openNewRule}>Add a guardrail</Button></div>
                      </Card>
                    )}
                  </div>

                  {/* ── the day, in order ── */}
                  <div>
                    <SectionHeader title="The day" trailing={typeMeta(type).days} />
                    <CellGroup>
                      {spans.map((b, i) => {
                        const k = kindMeta(b.kind);
                        const [hm, mer] = splitTime(b.startMin);
                        const isNow = b.id === currentId;
                        const last = i === spans.length - 1;
                        // "Protected" rides in the sub line, not as a trailing label: on a
                        // 320pt phone a trailing word plus "Now" left the title four letters.
                        const sub = [last ? "overnight" : fmtDur(b.minutes), b.protected ? "Protected" : null, b.note].filter(Boolean).join(" · ");
                        return (
                          <button key={b.id} className="cell tappable" onClick={() => openBlock(b)}
                            aria-current={isNow ? "time" : undefined}
                            style={{ ...rowBtn, background: isNow ? "var(--accent-a08)" : undefined }}>
                            <span className="t-num" style={{ width: 62, flex: "none", display: "inline-flex", alignItems: "baseline", gap: 3 }}>
                              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>{hm}</span>
                              <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--faint)" }}>{mer}</span>
                            </span>
                            <span aria-hidden style={diamond(7, k.tone)} />
                            <span className="cell-body">
                              {/* Two lines before an ellipsis — a block's name is the thing
                                  you read, and "Hard stop — laptop c…" hides the half that matters. */}
                              <span className="cell-title" style={{ whiteSpace: "normal", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3 }}>{b.title}</span>
                              <span className="cell-sub">{sub}</span>
                            </span>
                            {isNow && <span className="t-cap" style={{ color: "var(--ink)", fontWeight: 600, flex: "none" }}>Now</span>}
                          </button>
                        );
                      })}
                    </CellGroup>
                  </div>
                  <Button kind="tinted" size="md" full onClick={openNewBlock}>Add a block</Button>
                  {otherHas && (
                    // Sub-toned, not gold: it is a rare, whole-template action, and
                    // DESIGN.md §1.4 keeps the accent for the active and the primary.
                    <Button kind="plain" size="sm" onClick={copyFromOther} style={{ alignSelf: "center", color: "var(--sub)" }}>
                      Replace with a copy of {typeMeta(otherType(type)).label.toLowerCase()}
                    </Button>
                  )}
                </>
              )}
              <span className="t-cap" style={{ color: "var(--faint)", textAlign: "center", lineHeight: 1.5, padding: "0 12px" }}>
                Set once. The plan follows the day — weekdays Monday to Friday, weekends Saturday and Sunday.
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── a block ── */}
      {blockForm && (
        <Sheet closeRef={blockClose} onClose={() => setBlockForm(null)} title={blockForm.isNew ? "New block" : "Edit block"}
          footer={
            <>
              {!blockForm.isNew && <Button kind="danger" size="lg" onClick={deleteBlock}>Delete</Button>}
              <Button kind="primary" size="lg" onClick={saveBlock} style={{ flex: 1 }}>{blockForm.isNew ? "Add it" : "Save"}</Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            <span className="t-cap" style={{ color: "var(--faint)" }}>
              {typeMeta(type).label} · runs until the next block starts
            </span>
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <Field type="time" value={blockForm.start} aria-label="Starts at"
                onChange={(e) => setBlockForm((f) => ({ ...f, start: e.target.value }))}
                style={{ width: 150, flex: "none" }} />
              <Field value={blockForm.title} placeholder="What happens — “Workout”" aria-label="Name" maxLength={MAX_TITLE}
                autoFocus={blockForm.isNew}
                onChange={(e) => setBlockForm((f) => ({ ...f, title: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveBlock(); } }}
                style={{ flex: 1, minWidth: 0 }} />
            </div>
            <Segmented options={KINDS.map((k) => ({ key: k.key, label: k.label }))} value={blockForm.kind}
              onChange={(kind) => setBlockForm((f) => ({ ...f, kind }))} />
            <TextArea value={blockForm.note} rows={2} maxLength={MAX_NOTE} aria-label="Note"
              placeholder="A line to read when you get here (optional)"
              onChange={(e) => setBlockForm((f) => ({ ...f, note: e.target.value }))}
              style={{ lineHeight: 1.5, resize: "vertical" }} />
            <CellGroup style={{ boxShadow: "none", background: "var(--surface-2)" }}>
              <SwitchRow title="Protected" sub="Non-negotiable — the Brief says so"
                on={blockForm.protected} onToggle={() => setBlockForm((f) => ({ ...f, protected: !f.protected }))} />
            </CellGroup>
            {formErr && <div className="t-foot" style={{ color: "var(--red)" }}>{formErr}</div>}
          </div>
        </Sheet>
      )}

      {/* ── a guardrail ── */}
      {ruleForm && (
        <Sheet closeRef={ruleClose} onClose={() => setRuleForm(null)} title={ruleForm.isNew ? "New guardrail" : "Edit guardrail"}
          footer={
            <>
              {!ruleForm.isNew && <Button kind="danger" size="lg" onClick={deleteRule}>Delete</Button>}
              <Button kind="primary" size="lg" onClick={saveRule} style={{ flex: 1 }}>{ruleForm.isNew ? "Add it" : "Save"}</Button>
            </>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
            <span className="t-cap" style={{ color: "var(--faint)" }}>
              {typeMeta(type).label} · one line, in your own words
            </span>
            <TextArea value={ruleForm.text} rows={3} maxLength={MAX_RULE} autoFocus aria-label="Guardrail"
              placeholder="“Laptop stays closed until 8:30.”"
              onChange={(e) => setRuleForm((f) => ({ ...f, text: e.target.value }))}
              style={{ lineHeight: 1.6, resize: "vertical" }} />
            {formErr && <div className="t-foot" style={{ color: "var(--red)" }}>{formErr}</div>}
          </div>
        </Sheet>
      )}

      {toast && (
        <div className="toasts">
          <div className="toast">
            <span>{toast.label}</span>
            <button onClick={runUndo} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", padding: "6px 4px", margin: "-6px 0" }}>Undo</button>
          </div>
        </div>
      )}
      {confirmEl}
    </div>
  );
}

// The first visit. Both templates are empty, and the job of this card is to get
// a whole day on screen in one tap — a plan you have to build from nothing on the
// evening you decide you need one doesn't get built.
function FirstRun({ onStarter, onBlank }) {
  return (
    <Card pad="lg" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
      <span aria-hidden style={{ ...diamond(12, "var(--accent)"), marginBottom: 6, animation: "breathe 4s ease-in-out infinite" }} />
      <span className="t-title2" style={{ textWrap: "balance" }}>Decide how the day goes — once.</span>
      <span className="t-foot" style={{ lineHeight: 1.65 }}>
        A weekday plan and a weekend plan: when you're up, when you move, when work starts and when it stops. You set them here
        once; every morning the Brief tells you where you should be, so a day that feels behind doesn't get to rewrite itself at 7am.
      </span>
      <span className="t-foot" style={{ lineHeight: 1.65 }}>
        The suggested day puts the workout before the laptop, starts work at 8:30 and stops it at 5:30. Change any of it.
      </span>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
        <Button kind="primary" size="md" onClick={onStarter}>Start from a suggested day</Button>
        <Button kind="quiet" size="md" onClick={onBlank}>Start blank</Button>
      </div>
    </Card>
  );
}

export default PlanPage;
