const { Repost, BasePlan } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');
const { createGeneralNotification } = require('./notificationController');

/**
 * Create repost
 */
exports.createRepost = async (req, res) => {
  try {
    const { original_plan_id, added_content, repost_author_id, repost_title, repost_description } = req.body;
    
    if (!original_plan_id || !repost_author_id) {
      return sendError(res, 'original_plan_id and repost_author_id are required', 400);
    }
    
    // Check if original post exists (must be a BasePlan, not a repost_id)
    const originalPlan = await BasePlan.findOne({ plan_id: original_plan_id });
    if (!originalPlan) {
      return sendError(res, 'Original post not found', 404);
    }
    
    // Allow multiple reposts of the same plan (each user can repost). Only block if this plan_id
    // were a repost record id - but reposts don't create new plans, so original_plan_id is always a real plan.
    
    const repost = await Repost.create({
      repost_id: generateId('repost'),
      original_plan_id,
      repost_author_id,
      added_content: added_content || '',
      repost_title: repost_title || '',
      repost_description: repost_description || '',
      cannot_be_reposted: true
    });
    
    // Increment repost count on original plan
    await BasePlan.updateOne(
      { plan_id: original_plan_id },
      { $inc: { reposts_count: 1 } }
    );
    
    // Create notification for original post author
    if (originalPlan.user_id !== repost_author_id) {
      await createGeneralNotification(originalPlan.user_id, 'repost', {
        source_plan_id: original_plan_id,
        source_user_id: repost_author_id,
        payload: {
          repost_id: repost.repost_id,
          added_content,
          repost_title,
          repost_description,
          cta_type: repost.repost_id,
        },
      });
    }
    
    return sendSuccess(res, 'Repost created successfully', { repost_id: repost.repost_id }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get repost details
 */
exports.getRepostDetails = async (req, res) => {
  try {
    const { repost_id } = req.params;
    const repost = await Repost.findOne({ repost_id });
    
    if (!repost) {
      return sendError(res, 'Repost not found', 404);
    }
    
    return sendSuccess(res, 'Repost retrieved successfully', repost);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get user reposts
 */
exports.getUserReposts = async (req, res) => {
  try {
    const { user_id } = req.params;
    const reposts = await Repost.find({ repost_author_id: user_id })
      .sort({ created_at: -1 });
    
    return sendSuccess(res, 'Reposts retrieved successfully', reposts);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Check if can repost
 */
exports.checkRepostRules = async (req, res) => {
  try {
    const { original_post_id } = req.body;
    
    const originalRepost = await Repost.findOne({ original_plan_id: original_post_id });
    const canRepost = !originalRepost;
    
    return sendSuccess(res, 'Repost rules checked', { can_repost: canRepost });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

