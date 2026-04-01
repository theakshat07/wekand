require('dotenv').config();
const mongoose = require('mongoose');
const { Notification, BasePlan } = require('../models');

const TARGET_TYPES = [
  'post_live',
  'event_ended',
  'event_ended_registered',
  'event_ended_attended'
];

async function run() {
  try {
    console.log("🚀 Starting WRONG notification CLEANUP...\n");

    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    const notifs = await Notification.find({
      type: { $in: TARGET_TYPES },
      source_plan_id: { $ne: null }
    }).select('_id notification_id user_id source_plan_id');

    console.log("📊 Total notifications to check:", notifs.length, "\n");

    let wrong = 0;
    let checked = 0;

    const deleteIds = [];

    for (const notif of notifs) {
      checked++;

      const plan = await BasePlan.findOne({
        plan_id: notif.source_plan_id
      }).select('user_id').lean();

      if (!plan) continue;

      const notifUser = String(notif.user_id);
      const planOwner = String(plan.user_id);

      if (!planOwner) continue;

      if (notifUser !== planOwner) {
        wrong++;

        deleteIds.push(notif._id);

        console.log("❌ MARKED FOR DELETE:", notif.notification_id);
      }

      if (checked % 500 === 0) {
        console.log(`⏳ Checked ${checked}... Wrong so far: ${wrong}`);
      }
    }

    console.log("\n==============================");
    console.log("🧨 Total to delete:", deleteIds.length);
    console.log("==============================\n");

    if (deleteIds.length === 0) {
      console.log("✅ Nothing to delete");
      process.exit(0);
    }

    // 🔥 BULK DELETE (FAST)
    const result = await Notification.deleteMany({
      _id: { $in: deleteIds }
    });

    console.log("🧨 Deleted:", result.deletedCount);
    console.log("✅ Cleanup complete\n");

  } catch (err) {
    console.error("🔥 Error:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

run();