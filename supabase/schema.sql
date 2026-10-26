-- Mouse Racer: database setup.
-- Paste all of this into Supabase → SQL Editor → New query, and click Run (once).
--
-- What's stored:
--   profiles  one row per player account: the name shown in races (max 10 characters)
--   results   one row each time a player finishes an online practice, qualifying or race
--   leaderboard  a view: per player, best lap (at standard settings), races, wins, podiums
--
-- Who can read and write: only the game server (it uses the secret key). Players never
-- talk to these tables directly; they see their data through the server. That's why
-- row level security is on and there are no policies.
-- Deleting a player (Authentication → Users, or the "Delete account" button in the
-- game) removes their profile and results too.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.results (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null check (mode in ('practice', 'quali', 'race')),
  position int,              -- finishing position (race) / position when you finished (practice, qualifying)
  field_size int,            -- how many players were in the session
  best_lap_ms int,           -- best lap that counted (qualifying: timed laps only); null if none
  race_time_ms int,          -- race: time from the start to the finish
  laps int,
  pace real, grip real, engine real,   -- the room's settings (lap times only compare at the same settings)
  created_at timestamptz not null default now()
);
create index if not exists results_user_idx on public.results (user_id);
create index if not exists results_lap_idx on public.results (best_lap_ms) where best_lap_ms is not null;

alter table public.profiles enable row level security;
alter table public.results enable row level security;

-- Best lap counts only at the standard settings (100% pace, normal grip and acceleration),
-- so everyone's times are comparable. Wins and podiums need at least 2 players.
create or replace view public.leaderboard with (security_invoker = true) as
select
  p.name,
  min(r.best_lap_ms) filter (where r.best_lap_ms > 0 and r.pace = 1 and r.grip = 1 and r.engine = 1) as best_lap_ms,
  count(*) filter (where r.mode = 'race') as races,
  count(*) filter (where r.mode = 'race' and r.position = 1 and r.field_size > 1) as wins,
  count(*) filter (where r.mode = 'race' and r.position <= 3 and r.field_size > 1) as podiums
from public.profiles p
join public.results r on r.user_id = p.id
group by p.id, p.name;
