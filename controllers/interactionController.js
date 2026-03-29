const { PlanInteraction, BasePlan, Notification, Repost } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');
const { createGeneralNotification } = require('./notificationController');

/**
 * Add comment
 */
exports.addComment = async (req, res) => {
  try {
    const { post_id, user_id, text } = req.body;
    
    const interaction = await PlanInteraction.create({
      interaction_id: generateId('interaction'),
      plan_id: post_id,
      user_id,
      interaction_type: 'comment',
      text,
      status: 'approved'
    });
    
    await BasePlan.updateOne(
      { plan_id: post_id },
      { $inc: { interaction_count: 1 } }
    );
    
    // Create notification for post author(s)
    const plan = await BasePlan.findOne({ plan_id: post_id });
    if (plan && plan.user_id !== user_id) {
      // Check if this is a repost
      const repost = await Repost.findOne({ original_plan_id: post_id });
      
      if (repost) {
        // This is a repost - notify both the repost author and original author
        // Notify repost author
        if (repost.repost_author_id !== user_id) {
          await createGeneralNotification(repost.repost_author_id, 'comment', {
            source_plan_id: post_id,
            source_user_id: user_id,
            payload: { comment_id: interaction.interaction_id, text, is_repost: true, cta_type: interaction.interaction_id },
          });
        }
        
        // Notify original author
        const originalPlan = await BasePlan.findOne({ plan_id: repost.original_plan_id });
        if (originalPlan && originalPlan.user_id !== user_id && originalPlan.user_id !== repost.repost_author_id) {
          await createGeneralNotification(originalPlan.user_id, 'comment', {
            source_plan_id: repost.original_plan_id,
            source_user_id: user_id,
            payload: { comment_id: interaction.interaction_id, text, is_repost: true, repost_id: repost.repost_id, cta_type: interaction.interaction_id },
          });
        }
      } else {
        // Regular post - notify only the post author
        await createGeneralNotification(plan.user_id, 'comment', {
          source_plan_id: post_id,
          source_user_id: user_id,
          payload: { comment_id: interaction.interaction_id, text, cta_type: interaction.interaction_id },
        });
      }
    }
    
    return sendSuccess(res, 'Comment added successfully', { comment_id: interaction.interaction_id }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get comments
 */
exports.getComments = async (req, res) => {
  try {
    const { post_id } = req.params;
    const comments = await PlanInteraction.find({
      plan_id: post_id,
      interaction_type: 'comment'
    }).sort({ created_at: -1 });
    
    return sendSuccess(res, 'Comments retrieved successfully', comments);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Delete comment
 */
exports.deleteComment = async (req, res) => {
  try {
    const { comment_id } = req.params;
    const interaction = await PlanInteraction.findOne({ interaction_id: comment_id });
    
    if (!interaction) {
      return sendError(res, 'Comment not found', 404);
    }
    
    await PlanInteraction.deleteOne({ interaction_id: comment_id });
    
    await BasePlan.updateOne(
      { plan_id: interaction.plan_id },
      { $inc: { interaction_count: -1 } }
    );
    
    return sendSuccess(res, 'Comment deleted successfully');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Add reaction
 */
exports.addReaction = async (req, res) => {
  try {
    const { post_id, user_id, emoji_type } = req.body;
    
    // Check if user already reacted
    const existing = await PlanInteraction.findOne({
      plan_id: post_id,
      user_id,
      interaction_type: 'reaction'
    });
    
    if (existing) {
      existing.emoji_type = emoji_type;
      await existing.save();
      return sendSuccess(res, 'Reaction updated successfully');
    }
    
    const interaction = await PlanInteraction.create({
      interaction_id: generateId('interaction'),
      plan_id: post_id,
      user_id,
      interaction_type: 'reaction',
      emoji_type,
      status: 'approved'
    });
    
    await BasePlan.updateOne(
      { plan_id: post_id },
      { $inc: { interaction_count: 1 } }
    );
    
    // Create notification for post author(s)
    const plan = await BasePlan.findOne({ plan_id: post_id });
    if (plan && plan.user_id !== user_id) {
      // Check if this is a repost
      const repost = await Repost.findOne({ original_plan_id: post_id });
      
      if (repost) {
        // This is a repost - notify both the repost author and original author
        // Notify repost author
        if (repost.repost_author_id !== user_id) {
          await createGeneralNotification(repost.repost_author_id, 'reaction', {
            source_plan_id: post_id,
            source_user_id: user_id,
            payload: { emoji_type, is_repost: true, cta_type: interaction.interaction_id },
          });
        }
        
        // Notify original author
        const originalPlan = await BasePlan.findOne({ plan_id: repost.original_plan_id });
        if (originalPlan && originalPlan.user_id !== user_id && originalPlan.user_id !== repost.repost_author_id) {
          await createGeneralNotification(originalPlan.user_id, 'reaction', {
            source_plan_id: repost.original_plan_id,
            source_user_id: user_id,
            payload: { emoji_type, is_repost: true, repost_id: repost.repost_id, cta_type: interaction.interaction_id },
          });
        }
      } else {
        // Regular post - notify only the post author
        await createGeneralNotification(plan.user_id, 'reaction', {
          source_plan_id: post_id,
          source_user_id: user_id,
          payload: { emoji_type, cta_type: interaction.interaction_id },
        });
      }
    }
    
    return sendSuccess(res, 'Reaction added successfully');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get reactions
 */
exports.getReactions = async (req, res) => {
  try {
    const { post_id } = req.params;
    const reactions = await PlanInteraction.find({
      plan_id: post_id,
      interaction_type: 'reaction'
    }).sort({ created_at: -1 });
    
    return sendSuccess(res, 'Reactions retrieved successfully', reactions);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Create join request
 */
exports.createJoinRequest = async (req, res) => {
  try {
    const { post_id, user_id, message } = req.body;
    
    const interaction = await PlanInteraction.create({
      interaction_id: generateId('interaction'),
      plan_id: post_id,
      user_id,
      interaction_type: 'join',
      message: message || null,
      status: 'pending'
    });
    
    await BasePlan.updateOne(
      { plan_id: post_id },
      { $inc: { interaction_count: 1 } }
    );
    
    // Create notification for post author
    const plan = await BasePlan.findOne({ plan_id: post_id });
    if (plan && plan.user_id !== user_id) {
      await createGeneralNotification(plan.user_id, 'join', {
        source_plan_id: post_id,
        source_user_id: user_id,
        payload: { request_id: interaction.interaction_id, message: message || null, cta_type: interaction.interaction_id },
      });
    }
    
    return sendSuccess(res, 'Join request created successfully', { request_id: interaction.interaction_id }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Create join request with reaction (pending approval)
 */
exports.createJoinRequestWithReaction = async (req, res) => {
  try {
    const { post_id, user_id, emoji_type } = req.body;
    
    // Validate required fields
    if (!post_id) {
      return sendError(res, 'post_id is required', 400);
    }
    if (!user_id) {
      return sendError(res, 'user_id is required', 400);
    }
    if (!emoji_type) {
      return sendError(res, 'emoji_type is required', 400);
    }
    
    // Check if user already has pending interaction
    const existing = await PlanInteraction.findOne({
      plan_id: post_id,
      user_id,
      status: 'pending'
    });
    
    if (existing) {
      // Update existing interaction
      existing.interaction_type = 'reaction';
      existing.emoji_type = emoji_type;
      await existing.save();
      
      return sendSuccess(res, 'Interest updated successfully', { request_id: existing.interaction_id });
    }
    
    const interaction = await PlanInteraction.create({
      interaction_id: generateId('interaction'),
      plan_id: post_id,
      user_id,
      interaction_type: 'reaction',
      emoji_type,
      status: 'pending' // Pending approval
    });
    
    await BasePlan.updateOne(
      { plan_id: post_id },
      { $inc: { interaction_count: 1 } }
    );
    
    // Create notification for post author
    const plan = await BasePlan.findOne({ plan_id: post_id });
    if (plan && plan.user_id !== user_id) {
      await createGeneralNotification(plan.user_id, 'reaction', {
        source_plan_id: post_id,
        source_user_id: user_id,
        payload: { request_id: interaction.interaction_id, emoji_type, cta_type: interaction.interaction_id },
      });
    }
    
    return sendSuccess(res, 'Interest sent successfully', { request_id: interaction.interaction_id }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Create join request with comment (pending approval)
 */
exports.createJoinRequestWithComment = async (req, res) => {
  try {
    const { post_id, user_id, text } = req.body;
    
    // Validate required fields
    if (!post_id) {
      console.error('❌ Missing post_id in request body:', req.body);
      return sendError(res, 'post_id is required', 400);
    }
    if (!user_id) {
      console.error('❌ Missing user_id in request body:', req.body);
      return sendError(res, 'user_id is required', 400);
    }
    if (!text || !text.trim()) {
      return sendError(res, 'text is required', 400);
    }
    
    console.log('✅ Creating join request with comment:', { post_id, user_id, text: text.substring(0, 50) });
    
    // Check if user already has pending interaction
    const existing = await PlanInteraction.findOne({
      plan_id: post_id,
      user_id,
      status: 'pending'
    });
    
    if (existing) {
      // Update existing interaction
      existing.interaction_type = 'comment';
      existing.text = text;
      existing.emoji_type = null; // Clear emoji if it was a reaction before
      await existing.save();
      
      // Update notification payload
      await Notification.updateOne(
        { source_plan_id: post_id, source_user_id: user_id, type: 'join', 'payload.request_id': existing.interaction_id },
        { $set: { payload: { request_id: existing.interaction_id, text: text } } }
      );
      
      return sendSuccess(res, 'Interest updated successfully', { request_id: existing.interaction_id });
    }
    
    const interaction = await PlanInteraction.create({
      interaction_id: generateId('interaction'),
      plan_id: post_id,
      user_id,
      interaction_type: 'comment',
      text,
      status: 'pending' // Pending approval
    });
    
    // Check if post_id is a repost_id first
    let repost = await Repost.findOne({ repost_id: post_id });
    let plan = null;
    let originalPlan = null;
    
    if (repost) {
      // This post_id is a repost_id, update the original plan's interaction count
      await BasePlan.updateOne(
        { plan_id: repost.original_plan_id },
        { $inc: { interaction_count: 1 } }
      );
      originalPlan = await BasePlan.findOne({ plan_id: repost.original_plan_id });
      plan = originalPlan;
    } else {
      // Regular post
      await BasePlan.updateOne(
        { plan_id: post_id },
        { $inc: { interaction_count: 1 } }
      );
      plan = await BasePlan.findOne({ plan_id: post_id });
      if (plan) {
        repost = await Repost.findOne({ original_plan_id: post_id });
      }
    }
    
    if (plan && plan.user_id !== user_id) {
      // Check if this is a repost
      if (repost) {
        // This is a repost - notify both the repost author and original author
        // Notify repost author
        if (repost.repost_author_id !== user_id) {
          await createGeneralNotification(repost.repost_author_id, 'comment', {
            source_plan_id: repost.repost_id, // Use repost_id as source
            source_user_id: user_id,
            payload: { request_id: interaction.interaction_id, text, is_repost: true, cta_type: interaction.interaction_id },
          });
        }
        
        // Notify original author
        if (originalPlan && originalPlan.user_id !== user_id && originalPlan.user_id !== repost.repost_author_id) {
          await createGeneralNotification(originalPlan.user_id, 'comment', {
            source_plan_id: repost.original_plan_id,
            source_user_id: user_id,
            payload: { request_id: interaction.interaction_id, text, is_repost: true, repost_id: repost.repost_id, cta_type: interaction.interaction_id },
          });
        }
      } else {
        // Regular post - notify only the post author
        await createGeneralNotification(plan.user_id, 'comment', {
          source_plan_id: post_id,
          source_user_id: user_id,
          payload: { request_id: interaction.interaction_id, text, cta_type: interaction.interaction_id },
        });
      }
    }
    
    return sendSuccess(res, 'Interest sent successfully', { request_id: interaction.interaction_id }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get join requests (author only) - includes all pending interactions (join, reaction, comment)
 */
exports.getJoinRequests = async (req, res) => {
  try {
    const { post_id } = req.params;
    const requests = await PlanInteraction.find({
      plan_id: post_id,
      status: 'pending' // Get all pending interactions (join, reaction, comment)
    }).sort({ created_at: -1 });
    
    return sendSuccess(res, 'Join requests retrieved successfully', requests);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Approve join request
 */
exports.approveJoinRequest = async (req, res) => {
  try {
    const { request_id } = req.body;
    
    if (!request_id) {
      return sendError(res, 'request_id is required', 400);
    }
    
    const interaction = await PlanInteraction.findOne({ interaction_id: request_id });
    
    if (!interaction) {
      console.error('❌ Interaction not found:', request_id);
      return sendError(res, 'Join request not found', 404);
    }
    
    // Accept join requests that are reactions, comments, or explicit join requests
    // All of these can be pending join requests that need approval
    if (interaction.status !== 'pending') {
      return sendError(res, 'Request is not pending', 400);
    }
    
    interaction.status = 'approved';
    await interaction.save();
    
    // Get plan to find the author
    const plan = await BasePlan.findOne({ plan_id: interaction.plan_id });
    const authorId = plan?.user_id;
    
    // Update notification payload to reflect approved status (for author)
    await Notification.updateOne(
      { 
        source_plan_id: interaction.plan_id, 
        source_user_id: interaction.user_id,
        'payload.request_id': request_id
      },
      { 
        $set: { 
          'payload.status': 'approved',
          'payload.request_id': request_id
        } 
      }
    );
    
    // Create notification for the requester (user whose request was approved)
    if (authorId && interaction.user_id !== authorId) {
      const { User } = require('../models');
      const author = await User.findOne({ user_id: authorId }).lean();
      
      await createGeneralNotification(interaction.user_id, 'join', {
        source_plan_id: interaction.plan_id,
        source_user_id: authorId,
        payload: {
          request_id: interaction.interaction_id,
          status: 'approved',
          message: `Your request to join "${plan?.title || 'the plan'}" has been approved!`,
          cta_type: interaction.interaction_id,
        },
      });
    }
    
    // Create individual chat (1-on-1) between author and requester
    if (authorId && interaction.user_id !== authorId) {
      const { ChatGroup } = require('../models');
      
      // Check if individual chat already exists for this plan
      const existingChat = await ChatGroup.findOne({
        plan_id: interaction.plan_id,
        members: { $all: [authorId, interaction.user_id], $size: 2 }
      });
      
      if (!existingChat) {
        // Create individual chat group (2 members = 1-on-1)
        const individualChat = await ChatGroup.create({
          group_id: generateId('group'),
          plan_id: interaction.plan_id,
          created_by: authorId,
          members: [authorId, interaction.user_id],
          is_announcement_group: false,
          group_name: null // Individual chats don't have names
        });
        
        console.log('✅ Created individual chat:', individualChat.group_id);
      }
    }
    
    await BasePlan.updateOne(
      { plan_id: interaction.plan_id },
      { $inc: { approved_count: 1, joins_count: 1 } }
    );
    
    return sendSuccess(res, 'Join request approved successfully', { 
      interaction_id: interaction.interaction_id,
      chat_created: true
    });
  } catch (error) {
    console.error('❌ Error approving join request:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Reject join request (works for join, reaction, and comment interactions)
 */
exports.rejectJoinRequest = async (req, res) => {
  try {
    const { request_id } = req.body;
    
    if (!request_id) {
      return sendError(res, 'request_id is required', 400);
    }
    
    const interaction = await PlanInteraction.findOne({ interaction_id: request_id });
    
    if (!interaction) {
      console.error('❌ Interaction not found:', request_id);
      return sendError(res, 'Request not found', 404);
    }
    
    if (interaction.status === 'rejected') {
      return sendError(res, 'Request already rejected', 400);
    }
    
    if (interaction.status !== 'pending') {
      return sendError(res, 'Request is not pending', 400);
    }
    
    interaction.status = 'rejected';
    await interaction.save();
    
    // Update notification payload to reflect rejected status
    await Notification.updateOne(
      { 
        source_plan_id: interaction.plan_id, 
        source_user_id: interaction.user_id,
        'payload.request_id': request_id
      },
      { 
        $set: { 
          'payload.status': 'rejected',
          'payload.request_id': request_id
        } 
      }
    );
    
    return sendSuccess(res, 'Request rejected successfully', { interaction_id: interaction.interaction_id });
  } catch (error) {
    console.error('❌ Error rejecting join request:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get joined users for a regular plan (users who joined/reacted/commented – pending or approved).
 * Public endpoint – returns list of users for guest list modal.
 */
exports.getJoinedUsers = async (req, res) => {
  try {
    const { plan_id } = req.params;
    const { BasePlan, User } = require('../models');

    const plan = await BasePlan.findOne({ plan_id }).lean();
    if (!plan) {
      return sendError(res, 'Post not found', 404);
    }
    if (plan.type === 'business') {
      return sendError(res, 'Use /ticket/guest-list for business events', 400);
    }

    const interactions = await PlanInteraction.find({
      plan_id,
      status: { $in: ['pending', 'approved'] },
    })
      .sort({ created_at: -1 })
      .lean();

    const userIds = [...new Set(interactions.map((i) => i.user_id))];
    const guestList = await Promise.all(
      userIds.map(async (uid) => {
        const user = await User.findOne({ user_id: uid }).lean();
        return {
          user_id: uid,
          name: user?.name || 'Unknown',
          profile_image: user?.profile_image || null,
          bio: user?.bio || '',
        };
      })
    );

    return sendSuccess(res, 'Joined users retrieved successfully', {
      guests: guestList,
      total: guestList.length,
    });
  } catch (error) {
    console.error('Error in getJoinedUsers:', error);
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

