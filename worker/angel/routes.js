// Secret Angel: everyone saves gift preferences; once they're all in, the
// admin draws who gives a gift to whom. Each person is only ever sent their
// own match. Stored in the store (worker/store) under angel:v1 — its old
// KV key, imported on first read — keyed by lower-cased user name.
import { j } from '../lib/http.js';
import { readDoc, transact } from '../lib/store.js';
import { cleanName, getUsers, sameName } from '../users/users.js';
import { drawCycle } from './draw.js';

const ANGEL_KEY = 'angel:v1';
// The admin is a real role stored in the doc (not just this constant):
// the constant is only who starts with it. The admin — and only the
// admin — runs the draw/reshuffle and the exclusions, and can hand
// the role to another member (POST /api/angel/admin).
const DEFAULT_ADMIN = 'aster';
const PICK_VALUES = ['love', 'nope'];

const emptyAngel = () => ({ prefs: {}, excluded: [], draw: null });
const normalizeAngel = a => {
  if (!a || typeof a !== 'object') a = emptyAngel();
  if (!a.prefs) a.prefs = {};
  if (!Array.isArray(a.excluded)) a.excluded = [];
  if (!('draw' in a)) a.draw = null;
  if (!a.admin) a.admin = DEFAULT_ADMIN;
  return a;
};

async function getAngel(env) {
  const { doc } = await readDoc(env, ANGEL_KEY);
  return normalizeAngel(doc);
}

// fn(a) mutates the freshest angel document and returns the handler's
// result; the commit is version-checked (see lib/store.js), so two
// people saving wishes in the same second can't erase each other.
async function updateAngel(env, fn) {
  return transact(env, ANGEL_KEY, async doc => {
    const a = normalizeAngel(doc);
    const result = await fn(a);
    return { doc: a, result };
  });
}

// The caller, if their name and token match the user list (same check as
// sitting down at Blackjack).
async function caller(env, name, token) {
  const users = await getUsers(env);
  const user = users.find(u => sameName(u.name, cleanName(name)));
  return user && token && user.token === token ? { users, user, key: user.name.toLowerCase() } : { users };
}

// Who's in: every user the admin hasn't excluded.
const roster = (users, a) => users
  .map(u => ({ key: u.name.toLowerCase(), name: u.name }))
  .filter(u => !a.excluded.includes(u.key))
  .sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'));

function view(users, a, me) {
  const people = users.map(u => {
    const key = u.name.toLowerCase();
    return { name: u.name, submitted: !!a.prefs[key], excluded: a.excluded.includes(key), isAdmin: key === a.admin };
  }).sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'));
  const masterKey = me && a.draw ? a.draw.pairs[me] : null;
  const master = masterKey ? users.find(u => u.name.toLowerCase() === masterKey) : null;
  const adminUser = users.find(u => u.name.toLowerCase() === a.admin);
  return {
    ok: true,
    people,
    isAdmin: !!me && me === a.admin,
    adminName: adminUser ? adminUser.name : a.admin,
    drawn: !!a.draw, drawnAt: a.draw ? a.draw.at : null,
    inDraw: !!(me && a.draw && a.draw.pairs[me]),
    mine: me ? a.prefs[me] || null : null,
    master: master ? { name: master.name, prefs: a.prefs[masterKey] || null } : null,
  };
}

async function handleGet(req, env, url) {
  const { users, key } = await caller(env, url.searchParams.get('name'), url.searchParams.get('token'));
  return j(view(users, await getAngel(env), key));
}

async function handlePrefs(req, env) {
  let body = {};
  try { body = await req.json() || {}; } catch (e) { /* ignore */ }
  const { users, key } = await caller(env, body.name, body.token);
  if (!key) return j({ ok: false, error: '先登录' });
  const picks = {};
  for (const [cat, v] of Object.entries(body.picks || {}).slice(0, 40)) {
    if (/^[a-z_]{1,24}$/.test(cat) && PICK_VALUES.includes(v)) picks[cat] = v;
  }
  if (!Object.values(picks).includes('love')) return j({ ok: false, error: '至少选一样想要的 💖' });
  const a = await updateAngel(env, a => {
    a.prefs[key] = { picks, note: String(body.note || '').trim().slice(0, 200), updatedAt: Date.now() };
    return a;
  });
  return j(view(users, a, key));
}

