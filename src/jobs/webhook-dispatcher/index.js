import {literal} from 'sequelize';
import Debug from 'debug';
const debug = Debug('backstroke:webhook:job');

const AUTOMATIC = 'AUTOMATIC';
const UPDATE_SECONDS = 30;
const WEBHOOK_SYNC_DURATION = process.env.WEBHOOK_SYNC_DURATION || '10 minutes';

// Every 30 seconds, try to update a link.
export default function(Link, User, WebhookQueue, upstreamSHAChanged) {
  webhookJob.apply(null, arguments);
  return setInterval(() => webhookJob.apply(null, arguments), UPDATE_SECONDS * 1000);
}

export async function webhookJob(Link, User, WebhookQueue, fetchSHAForUpstreamBranch) {
  const links = await Link.findAll({
    where: {
      name: {ne: ''},
      enabled: true,
      lastSyncedAt: {
        lt: literal(`now() - interval '${WEBHOOK_SYNC_DURATION}'`),
      },

      upstreamType: {ne: null},
      upstreamOwner: {ne: null},
      upstreamRepo: {ne: null},

      forkType: {ne: null},
      forkOwner: {ne: null},
      forkRepo: {ne: null},
    },
    include: [{model: User, as: 'owner'}],
  });

  // No links to update?
  if (!links || links.length === 0) {
    debug('No links to update. Breaking...');
    return null;
  }

  const responses = links.map(async link => {
    let headSha;
    try {
      headSha = await fetchSHAForUpstreamBranch(link);
    } catch (err) {
      debug(`Error fetching upstream sha for %o: %o`, link.id, err.message);
      headSha = null;
    }

    // Before enqueuing an update, make sure that the commit hash actually changed of the upstream
    debug(`Updating link %o, last updated = %o, last known SHA = %o, current SHA = %o`, link.id, link.lastSyncedAt, link.upstreamLastSHA, headSha);

    // Head sha of the upstream wasn't able to found. Maybe the repo was deleted?
    if (link.upstreamLastSHA && !headSha) {
      debug(`Unable to fetch upstream sha for link %o`, link.id);

    // Link hasn't been synced, ever, since no 'last sha' value is present. Sync it.
    } else if (!link.upstreamLastSHA) {
      await WebhookQueue.push({type: AUTOMATIC, user: link.owner, link});
      debug(`Update enqueued successfully for link %o. REASON = FIRST_SYNC`, link.id);

    // The upstream has new commits since the last polling attempt. Sync it.
    } else if (link.upstreamLastSHA !== headSha) {
      await WebhookQueue.push({type: AUTOMATIC, user: link.owner, link});
      debug(`Update enqueued successfully for link %o. REASON = UPSTREAM_NEW_COMMITS`, link.id);

    } else {
      debug(`Link %o didn't change, update not required.`, link.id);
    }

    // Update the link instance to say that the link has been synced (or, at least checked)
    await Link.update({lastSyncedAt: new Date, upstreamLastSHA: headSha}, {where: {id: link.id}, limit: 1});
    return true;
  });

  return Promise.all(responses).catch(err => {
    console.error('Error in syncing job:', err);
  });
}
