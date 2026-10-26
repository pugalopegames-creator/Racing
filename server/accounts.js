// Player accounts on the server: checks sign-ins with Supabase, keeps profile names,
// saves online results and serves the leaderboard. Talks to Supabase's web API
// directly (no extra packages).
//
// Settings (Render → your service → Environment):
//   SUPABASE_URL                 https://<project>.supabase.co
//   SUPABASE_ANON_KEY            the publishable key (sb_publishable_…)
//   SUPABASE_SERVICE_ROLE_KEY    the secret key (sb_secret_… or the legacy service_role key)
// Without them the server runs exactly as before, just without accounts.

const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const PUBLISHABLE = process.env.SUPABASE_ANON_KEY || '';
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const accountsEnabled = !!(URL && PUBLISHABLE && SECRET);

// New-style secret keys go in the apikey header only; legacy service_role keys are JWTs
// and also go in Authorization.
const adminHeaders = () => ({
  apikey: SECRET, 'Content-Type': 'application/json',
  ...(SECRET.startsWith('eyJ') ? { Authorization: `Bearer ${SECRET}` } : {}),
});

async function call(path, { method = 'GET', headers, body, prefer } = {}) {
  const res = await fetch(URL + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

/** Who does this access token belong to? { id, guest, email, googleName } (throws if invalid) */
export async function verifyUser(token) {
  const u = await call('/auth/v1/user', { headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${token}` } });
  const meta = u.user_metadata || {};
  return { id: u.id, guest: !!u.is_anonymous, email: u.email || '', googleName: meta.full_name || meta.name || '' };
}

const enc = encodeURIComponent;
export async function getProfile(id) {
  const rows = await call(`/rest/v1/profiles?id=eq.${enc(id)}&select=name`, { headers: adminHeaders() });
  return rows && rows[0] ? rows[0] : null;
}
export async function createProfile(id, name) {
  await call('/rest/v1/profiles', { method: 'POST', headers: adminHeaders(), body: { id, name }, prefer: 'resolution=ignore-duplicates,return=minimal' });
}
export async function renameProfile(id, name) {
  await call(`/rest/v1/profiles?id=eq.${enc(id)}`, { method: 'PATCH', headers: adminHeaders(), body: { name, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
}
export async function saveResult(row) {
  await call('/rest/v1/results', { method: 'POST', headers: adminHeaders(), body: row, prefer: 'return=minimal' });
}
export async function deleteUser(id) {
  await call(`/auth/v1/admin/users/${enc(id)}`, { method: 'DELETE', headers: adminHeaders() });
}

// leaderboard: most wins, and fastest laps; cached for 15 s
let lbCache = null, lbAt = 0;
export async function leaderboard() {
  if (lbCache && Date.now() - lbAt < 15000) return lbCache;
  const sel = 'select=name,best_lap_ms,races,wins,podiums';
  const [wins, laps] = await Promise.all([
    call(`/rest/v1/leaderboard?${sel}&races=gt.0&order=wins.desc,podiums.desc,races.desc&limit=20`, { headers: adminHeaders() }),
    call(`/rest/v1/leaderboard?${sel}&best_lap_ms=not.is.null&order=best_lap_ms.asc&limit=20`, { headers: adminHeaders() }),
  ]);
  lbCache = { wins, laps }; lbAt = Date.now();
  return lbCache;
}
export function invalidateLeaderboard() { lbCache = null; }
