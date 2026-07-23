import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
// Board Room's own tables now live in the `boardroom` schema of the shared
// Pentagon Supabase project (the same project Clarify/ZTS/Runway use). All of
// this client's .from() reads/writes target that schema; auth is unaffected.
// (ZTS/Clarify cross-tool reads go through their own functions + env vars.)
export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { db: { schema: "boardroom" } })
  : null;

export const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
