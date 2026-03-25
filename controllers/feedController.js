const { BasePlan, RegularPlan, BusinessPlan, Repost, User, UserBlock, PlanInteraction } = require('../models');
const { sendSuccess, sendError, paginate } = require('../utils');
const { rankPlansForUser, rankPlansForGuest } = require('../utils/ranking');

/**
 * Get home feed with personalized ranking algorithm
 */
exports.getHomeFeed = async (req, res) => {
  try {
    const { user_id, filters = {}, pagination = {} } = req.body;
    const { limit = 10, offset = 0 } = pagination;
    const { category_main, category_sub = [], location } = filters;
    
    const query = {
      post_status: { $in: ['published', 'completed'] },
      is_draft: false,
      deleted_at: null
    };
    
    // Category filter: only show posts whose MAIN category matches the selected tag (prefix, case-insensitive).
    // e.g. "fitness" matches "fitness" and "fitness/training"; "running" matches only "running". No category_sub
    // matching so a Running post with a Fitness sub-tag does not appear under Fitness.
    if (category_main && typeof category_main === 'string' && category_main.trim()) {
      const main = category_main.trim();
      const escaped = main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mainRegex = new RegExp(`^${escaped}`, 'i');
      query.category_main = mainRegex;
    }
    
    if (category_sub.length > 0) {
      query.category_sub = { $in: category_sub };
    }
    
    if (location && location.lat && location.long) {
      // For location-based filtering, you'd use geospatial queries
      // For now, we'll just filter if location_coordinates exist
      query.location_coordinates = { $exists: true };
    }
    
    // Get posts (we'll rank them, so fetch more than needed).
    // Important: include offset in fetch size so pagination returns different items.
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit)));
    const safeOffset = Math.max(0, parseInt(offset));
    const fetchSize = Math.min(250, (safeOffset + safeLimit) * 5);
    const plans = await BasePlan.find(query)
      .sort({ created_at: -1 })
      .limit(fetchSize)
      .lean();
    
    // Fetch user data if user_id is provided (for registered users)
    let user = null;
    if (user_id) {
      user = await User.findOne({ user_id }).lean();
    }

    // Block filter: hide posts from users that the current user blocked OR users who blocked the current user
    let blockedUserIds = new Set();
    if (user_id) {
      const blocks = await UserBlock.find({
        $or: [{ blocker_id: user_id }, { blocked_user_id: user_id }]
      }).lean();
      blocks.forEach((b) => {
        if (String(b.blocker_id) === String(user_id)) blockedUserIds.add(String(b.blocked_user_id));
        if (String(b.blocked_user_id) === String(user_id)) blockedUserIds.add(String(b.blocker_id));
      });
    }

    // Women-only posts are visible to everyone; only registration is restricted to women
    let plansFiltered = plans;
    if (blockedUserIds.size > 0) {
      plansFiltered = plansFiltered.filter((p) => !blockedUserIds.has(String(p.user_id)));
    }

    // Apply ranking algorithm
    let rankedPlans;
    if (user) {
      rankedPlans = rankPlansForUser(plansFiltered, user);
    } else {
      rankedPlans = rankPlansForGuest(plansFiltered);
    }
    
    // Check which posts are reposts
    const planIds = rankedPlans.map(p => p.plan_id);
    const reposts = await Repost.find({ original_plan_id: { $in: planIds } });
    const repostMap = {};
    reposts.forEach(r => { repostMap[r.original_plan_id] = r; });
    
    // Get reposts as separate feed items (also need to rank them)
    const allReposts = await Repost.find({})
      .sort({ created_at: -1 })
      .limit(Math.min(200, safeLimit * 2 + safeOffset))
      .lean();
    
    // Get original plans for reposts
    const repostPlanIds = allReposts.map(r => r.original_plan_id);
    const originalPlans = await BasePlan.find({ 
      plan_id: { $in: repostPlanIds },
      deleted_at: null
    }).lean();
    const originalPlansMap = {};
    originalPlans.forEach(p => { originalPlansMap[p.plan_id] = p; });
    
    // Rank reposts (using original plan data)
    const repostPlans = allReposts
      .map(repost => {
        const originalPlan = originalPlansMap[repost.original_plan_id];
        if (!originalPlan) return null;
        if (blockedUserIds.size > 0) {
          if (blockedUserIds.has(String(repost.repost_author_id))) return null;
          if (blockedUserIds.has(String(originalPlan.user_id))) return null;
        }
        return {
          ...originalPlan,
          created_at: repost.created_at,
          _isRepost: true,
          _repostData: repost
        };
      })
      .filter(Boolean);

    let rankedReposts = [];
    if (repostPlans.length > 0) {
      if (user) {
        rankedReposts = rankPlansForUser(repostPlans, user);
      } else {
        rankedReposts = rankPlansForGuest(repostPlans);
      }
    }
    
    // Format regular posts (mark if they're reposted)
    const regularFeed = rankedPlans
      .slice(safeOffset, safeOffset + safeLimit)
      .map(plan => {
        const isReposted = !!repostMap[plan.plan_id];
        const item = {
          post_id: plan.plan_id,
          user_id: plan.user_id,
          title: plan.title,
          description: plan.description,
          media: plan.media,
          tags: plan.category_sub,
          category_sub: plan.category_sub || [],
          temporal_tags: plan.temporal_tags || [],
          category_main: plan.category_main || '',
          timestamp: plan.created_at,
          location: plan.location_coordinates || plan.location_text,
          is_active: plan.is_live,
          interaction_count: plan.interaction_count,
          joins_count: plan.joins_count ?? 0,
          is_repost: false,
          cannot_be_reposted: isReposted,
          type: plan.type || 'regular',
          _rankingScore: plan._rankingScore,
          is_women_only: !!plan.is_women_only,
        };
        if (plan.type === 'business') {
          item.ticket_image = plan.ticket_image || null;
          item.passes = plan.passes || [];
          item.location_text = plan.location_text;
          item.date = plan.date;
          item.time = plan.time;
          item.add_details = plan.add_details || [];
        }
        return item;
      });
    
    // Format reposts as separate feed items
    const repostFeed = rankedReposts
      .slice(0, Math.floor(safeLimit * 0.3)) // 30% of feed can be reposts
      .map(plan => {
        const repost = plan._repostData;
        const item = {
          post_id: repost.repost_id,
          user_id: repost.repost_author_id,
          title: repost.repost_title || plan.title,
          description: repost.repost_description || plan.description,
          media: plan.media,
          tags: plan.category_sub,
          category_sub: plan.category_sub || [],
          temporal_tags: plan.temporal_tags || [],
          category_main: plan.category_main || '',
          timestamp: repost.created_at,
          location: plan.location_coordinates || plan.location_text,
          is_active: plan.is_live,
          interaction_count: plan.interaction_count,
          joins_count: plan.joins_count ?? 0,
          is_repost: true,
          type: plan.type || 'regular',
          is_women_only: !!plan.is_women_only,
          repost_data: {
            repost_id: repost.repost_id,
            added_content: repost.added_content,
            repost_title: repost.repost_title,
            repost_description: repost.repost_description,
            original_plan_id: repost.original_plan_id,
            original_author_id: plan.user_id,
            cannot_be_reposted: repost.cannot_be_reposted
          },
          _rankingScore: plan._rankingScore
        };
        if (plan.type === 'business') {
          item.ticket_image = plan.ticket_image || null;
          item.passes = plan.passes || [];
          item.location_text = plan.location_text;
          item.date = plan.date;
          item.time = plan.time;
          item.add_details = plan.add_details || [];
        }
        return item;
      });
    
    // Combine regular feed and reposts, maintaining ranking order
    // Interleave reposts into regular feed based on ranking scores
    const combinedFeed = [...regularFeed, ...repostFeed];
    combinedFeed.sort((a, b) => {
      // Sort by ranking score if available, otherwise by timestamp
      if (a._rankingScore !== undefined && b._rankingScore !== undefined) {
        return b._rankingScore - a._rankingScore;
      }
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    
    // Remove ranking scores from final output (optional, for cleaner API response)
    let finalFeed = combinedFeed.slice(0, safeLimit).map(item => {
      const { _rankingScore, ...rest } = item;
      return rest;
    });

    // Up to 3 recent interactors with avatars for feed card stack (matches GuestListModal / getJoinedUsers)
    const planIdsForPreview = [
      ...new Set(
        finalFeed
          .filter((item) => (item.interaction_count || 0) > 0)
          .map((item) => item.post_id),
      ),
    ];

    if (planIdsForPreview.length > 0) {
      const interactions = await PlanInteraction.find({
        plan_id: { $in: planIdsForPreview },
        status: { $in: ['pending', 'approved'] },
      })
        .sort({ created_at: -1 })
        .select('plan_id user_id')
        .lean();

      const planToUserIds = new Map();
      for (const row of interactions) {
        const pid = row.plan_id;
        if (!planToUserIds.has(pid)) planToUserIds.set(pid, []);
        const arr = planToUserIds.get(pid);
        if (arr.length >= 3) continue;
        if (arr.includes(row.user_id)) continue;
        arr.push(row.user_id);
      }

      const allPreviewUserIds = [...new Set([].concat(...[...planToUserIds.values()]))];
      let userById = new Map();
      if (allPreviewUserIds.length > 0) {
        const users = await User.find({ user_id: { $in: allPreviewUserIds } })
          .select('user_id name profile_image')
          .lean();
        userById = new Map(users.map((u) => [u.user_id, u]));
      }

      finalFeed = finalFeed.map((item) => {
        const uids = planToUserIds.get(item.post_id);
        if (!uids || uids.length === 0) return item;
        const interacted_users = uids.map((uid) => {
          const u = userById.get(uid);
          return {
            user_id: uid,
            id: uid,
            name: u?.name || 'User',
            profile_image: u?.profile_image || null,
          };
        });
        return { ...item, interacted_users };
      });
    }

    return sendSuccess(res, 'Feed retrieved successfully', finalFeed);
  } catch (error) {
    console.error('Error in getHomeFeed:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Refresh feed
 */
exports.refreshFeed = async (req, res) => {
  try {
    const { user_id } = req.query;
    
    // Get new posts from last 24 hours
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const plans = await BasePlan.find({
      post_status: 'published',
      is_live: true,
      is_draft: false,
      created_at: { $gte: yesterday }
    })
      .sort({ created_at: -1 })
      .limit(20);
    
    const feed = plans.map(plan => ({
      post_id: plan.plan_id,
      user_id: plan.user_id,
      title: plan.title,
      description: plan.description,
      media: plan.media,
      tags: plan.category_sub,
      category_sub: plan.category_sub || [],
      temporal_tags: plan.temporal_tags || [],
      timestamp: plan.created_at,
      location: plan.location_coordinates || plan.location_text,
      is_active: plan.is_live,
      interaction_count: plan.interaction_count,
      type: plan.type || 'regular' // Include plan type (business or regular)
    }));
    
    return sendSuccess(res, 'Feed refreshed successfully', feed);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get single post
 */
exports.getPost = async (req, res) => {
  try {
    const { post_id } = req.params;
    const { user_id } = req.query;
    const plan = await BasePlan.findOne({ plan_id: post_id });
    
    if (!plan) {
      return sendError(res, 'Post not found', 404);
    }

    // Optional block filter (only when caller provides user_id)
    if (user_id) {
      const blocks = await UserBlock.find({
        $or: [
          { blocker_id: user_id, blocked_user_id: plan.user_id },
          { blocker_id: plan.user_id, blocked_user_id: user_id }
        ]
      }).lean();
      if (blocks.length > 0) {
        return sendError(res, 'Post not available', 403);
      }
    }
    
    // Increment views
    plan.views_count += 1;
    await plan.save();
    
    return sendSuccess(res, 'Post retrieved successfully', plan);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

