/**
 * One-off cleanup: remove duplicate notification documents that share the same
 * (user_id, type, source_plan_id), keeping the oldest by created_at.
 *
 * Safe: only deletes when aggregate finds count > 1 for that triple.
 *
 * Usage:
 *   MONGO_URI="mongodb+srv://..." node scripts/dedupe-notifications.js
 *   DRY_RUN=1 node scripts/dedupe-notifications.js   # log only, no deletes
 *
 * Run BEFORE relying on unique index { grouped_key: 1 } if the DB already has duplicate logical rows.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const Notification = require('../models/other/Notification');

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri || typeof uri !== 'string' || !uri.startsWith('mongodb')) {
    console.error('Set MONGO_URI in .env or environment (mongodb connection string).');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[dedupe-notifications] Connected.');

  const dupGroups = await Notification.aggregate([
    {
      $group: {
        _id: {
          user_id: '$user_id',
          type: '$type',
          source_plan_id: { $ifNull: ['$source_plan_id', '__no_plan__'] },
        },
        docs: {
          $push: {
            _id: '$_id',
            created_at: '$created_at',
            notification_id: '$notification_id',
          },
        },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  let deletedTotal = 0;
  let groupsProcessed = 0;

  for (const g of dupGroups) {
    const docs = [...g.docs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const keep = docs[0];
    const toRemove = docs.slice(1);
    const ids = toRemove.map((d) => d._id);

    groupsProcessed += 1;
    console.log(
      `[dedupe-notifications] group ${groupsProcessed} key=${JSON.stringify(g._id)} ` +
        `duplicates=${toRemove.length} keep=${keep.notification_id} (${keep._id})`
    );

    if (DRY_RUN) {
      console.log('[dedupe-notifications] DRY_RUN would delete _ids:', ids.map(String).join(', '));
      deletedTotal += toRemove.length;
      continue;
    }

    const res = await Notification.deleteMany({ _id: { $in: ids } });
    deletedTotal += res.deletedCount || 0;
  }

  console.log(
    `[dedupe-notifications] Done. Duplicate groups: ${dupGroups.length}. ` +
      `Rows ${DRY_RUN ? 'that would be' : ''} removed: ${deletedTotal}.`
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('[dedupe-notifications] Fatal:', err);
  process.exit(1);
});
