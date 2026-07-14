// Upkeep due-status math — shared by the Upkeep panel and the Brief's Docket.
export function upkeepDue(item, now = new Date()) {
  if (!item.last_done) return { never: true, dueIn: 0 };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = String(item.last_done).slice(0, 10).split("-").map(Number);
  const due = new Date(y, m - 1, d + Number(item.interval_days || 0));
  return { never: false, dueIn: Math.round((due - today) / 86400000), due };
}
