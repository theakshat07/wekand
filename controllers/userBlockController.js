const { UserBlock, User } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');

function getCurrentUserId(req) {
  return req.user?.user_id || req.user?.id;
}

exports.blockUser = async (req, res) => {
  try {
    const blocker_id = getCurrentUserId(req);
    const { blocked_user_id, reason } = req.body;

    if (!blocker_id) return sendError(res, 'Unauthorized', 401);
    if (!blocked_user_id) return sendError(res, 'blocked_user_id is required', 400);
    if (String(blocked_user_id) === String(blocker_id)) return sendError(res, 'You cannot block yourself', 400);

    const block = await UserBlock.findOneAndUpdate(
      { blocker_id, blocked_user_id },
      {
        $setOnInsert: {
          block_id: generateId('block'),
          blocker_id,
          blocked_user_id,
          created_at: new Date(),
        },
        $set: {
          reason: reason || null,
        },
      },
      { upsert: true, new: true }
    );

    return sendSuccess(res, 'User blocked successfully', {
      block_id: block.block_id,
      blocker_id: block.blocker_id,
      blocked_user_id: block.blocked_user_id,
      created_at: block.created_at,
    }, 201);
  } catch (error) {
    if (error?.code === 11000) {
      return sendSuccess(res, 'User already blocked', {}, 200);
    }
    return sendError(res, error.message, 500);
  }
};

exports.unblockUser = async (req, res) => {
  try {
    const blocker_id = getCurrentUserId(req);
    const { blocked_user_id } = req.body;

    if (!blocker_id) return sendError(res, 'Unauthorized', 401);
    if (!blocked_user_id) return sendError(res, 'blocked_user_id is required', 400);

    await UserBlock.deleteOne({ blocker_id, blocked_user_id });
    return sendSuccess(res, 'User unblocked successfully', {});
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

exports.listBlockedUsers = async (req, res) => {
  try {
    const blocker_id = getCurrentUserId(req);
    if (!blocker_id) return sendError(res, 'Unauthorized', 401);

    const blocks = await UserBlock.find({ blocker_id })
      .sort({ created_at: -1 })
      .lean();

    const blockedIds = blocks.map((b) => b.blocked_user_id).filter(Boolean);
    const users =
      blockedIds.length > 0
        ? await User.find({ user_id: { $in: blockedIds } })
            .select('user_id name profile_image')
            .lean()
        : [];
    const userById = new Map(users.map((u) => [String(u.user_id), u]));

    return sendSuccess(res, 'Blocked users retrieved successfully', {
      blocked_users: blocks.map((b) => {
        const u = userById.get(String(b.blocked_user_id));
        return {
          blocked_user_id: b.blocked_user_id,
          created_at: b.created_at,
          reason: b.reason || null,
          user: u
            ? {
                user_id: u.user_id,
                name: u.name || 'User',
                profile_image: u.profile_image || null,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;
