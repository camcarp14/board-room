-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 · boardroom.transactions — the ledger, keyed by its own contents
--
-- Copied from SETUP_SQL in src/features/finances/financeLogic.js, which is
-- already boardroom-qualified, already indexed and already granted. The comment
-- above it in that file is where this whole directory's schema rule is recorded.
--
-- THE PRIMARY KEY IS (user_id, id) AND id IS TEXT, NOT A UUID. A Chase CSV
-- carries no transaction id, so financeLogic.txKey DERIVES one from the
-- transaction itself. That is the only thing making an import idempotent:
-- upserting on (user_id, id) means re-importing an overlapping export updates
-- rows instead of doubling your month. Change the key derivation and you have
-- silently doubled every overlapping import from then on.
--
-- amount_cents is a bigint of CENTS. Never a float — a budget that drifts by
-- rounding is a budget that lies, quietly, in the direction of whichever way the
-- error accumulates.
--
-- category vs category_override: `category` is what the rules assigned,
-- `category_override` is what you said instead, and the override is nullable
-- because absent is a meaningful state. summarise() resolves the pair once and
-- everything downstream reads the resolved value — see the warning on
-- financeLogic.largest, which must NOT re-resolve or it ignores a rule.
--
-- plaid.js writes here too, through PostgREST with the service role, on the same
-- conflict target.
--
-- db.saveTransactions chunks at 500 rows: a 3,000-row export in one statement is
-- a request big enough for PostgREST to reject, and that failure looked exactly
-- like "the import did nothing".
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists boardroom.transactions (
  id                text        not null,
  user_id           uuid        not null references auth.users(id) on delete cascade,
  account           text        not null default '',
  date              date        not null,
  amount_cents      bigint      not null,
  description       text        not null default '',
  merchant          text        not null default '',
  category          text        not null default 'other',
  category_override text,
  created_at        timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists transactions_date_idx
  on boardroom.transactions (user_id, date desc);

alter table boardroom.transactions enable row level security;

-- The name matches financeLogic.js's setup card, so this is a no-op against
-- production rather than a second policy.
drop policy if exists "transactions own rows" on boardroom.transactions;
create policy "transactions own rows" on boardroom.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on boardroom.transactions to authenticated;
