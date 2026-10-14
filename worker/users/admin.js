// User administration: account deletion, restricted to the PM account
// (USER_ADMIN in users.js). Kept in its own module because it reaches
// into every feature's data, while the features themselves only depend
// on users.js.
//
// Authorization: the caller's token must belong to the PM account.
// PM is email-bound, so that token is not in the public user list and
// the permission can't be borrowed by picking a name from it.
//
// Deletion is thorough: the account goes, and so does everything
// recorded under that person — listing/food/activity votes, saved
// flights, split expenses and shares, Secret Angel prefs and draw
// seat (each feature's scrubUserFrom* does its own part). Cards and
// restaurants they added stay (others may have voted on them); the
// games keep their own tables inside their Durable Objects and are
// not touched.
import { j } from '../lib/http.js';
import { cleanName, getUsers, updateUsers, publicUsers, sameName, USER_ADMIN } from './users.js';
import { scrubUserFromTrips } from '../listings/state.js';
import { scrubUserFromFood } from '../food/store.js';
import { scrubUserFromActivities } from '../activities/store.js';
import { scrubUserFromFlights } from '../flights/routes.js';
import { scrubUserFromSplit } from '../split/store.js';
import { scrubUserFromAngel } from '../angel/routes.js';

async function handleUserDelete(req, env) {
  let body = {};
  try { body = await req.json() || {}; } catch (e) { /* ignore */ }
  const targetName = cleanName(body.name);
  if (!targetName) return j({ ok: false, error: '先选要删的人' });
  const users = await getUsers(env);
  const presented = String(body.token || '');
  const caller = presented ? users.find(u => u.token === presented) : null;
  if (!caller || !sameName(caller.name, USER_ADMIN)) return j({ ok: false, error: '只有 PM 能删用户' });
  if (sameName(targetName, USER_ADMIN)) return j({ ok: false, error: '不能删 PM 自己' });
  const target = users.find(u => sameName(u.name, targetName));
  if (!target) return j({ ok: false, error: '没这个用户' });

  await updateUsers(env, list => {
    const i = list.findIndex(u => sameName(u.name, target.name));
    if (i >= 0) list.splice(i, 1);
    return list;
  });
  const scrubbed = {
    listingVotes: await scrubUserFromTrips(env, target),
    foodVotes: await scrubUserFromFood(env, target),
    activityVotes: await scrubUserFromActivities(env, target),
    splitExpenses: await scrubUserFromSplit(env, target),
  };
  await scrubUserFromFlights(env, target);
  await scrubUserFromAngel(env, target);
  return j({ ok: true, users: publicUsers(await getUsers(env)), scrubbed });
}

export const routes = {
  'POST /api/users/delete': handleUserDelete,
};
