/**
 * Marks business plans whose event start date+time has passed as completed (not deleted).
 * Plans stay in the DB so organizers keep analytics, guest lists, and notification post context.
 * Sets post_status = 'completed', is_live = false (does not set deleted_at).
 */

const { BusinessPlan, Registration } = require('../models');
const { createGeneralNotification } = require('../controllers/notificationController');
const { getEventEndDateForDeactivation, getEventStartDate } = require('../utils/eventSchedule');

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Find published business plans whose event end (end_time, or end of event day IST) is in the past
 * and set post_status to 'completed'.
 */
async function deactivatePastEventPlans() {
  try {
    const now = new Date();
    const plans = await BusinessPlan.find({
      post_status: 'published',
      date: { $ne: null },
      time: { $exists: true, $ne: null, $ne: '' },
    }).lean();

    let deactivated = 0;
    for (const plan of plans) {
      const eventEnd = getEventEndDateForDeactivation(plan.date, plan.time, plan.end_time);
      if (!eventEnd) continue;
      if (eventEnd.getTime() <= now.getTime()) {
        const plan_id = plan.plan_id;
        const ownerId = plan.user_id;
        const eventTitle = plan.title || 'Event';

        const registeredCount = await Registration.countDocuments({
          plan_id,
          status: { $in: ['pending', 'approved'] }
        });
        const attendedCount = await Registration.countDocuments({
          plan_id,
          checked_in: true
        });

        /**
         * Only ONE worker/process may transition published → completed for this plan.
         * Without this, PM2 cluster / duplicate schedulers both see `published` and each insert
         * the same event_ended rows (duplicate notifications within milliseconds).
         */
        const transitioned = await BusinessPlan.findOneAndUpdate(
          { plan_id, post_status: 'published' },
          { $set: { post_status: 'completed', is_live: false, updated_at: new Date() } },
          { new: true }
        ).lean();

        if (!transitioned) {
          continue;
        }

        deactivated++;

        // Use counts fetched before update (registrations are not deleted)
        const regCount = Number(registeredCount);
        const attCount = Number(attendedCount);

        if (ownerId) {
          console.log('[deactivatePastEventPlans] plan_id=', plan_id, 'regCount=', regCount, 'attCount=', attCount);

          await createGeneralNotification(ownerId, 'event_ended', {
            source_plan_id: plan_id,
            source_user_id: 'system',
            payload: {
              event_title: eventTitle,
              cta_type: 'go_to_event',
              notification_text: `${eventTitle} has ended`
            }
          });
          await createGeneralNotification(ownerId, 'event_ended_registered', {
            source_plan_id: plan_id,
            source_user_id: 'system',
            payload: {
              event_title: eventTitle,
              cta_type: 'go_to_analytics',
              registered_count: regCount,
              notification_text: `${regCount} people registered for ${eventTitle}`
            }
          });
          await createGeneralNotification(ownerId, 'event_ended_attended', {
            source_plan_id: plan_id,
            source_user_id: 'system',
            payload: {
              event_title: eventTitle,
              cta_type: 'go_to_analytics',
              scanned_count: attCount,
              registered_count: regCount,
              notification_text: attCount > 0
                ? `${attCount} people attended ${eventTitle}`
                : `${regCount} people registered for ${eventTitle}`
            }
          });
        }

        // Notify registrants (regular users): Event ended -> Go to Chat
        const registrations = await Registration.find({
          plan_id,
          status: { $in: ['pending', 'approved'] }
        })
          .select('user_id')
          .lean();
        const groupId = plan.group_id || null;
        for (const reg of registrations) {
          if (reg.user_id && reg.user_id !== ownerId) {
            await createGeneralNotification(reg.user_id, 'event_ended', {
              source_plan_id: plan_id,
              source_user_id: 'system',
              payload: {
                event_title: eventTitle,
                cta_type: 'go_to_chat',
                notification_text: `${eventTitle} has ended`,
                group_id: groupId
              }
            });
          }
        }
      }
    }
    if (deactivated > 0) {
      console.log(`[deactivatePastEventPlans] Marked ${deactivated} plan(s) completed (event end had passed, IST).`);
    }
  } catch (err) {
    console.error('[deactivatePastEventPlans] Error:', err.message);
  }
}

let intervalId = null;

function start() {
  if (intervalId) return;
  deactivatePastEventPlans(); // run once on start
  intervalId = setInterval(deactivatePastEventPlans, INTERVAL_MS);
  console.log('[deactivatePastEventPlans] Scheduler started (every 10 minutes).');
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[deactivatePastEventPlans] Scheduler stopped.');
  }
}

module.exports = { start, stop, deactivatePastEventPlans, getEventStartDate };
