const { Notification, BasePlan, User, PlanInteraction, Registration } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');

const INDIVIDUAL_TYPES_BUSINESS = ['post_live', 'event_ended', 'event_ended_registered', 'event_ended_attended', 'free_event_cancelled', 'paid_event_cancelled', 'event_chat_poll_vote'];
const INDIVIDUAL_TYPES_REGULAR = ['registration_successful', 'event_ended', 'free_event_cancelled', 'paid_event_cancelled', 'plan_shared_chat'];

/**
 * Get notifications list grouped by post
 */
exports.getNotifications = async (req, res) => {
  try {
    const { user_id, limit = '20', offset = '0' } = req.query;
    const safeLimit = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 20));
    const safeOffset = Math.max(0, parseInt(String(offset), 10) || 0);

    const notifications = await Notification.find({ user_id })
      .sort({ created_at: -1 })
      .skip(safeOffset)
      .limit(safeLimit)
      .lean();

    // Group notifications by post_id
    const grouped = {};
    for (const notif of notifications) {
      const key = notif.source_plan_id || 'no-post';
      if (!grouped[key]) {
        grouped[key] = {
          post_id: notif.source_plan_id || null,
          post: null,
          interactions: [],
          created_at: notif.created_at
        };
      }
      grouped[key].interactions.push(notif);
    }

    // Bulk fetch posts/users/planInteractions so we avoid N+1 queries
    const postIds = Array.from(
      new Set(notifications.map((n) => n.source_plan_id).filter(Boolean).map(String))
    );
    const userIds = Array.from(
      new Set(
        notifications
          .map((n) => n.source_user_id)
          .filter((id) => id && id !== 'system')
          .map(String)
      )
    );
    const requestIds = Array.from(
      new Set(
        notifications
          .map((n) => n?.payload?.request_id)
          .filter(Boolean)
          .map(String)
      )
    );

    const [posts, users, planInteractions] = await Promise.all([
      postIds.length > 0
        ? BasePlan.find({ plan_id: { $in: postIds }, deleted_at: null }).lean()
        : Promise.resolve([]),
      userIds.length > 0
        ? User.find({ user_id: { $in: userIds } }).lean()
        : Promise.resolve([]),
      requestIds.length > 0
        ? PlanInteraction.find({ interaction_id: { $in: requestIds } }).lean()
        : Promise.resolve([]),
    ]);

    const postMap = new Map(posts.map((p) => [String(p.plan_id), p]));
    const userMap = new Map(users.map((u) => [String(u.user_id), u]));
    const planInteractionMap = new Map(planInteractions.map((pi) => [String(pi.interaction_id), pi]));

    // Prefetch registration counts for event-ended notifications if needed
    const eventEndedPlanIds = Array.from(
      new Set(
        notifications
          .filter((n) => n?.source_plan_id && (n.type === 'event_ended_registered' || n.type === 'event_ended_attended'))
          .map((n) => String(n.source_plan_id))
      )
    );

    const [regCountsAgg, attCountsAgg] = await Promise.all([
      eventEndedPlanIds.length > 0
        ? Registration.aggregate([
            { $match: { plan_id: { $in: eventEndedPlanIds }, status: { $in: ['pending', 'approved'] } } },
            { $group: { _id: '$plan_id', count: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
      eventEndedPlanIds.length > 0
        ? Registration.aggregate([
            { $match: { plan_id: { $in: eventEndedPlanIds }, checked_in: true } },
            { $group: { _id: '$plan_id', count: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
    ]);

    const regCountMap = new Map(regCountsAgg.map((r) => [String(r._id), r.count]));
    const attCountMap = new Map(attCountsAgg.map((r) => [String(r._id), r.count]));

    // Fetch post and user details; build plain interaction objects for frontend
    const result = [];
    for (const key in grouped) {
      const group = grouped[key];
      if (group.post_id) {
        const post = postMap.get(String(group.post_id)) || null;
        if (post) {
          group.post = {
            plan_id: post.plan_id,
            title: post.title,
            description: post.description,
            media: post.media || [],
            category_main: post.category_main || null,
            category_sub: post.category_sub || []
          };
        }
      }

      const plainInteractions = [];
      for (const interaction of group.interactions) {
        let userObj = { user_id: 'system', name: '', profile_image: null };
        if (interaction.source_user_id !== 'system') {
          const user = userMap.get(String(interaction.source_user_id)) || null;
          if (user) {
            userObj = {
              user_id: user.user_id,
              name: user.name || `User ${user.user_id.slice(-4)}`,
              profile_image: user.profile_image || null
            };
          } else {
            userObj = {
              user_id: interaction.source_user_id,
              name: `User ${interaction.source_user_id.slice(-4)}`,
              profile_image: null
            };
          }
        }

        const payload = interaction.payload ? { ...interaction.payload } : {};
        if (payload.request_id) {
          const planInteraction = planInteractionMap.get(String(payload.request_id)) || null;
          if (planInteraction) {
            payload.status = planInteraction.status;
            payload.approved = planInteraction.status === 'approved';
          }
        }

        // For event-ended notifications, backfill registered/attended counts when missing or zero (fixes stored 0)
        const planId = interaction.source_plan_id || group.post_id;
        if (planId && (interaction.type === 'event_ended_registered' || interaction.type === 'event_ended_attended')) {
          const needReg = payload.registered_count == null;
          const needAtt = interaction.type === 'event_ended_attended' && payload.scanned_count == null;
          if (needReg || needAtt) {
            if (needReg) payload.registered_count = regCountMap.get(String(planId)) ?? 0;
            if (needAtt) payload.scanned_count = attCountMap.get(String(planId)) ?? 0;
          }
        }

        plainInteractions.push({
          notification_id: interaction.notification_id,
          type: interaction.type,
          source_plan_id: interaction.source_plan_id || null,
          source_user_id: interaction.source_user_id,
          payload,
          created_at: interaction.created_at,
          is_read: interaction.is_read,
          user: userObj
        });
      }
      group.interactions = plainInteractions;
      result.push(group);
    }

    // Sort by most recent interaction
    result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return sendSuccess(res, 'Notifications retrieved successfully', {
      groups: result,
      next_offset: safeOffset + notifications.length,
      has_more: notifications.length === safeLimit
    });
  } catch (error) {
    console.error('[getNotifications] error:', error.message);
    return sendError(res, error.message, 500);
  }
};

/**
 * Mark notification as read
 */
exports.markAsRead = async (req, res) => {
  try {
    const { notification_id } = req.body;
    const notification = await Notification.findOne({ notification_id });
    
    if (!notification) {
      return sendError(res, 'Notification not found', 404);
    }
    
    notification.is_read = true;
    await notification.save();
    
    return sendSuccess(res, 'Notification marked as read');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Create a general (system or user) notification. Used by other controllers.
 * @param {string} user_id - Recipient user id
 * @param {string} type - Notification type (e.g. post_live, event_ended, registration_successful)
 * @param {object} opts - { source_plan_id?, source_user_id (default 'system'), payload }
 */
exports.createGeneralNotification = async (user_id, type, opts = {}) => {
  const { source_plan_id = null, source_user_id = 'system', payload = {} } = opts;
  try {
    await Notification.create({
      notification_id: generateId('notification'),
      user_id,
      type,
      source_plan_id,
      source_user_id,
      payload,
      is_read: false
    });
    console.log('[createGeneralNotification] created type=', type, 'user_id=', user_id, 'plan_id=', source_plan_id || 'none');
  } catch (err) {
    console.error('[createGeneralNotification]', err.message);
  }
};

/**
 * Get unread count
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return sendError(res, 'user_id is required', 400);
    }
    const uid = String(user_id);
    const count = await Notification.countDocuments({
      $or: [{ user_id: uid }, { user_id: user_id }],
      is_read: false
    });
    
    return sendSuccess(res, 'Unread count retrieved successfully', {
      unread_count: count
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