// Admin: leave someone out (or back in), e.g. a name on the list who isn't coming.
async function handleExclude(req, env) {
  let body = {};
  try { body = await req.json() || {}; } catch (e) { /* ignore */ }
  const { users, key } = await caller(env, body.name, body.token);
  const target = cleanName(body.target).toLowerCase();
  const out = await updateAngel(env, a => {
    if (!key || key !== a.admin) return { error: '只有管理员可以操作' };
    if (!users.some(u => u.name.toLowerCase() === target)) return { error: '没有这个人' };
    a.excluded = a.excluded.filter(k => k !== target);
    if (body.excluded) a.excluded.push(target);
    return { a };
  });
  if (out.error) return j({ ok: false, error: out.error });
  return j(view(users, out.a, key));
}

// Admin: draw (or redraw / reshuffle). The pool is whoever is in AND
// has saved preferences — no need to wait for stragglers: anyone who
// hasn't filled theirs in yet sits this round out, and a redraw after
// they submit pools them in. A redraw only replaces the pairings;
// saved preferences are never touched here.
async function handleDraw(req, env) {
  let body = {};
  try { body = await req.json() || {}; } catch (e) { /* ignore */ }
  const { users, key } = await caller(env, body.name, body.token);
  const out = await updateAngel(env, a => {
    if (!key || key !== a.admin) return { error: '只有管理员可以抽签' };
    const pool = roster(users, a).filter(p => a.prefs[p.key]);
    if (pool.length < 2) return { error: '至少要有两个人选好愿望才能抽（现在 ' + pool.length + ' 人）' };
    const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    const pairs = drawCycle(pool.map(p => p.key), rand);
    if (!pairs) return { error: '至少要两个人才能抽' };
    a.draw = { at: Date.now(), pairs };
    return { a };
  });
  if (out.error) return j({ ok: false, error: out.error });
  return j(view(users, out.a, key));
}

// Admin: hand the admin role to another member. This is what makes
// the role an identity instead of a hardcoded name — if the admin is
// away, they pass it on and the new admin can reshuffle right away.
async function handleAdmin(req, env) {
  let body = {};
  try { body = await req.json() || {}; } catch (e) { /* ignore */ }
  const { users, key } = await caller(env, body.name, body.token);
  const target = cleanName(body.target).toLowerCase();
  const out = await updateAngel(env, a => {
    if (!key || key !== a.admin) return { error: '只有当前管理员可以转让管理员' };
    if (!users.some(u => u.name.toLowerCase() === target)) return { error: '没有这个人' };
    a.admin = target;
    return { a };
  });
  if (out.error) return j({ ok: false, error: out.error });
  return j(view(users, out.a, key));
}

// Remove one person from Secret Angel entirely (thorough user
// deletion, users/admin.js): their saved prefs, any exclusion entry,
// and the admin hat if they somehow hold it (falls back to the default
// admin). If a draw exists, their seat is spliced out of the cycle —
// whoever was giving to them now gives to their person — so the rest
// of the circle stays intact; with fewer than two left, the draw goes.
export async function scrubUserFromAngel(env, user) {
  const key = user.name.toLowerCase();
  await updateAngel(env, a => {
    delete a.prefs[key];
    a.excluded = a.excluded.filter(k => k !== key);
    if (a.admin === key) a.admin = DEFAULT_ADMIN;
    if (a.draw && a.draw.pairs && key in a.draw.pairs) {
      const pairs = a.draw.pairs;
      const next = pairs[key];
      const pred = Object.keys(pairs).find(k => pairs[k] === key);
      delete pairs[key];
      if (Object.keys(pairs).length < 2) a.draw = null;
      else if (pred) pairs[pred] = next;
    }
    return a;
  });
}

export const routes = {
  'GET /api/angel': handleGet,
  'POST /api/angel/prefs': handlePrefs,
  'POST /api/angel/exclude': handleExclude,
  'POST /api/angel/draw': handleDraw,
  'POST /api/angel/admin': handleAdmin,
};
