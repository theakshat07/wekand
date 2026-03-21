const { User, UserSession, DeviceToken } = require('../models');
const { BasePlan, RegularPlan, SavedPlan, Repost } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');

/**
 * Get current user profile
 */
exports.getMe = async (req, res) => {
  try {
    const { session_id } = req.query;
    const session = await UserSession.findOne({ session_id });
    
    if (!session || !session.user_id) {
      return sendError(res, 'User not found', 404);
    }
    
    const user = await User.findOne({ user_id: session.user_id }).lean();
    if (!user) {
      return sendError(res, 'User not found', 404);
    }

    const profile = {
      user_id: user.user_id,
      name: user.name,
      profile_image: user.profile_image,
      phone_number: user.phone_number || null,
      bio: user.bio,
      age_range: user.age_range ?? null,
      gender: user.gender,
      interests: user.interests || [],
      is_business: user.is_business,
      business_id: user.business_id,
      social_media: user.social_media || {},
      eula_accepted_at: user.eula_accepted_at ?? null,
      eula_version: user.eula_version ?? null,
    };
    return sendSuccess(res, 'Profile retrieved successfully', profile);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get user profile by ID (public)
 */
exports.getUserProfile = async (req, res) => {
  try {
    const { user_id } = req.params;
    const user = await User.findOne({ user_id });
    
    if (!user) {
      return sendError(res, 'User not found', 404);
    }
    
    // Get user's recent plans (limit 5)
    const recentPlans = await BasePlan.find({
      user_id,
      deleted_at: null,
      is_draft: false
    })
    .sort({ created_at: -1 })
    .limit(5)
    .lean();
    
    // Return public profile (exclude sensitive data)
    const profile = {
      user_id: user.user_id,
      name: user.name,
      profile_image: user.profile_image,
      bio: user.bio,
      age_range: user.age_range ?? null,
      gender: user.gender,
      is_business: user.is_business,
      interests: user.interests || [],
      social_media: user.social_media || {},
      created_at: user.created_at,
      recent_plans: recentPlans.map(plan => ({
        plan_id: plan.plan_id,
        title: plan.title,
        description: plan.description,
        media: plan.media || [],
        category_sub: plan.category_sub || [],
        created_at: plan.created_at
      }))
    };
    
    return sendSuccess(res, 'Profile retrieved successfully', profile);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Update user profile
 */
exports.updateProfile = async (req, res) => {
  try {
    const { session_id } = req.body;
    const { name, profile_image, bio, gender, is_business, age_range, eula_version, accept_eula } = req.body;
    
    const session = await UserSession.findOne({ session_id });
    if (!session || !session.user_id) {
      return sendError(res, 'Session not found', 404);
    }
    
    const user = await User.findOne({ user_id: session.user_id });
    if (!user) {
      return sendError(res, 'User not found', 404);
    }
    
    if (name !== undefined) user.name = name;
    if (profile_image !== undefined) user.profile_image = profile_image;
    if (bio !== undefined) user.bio = bio;
    if (age_range !== undefined) user.age_range = age_range;
    if (gender !== undefined) user.gender = gender;
    if (accept_eula === true) {
      user.eula_accepted_at = new Date();
      user.eula_version = eula_version || user.eula_version || null;
    }
    if (is_business !== undefined) user.is_business = !!is_business;
    if (req.body.interests !== undefined) user.interests = req.body.interests;
    if (req.body.social_media !== undefined) {
      const sm = req.body.social_media;
      const current = user.social_media && typeof user.social_media === 'object' ? { ...user.social_media } : {};
      user.social_media = {
        ...current,
        ...(sm.instagram !== undefined && { instagram: sm.instagram }),
        ...(sm.twitter !== undefined && { twitter: sm.twitter }),
        ...(sm.x !== undefined && { x: sm.x }),
        ...(sm.facebook !== undefined && { facebook: sm.facebook }),
        ...(sm.snapchat !== undefined && { snapchat: sm.snapchat }),
        ...(sm.google_drive !== undefined && { google_drive: sm.google_drive }),
        ...(sm.whatsapp !== undefined && { whatsapp: sm.whatsapp }),
        ...(sm.strava !== undefined && { strava: sm.strava }),
      };
    }
    
    await user.save();
    
    return sendSuccess(res, 'Profile updated successfully', user);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Delete user account
 */
exports.deleteUser = async (req, res) => {
  try {
    const { session_id } = req.body;
    const session = await UserSession.findOne({ session_id });
    
    if (!session || !session.user_id) {
      return sendError(res, 'Session not found', 404);
    }
    
    // Soft delete - mark as deleted
    await User.updateOne(
      { user_id: session.user_id },
      { $set: { deleted_at: new Date() } }
    );
    
    return sendSuccess(res, 'User deleted successfully');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get user stats (plans count, interactions count)
 */
exports.getUserStats = async (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return sendError(res, 'User ID is required', 400);
    }
    
    // Count user's plans (regular plans only, not deleted)
    const plansCount = await BasePlan.countDocuments({
      user_id,
      deleted_at: null,
      is_draft: false
    });
    
    // Count interactions (reactions, comments, join requests)
    // For now, we'll use a simple count - you can expand this later
    const interactionsCount = await BasePlan.countDocuments({
      user_id,
      deleted_at: null,
      is_draft: false
    });
    
    return sendSuccess(res, 'Stats retrieved successfully', {
      plans_count: plansCount,
      interactions_count: interactionsCount
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get user's plans
 */
exports.getUserPlans = async (req, res) => {
  try {
    const { user_id, limit = 20, offset = 0 } = req.query;
    
    if (!user_id) {
      return sendError(res, 'User ID is required', 400);
    }
    
    const plans = await BasePlan.find({
      user_id,
      deleted_at: null,
      is_draft: false
    })
    .sort({ created_at: -1 })
    .limit(parseInt(limit))
    .skip(parseInt(offset))
    .lean();
    
    // Get reposts by this user
    const reposts = await Repost.find({
      repost_author_id: user_id
    })
    .sort({ created_at: -1 })
    .limit(parseInt(limit))
    .skip(parseInt(offset))
    .lean();
    
    // Combine and sort
    const allPlans = [...plans.map(p => ({ ...p, is_repost: false })), ...reposts.map(r => ({ ...r, is_repost: true }))];
    allPlans.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    return sendSuccess(res, 'Plans retrieved successfully', allPlans.slice(0, parseInt(limit)));
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get saved posts
 */
exports.getSavedPosts = async (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return sendError(res, 'User ID is required', 400);
    }
    
    const saved = await SavedPlan.find({ user_id, is_active: true })
      .sort({ saved_at: -1 });
    
    const postIds = saved.map(s => s.plan_id);
    const plans = await BasePlan.find({ plan_id: { $in: postIds } });
    
    // Create a map of saved_at timestamps
    const savedAtMap = {};
    saved.forEach(s => {
      savedAtMap[s.plan_id] = s.saved_at;
    });
    
    const formattedPosts = plans.map(plan => ({
      post_id: plan.plan_id,
      user_id: plan.user_id,
      title: plan.title,
      description: plan.description,
      media: plan.media,
      tags: [...(plan.category_sub || []), ...(plan.temporal_tags || [])],
      timestamp: plan.created_at || plan.posted_at,
      saved_at: savedAtMap[plan.plan_id],
      location: plan.location_coordinates || plan.location_text,
      is_active: plan.is_live,
      interaction_count: plan.interaction_count,
      type: plan.type || 'regular'
    }));
    
    return sendSuccess(res, 'Saved posts retrieved successfully', formattedPosts);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Register device token
 */
exports.registerDeviceToken = async (req, res) => {
  try {
    const { device_id, push_token, platform, session_id } = req.body;
    
    if (!['ios', 'android', 'web'].includes(platform)) {
      return sendError(res, 'Invalid platform', 400);
    }
    
    let user_id = null;
    if (session_id) {
      const session = await UserSession.findOne({ session_id });
      if (session) user_id = session.user_id;
    }
    
    const deviceToken = await DeviceToken.findOneAndUpdate(
      { device_id },
      {
        device_id,
        user_id,
        push_token,
        platform,
        last_active: new Date(),
        opt_in: true
      },
      { upsert: true, new: true }
    );
    
    return sendSuccess(res, 'Device token registered successfully', deviceToken);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;
