// 鲁班七号躲技能 leaderboard: one Durable Object (/api/dodge/*), each person's
// best survival time, all time. The game runs entirely in the browser; when a
// run ends the page posts how long you survived and that's what counts (only
// the login is checked, so nobody posts under someone else's name). Nothing
// is held between requests, so the object can sleep any time without losing
// a run. Bests live in this object's storage (p:<name>), never in KV.
//   POST /api/dodge/score { name, token, ticks }   -> { ticks, best, newBest, rank, board }
//   GET  /api/dodge/board                          -> { board }
//   GET  /api/dodge/grants?name&token               -> { canBot, isAdmin, grants }
//   POST /api/dodge/grants { name, token, target, on }  (PM only: who may use the autopilot)
// Times are in ticks: 60 a second.
import { getUsers, sameName, cleanName, USER_ADMIN } from '../users/users.js';
import { j } from '../lib/http.js';

const MAX_TICKS = 10 * 60 * 60; // a run stops counting after 10 minutes

export class DodgeBoard {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.best = new Map(); // key -> { name, ticks, runs, at }
    this.grants = new Set(); // lower-cased names PM has allowed the autopilot
    this.loaded = null;
  }
  load() {
    return this.loaded ||= Promise.all([
      this.state.storage.list({ prefix: 'p:' }),
      this.state.storage.get('grants'),
    ]).then(([m, g]) => {
      for (const [k, v] of m) this.best.set(k.slice(2), v);
      if (Array.isArray(g)) for (const k of g) this.grants.add(k);
    });
  }
  top() {
    return [...this.best.values()].sort((a, b) => b.ticks - a.ticks || a.at - b.at).slice(0, 50)
      .map(r => ({ name: r.name, ticks: r.ticks, runs: r.runs, at: r.at }));
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET' && path === '/api/dodge/board') return j({ ok: true, board: this.top() });
    if (request.method === 'GET' && path === '/api/dodge/grants') {
      return this.grantsView(await this.caller(url.searchParams.get('name'), url.searchParams.get('token')));
    }
    // always read the body (answering without it trips the runtime), and only use it if it's an object
    const parsed = request.method === 'POST' ? await request.json().catch(() => null) : null;
    const body = parsed && typeof parsed === 'object' ? parsed : {};
    if (request.method === 'POST' && path === '/api/dodge/score') return this.score(body);
    if (request.method === 'POST' && path === '/api/dodge/grants') return this.setGrant(body);
    // a page from before scores were taken from the browser still calls /start and /finish
    return j({ ok: false, error: '这个版本旧了，刷新一下页面' }, 404);
  }

  // The account behind a name+token pair, or null (same check as scores).
  async caller(name, token) {
    const users = await getUsers(this.env);
    const user = users.find(u => sameName(u.name, cleanName(name)));
    return user && token && user.token === token ? user : null;
  }

  // Who may flip the autopilot on: PM always (he's the admin who hands
  // it out), plus anyone he has granted. Only PM sees the grant list.
  async grantsView(me) {
    const users = await getUsers(this.env);
    const isAdmin = !!me && sameName(me.name, USER_ADMIN);
    const nameOf = k => { const u = users.find(x => x.name.toLowerCase() === k); return u ? u.name : k; };
    return j({
      ok: true,
      isAdmin,
      canBot: isAdmin || (!!me && this.grants.has(me.name.toLowerCase())),
      grants: isAdmin ? [...this.grants].map(nameOf).sort((a, b) => a.localeCompare(b, 'zh-CN')) : [],
    });
  }

  async setGrant({ name, token, target, on }) {
    const me = await this.caller(name, token);
    if (!me || !sameName(me.name, USER_ADMIN)) return j({ ok: false, error: '只有 PM 能授权外挂' }, 403);
    const users = await getUsers(this.env);
    const t = users.find(u => sameName(u.name, cleanName(target)));
    if (!t) return j({ ok: false, error: '没有这个人' }, 404);
    const key = t.name.toLowerCase();
    if (on) this.grants.add(key); else this.grants.delete(key);
    await this.state.storage.put('grants', [...this.grants]);
    return this.grantsView(me);
  }

  async score({ name, token, ticks }) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > MAX_TICKS) return j({ ok: false, error: '这局的时间不对，没记上' }, 400);
    const users = await getUsers(this.env);
    const user = users.find(u => sameName(u.name, cleanName(name)));
    if (!user || user.token !== token) return j({ ok: false, error: '先登录再玩' }, 401);
    const key = user.name.toLowerCase(), prev = this.best.get(key);
    const newBest = !prev || ticks > prev.ticks;
    const rec = newBest
      ? { name: user.name, ticks, runs: (prev?.runs || 0) + 1, at: Date.now() }
      : { ...prev, name: user.name, runs: prev.runs + 1 };
    this.best.set(key, rec);
    await this.state.storage.put('p:' + key, rec);
    const board = this.top();
    return j({ ok: true, ticks, best: rec.ticks, newBest, rank: board.findIndex(x => x.name === user.name) + 1, board });
  }
}
