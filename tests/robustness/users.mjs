// User deletion is PM-only and thorough (worker/users/admin.js): the
// endpoint checks the caller's token against the PM account's, and a
// successful delete also scrubs everything recorded under that person —
// votes, flights, split entries, Secret Angel prefs and draw seat.
// Covers the authorization matrix plus the scrub, end to end against
// the local test instance.
//
// Standalone use: TEST_BASE=http://localhost:8791 node tests/robustness/users.mjs
const B = process.env.TEST_BASE || 'http://localhost:8791';
const J = async (m, p, o) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: o === undefined ? undefined : JSON.stringify(o) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* ignore */ }
  return j;
};
let pass = 0, fail = 0;
const ck = (name, cond, extra) => { if (cond) { pass++; console.log('OK  ', name); } else { fail++; console.log('FAIL', name, extra ?? ''); } };
const tag = Date.now().toString(36);
const VICTIM = 'Victim' + tag, GONER = 'Goner' + tag;
const isVictim = n => String(n || '').toLowerCase() === VICTIM.toLowerCase();

// PM may pre-exist in a seeded list; either way login returns its token.
const pm = await J('POST', '/api/login', { name: 'PM', token: 'pm-device-' + tag });
const pmTok = pm.user?.token;
ck('PM login returns a token', !!pmTok, JSON.stringify(pm));

const vic = await J('POST', '/api/login', { name: VICTIM, token: 'victim-device-' + tag });
const vicTok = vic.user?.token;
ck('victim created', !!vicTok, JSON.stringify(vic));
const gon = await J('POST', '/api/login', { name: GONER, token: 'goner-device-' + tag });
ck('goner created', !!gon.user?.token, JSON.stringify(gon));

// ---- authorization matrix ----
const noTok = await J('POST', '/api/users/delete', { name: GONER });
ck('delete without a token rejected', noTok.ok === false, JSON.stringify(noTok));
const wrongTok = await J('POST', '/api/users/delete', { name: GONER, token: 'not-a-real-token' });
ck('delete with a bogus token rejected', wrongTok.ok === false, JSON.stringify(wrongTok));
const byVictim = await J('POST', '/api/users/delete', { name: GONER, token: vicTok });
ck('delete by a non-PM user rejected', byVictim.ok === false && /只有 PM/.test(byVictim.error || ''), JSON.stringify(byVictim));

const mid = await J('GET', '/api/users');
ck('goner still listed after rejected deletes', mid.users.some(u => u.name === GONER));

const ghost = await J('POST', '/api/users/delete', { name: 'Nobody' + tag, token: pmTok });
ck('deleting a nonexistent user rejected', ghost.ok === false, JSON.stringify(ghost));
const self = await J('POST', '/api/users/delete', { name: 'PM', token: pmTok });
ck('PM cannot delete itself', self.ok === false && /不能删 PM/.test(self.error || ''), JSON.stringify(self));

const delGoner = await J('POST', '/api/users/delete', { name: GONER, token: pmTok });
ck('PM deletes the goner', delGoner.ok === true, JSON.stringify(delGoner));
const afterGoner = await J('GET', '/api/users');
ck('goner gone from the list', !afterGoner.users.some(u => u.name === GONER));
ck('PM still listed', afterGoner.users.some(u => u.name.toLowerCase() === 'pm'));

// ---- thorough scrub: give the victim a footprint everywhere first ----
const st0 = await J('GET', '/api/state?trip=nov26');
const lid = st0.listings[0].id;
await J('POST', '/api/vote', { trip: 'nov26', id: lid, token: vicTok, name: VICTIM });
const stV = await J('GET', '/api/state?trip=nov26');
ck('victim listing vote recorded', stV.listings.find(l => l.id === lid).votes.some(v => isVictim(v.name)));

await J('POST', '/api/activity-vote', { id: 'red-rocks', token: vicTok, name: VICTIM });
const actV = await J('GET', '/api/activities');
ck('victim activity vote recorded', actV.activities.find(a => a.id === 'red-rocks').votes.some(v => isVictim(v.name)));

const fl = await J('POST', '/api/flights', { name: VICTIM, token: vicTok, arrival: { flight: 'UA100', date: '2026-11-25', from: 'SFO', to: 'DEN', dep: '08:00', arr: '11:30' } });
ck('victim flight saved', fl.ok === true, JSON.stringify(fl));

const ex = await J('POST', '/api/expense', { paidBy: VICTIM, amountUSD: 30, splitAmong: [VICTIM, 'PM'], description: 'victim test expense' });
ck('victim expense recorded', ex.ok === true, JSON.stringify(ex));

// Secret Angel: victim + PM + Aster (the default admin) submit prefs,
// Aster draws, then deleting the victim must splice them out of the
// cycle, leaving PM and Aster giving to each other.
const ast = await J('POST', '/api/login', { name: 'Aster', token: 'aster-device-' + tag });
const astTok = ast.user?.token;
await J('POST', '/api/angel/prefs', { name: VICTIM, token: vicTok, picks: { gear: 'love' } });
await J('POST', '/api/angel/prefs', { name: 'PM', token: pmTok, picks: { gear: 'love' } });
await J('POST', '/api/angel/prefs', { name: 'Aster', token: astTok, picks: { food: 'love' } });
const draw = await J('POST', '/api/angel/draw', { name: 'Aster', token: astTok });
ck('draw happened with victim in', draw.ok === true && draw.drawn === true, JSON.stringify(draw));

// ---- delete the victim and verify the scrub ----
const del = await J('POST', '/api/users/delete', { name: VICTIM, token: pmTok });
ck('PM deletes the victim', del.ok === true, JSON.stringify(del));
ck('scrub counts report the footprint', del.scrubbed?.listingVotes >= 1 && del.scrubbed?.activityVotes >= 1 && del.scrubbed?.splitExpenses >= 1, JSON.stringify(del.scrubbed));

const usersEnd = await J('GET', '/api/users');
ck('victim gone from the list', !usersEnd.users.some(u => isVictim(u.name)));

const stEnd = await J('GET', '/api/state?trip=nov26');
ck('no listing votes by victim remain', stEnd.listings.every(l => (l.votes || []).every(v => !isVictim(v.name) && v.token !== vicTok)));
const actEnd = await J('GET', '/api/activities');
ck('no activity votes by victim remain', actEnd.activities.every(a => (a.votes || []).every(v => !isVictim(v.name) && v.token !== vicTok)));

const splitEnd = await J('GET', '/api/split');
ck('no split trace of victim remains',
  splitEnd.expenses.every(e => !isVictim(e.paidBy) && !(e.splitAmong || []).some(isVictim)) && !(VICTIM in (splitEnd.balances || {})),
  JSON.stringify(splitEnd.balances));

const angelPm = await J('GET', `/api/angel?name=PM&token=${pmTok}`);
ck('draw survives with victim spliced out', angelPm.drawn === true && angelPm.master?.name === 'Aster', JSON.stringify(angelPm.master));
const angelAst = await J('GET', `/api/angel?name=Aster&token=${astTok}`);
ck('aster now gives to PM', angelAst.master?.name === 'PM', JSON.stringify(angelAst.master));

console.log(`USERS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
