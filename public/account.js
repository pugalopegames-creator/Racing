// Player accounts, through Supabase Auth (its web API directly, no library).
//
//   Guest       an account made on the spot (Supabase "anonymous sign-in"): no email,
//               no password, kept on this device. It can be upgraded to Google later
//               and keeps its results.
//   Google      "Sign in with Google" in a popup window, so the game keeps running.
//               Uses the PKCE flow: the popup only ever sees a one-time code, which
//               this page swaps for the session.
//
// The session (access + refresh token) is kept in this browser (localStorage) and
// refreshed before it expires. The game sends the access token to the game server,
// which checks it with Supabase and saves names and results for that account.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './account-config.js';

const KEY = 'mr-auth';
const base = () => SUPABASE_URL.replace(/\/+$/, '') + '/auth/v1';
const headers = (token) => ({ apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

let session = null;
try { session = JSON.parse(localStorage.getItem(KEY)) || null; } catch {}
const listeners = new Set();
function save(s) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
  for (const f of listeners) { try { f(account.user); } catch {} }
}
// what the API returns → what we keep
function fromResponse(r) {
  if (!r || !r.access_token) throw new Error((r && (r.error_description || r.msg || r.message)) || 'Sign-in failed');
  return {
    access_token: r.access_token, refresh_token: r.refresh_token,
    expires_at: Date.now() + (r.expires_in || 3600) * 1000,
    user: r.user ? describe(r.user) : null,
  };
}
function describe(u) {
  const meta = u.user_metadata || {};
  return {
    id: u.id,
    guest: !!u.is_anonymous,
    email: u.email || '',
    googleName: meta.full_name || meta.name || '',
  };
}
async function call(path, { method = 'POST', body, token } = {}) {
  const res = await fetch(base() + path, { method, headers: headers(token), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error((data && (data.error_description || data.msg || data.message || data.error)) || `Supabase said ${res.status}`);
  return data;
}

// --- PKCE helpers
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomVerifier() { const a = new Uint8Array(48); crypto.getRandomValues(a); return b64url(a); }
async function challengeOf(v) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))); }

// Open the popup straight away (inside the click, so it isn't blocked), then send it
// to Google; resolve with the one-time code the callback page passes back.
function popupFlow(getUrl) {
  return new Promise((resolve, reject) => {
    const w = window.open('', 'mr-auth', 'width=480,height=680');
    if (!w) { reject(new Error('The sign-in window was blocked. Allow pop-ups for this page and try again.')); return; }
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; removeEventListener('message', onMsg); clearInterval(watch); fn(v); };
    const onMsg = (e) => {
      const m = e.data;
      if (!m || m.type !== 'mr-auth') return;
      try { w.close(); } catch {}
      if (m.error) finish(reject, new Error(m.error)); else if (m.code) finish(resolve, m.code);
    };
    addEventListener('message', onMsg);
    const watch = setInterval(() => { if (w.closed) finish(reject, new Error('Sign-in window closed')); }, 500);
    Promise.resolve(getUrl()).then((url) => { if (!done) w.location.href = url; }).catch((err) => { try { w.close(); } catch {} finish(reject, err); });
  });
}

export const account = {
  /** Accounts need the project URL in account-config.js. */
  get configured() { return !!SUPABASE_URL; },
  /** { id, guest, email, googleName } or null */
  get user() { return session && session.user; },
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },

  async signInGuest() {
    save(fromResponse(await call('/signup', { body: { data: {} } })));
    return this.user;
  },

  /**
   * Sign in with Google (or, signed in as a guest, add Google to that account so it
   * keeps its name and results). callbackUrl: this game's auth-callback.html on the
   * game server; it must be listed under Supabase → Authentication → URL Configuration.
   */
  async signInGoogle(callbackUrl) {
    const verifier = randomVerifier();
    const linking = !!(session && session.user && session.user.guest);
    const code = await popupFlow(async () => {
      const ch = await challengeOf(verifier);
      const q = `provider=google&redirect_to=${encodeURIComponent(callbackUrl)}&code_challenge=${ch}&code_challenge_method=s256`;
      if (!linking) return `${base()}/authorize?${q}`;
      const token = await this.token();
      const r = await call(`/user/identities/authorize?${q}&skip_http_redirect=true`, { method: 'GET', token });
      return r.url;
    });
    save(fromResponse(await call('/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } })));
    if (!this.user) await this.refreshUser();
    return this.user;
  },

  async refreshUser() {
    if (!session) return null;
    const u = await call('/user', { method: 'GET', token: session.access_token });
    save({ ...session, user: describe(u) });
    return this.user;
  },

  /** A valid access token (refreshed if it's about to run out), or null if signed out. */
  async token() {
    if (!session) return null;
    if (Date.now() < session.expires_at - 60000) return session.access_token;
    try {
      const r = await call('/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
      save({ ...fromResponse(r), user: r.user ? describe(r.user) : session.user });
      return session.access_token;
    } catch {
      save(null);                                      // the account was signed out or deleted elsewhere
      return null;
    }
  },

  async signOut() {
    const t = session && session.access_token;
    save(null);
    if (t) { try { await call('/logout', { token: t }); } catch {} }
  },
};
