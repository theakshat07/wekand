const { UserReport } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');

/**
 * Report user (reporter is always the authenticated user — body reporter_id is ignored)
 */
exports.reportUser = async (req, res) => {
  try {
    const reporter_id = req.user?.user_id || req.user?.id;
    const { reported_user_id, reason, post_id, message } = req.body;

    if (!reporter_id) {
      return sendError(res, 'Unauthorized', 401);
    }
    if (!reported_user_id) {
      return sendError(res, 'reported_user_id is required', 400);
    }
    const reasonStr = (reason && String(reason).trim()) || '';
    if (!reasonStr) {
      return sendError(res, 'reason is required', 400);
    }
    if (String(reported_user_id) === String(reporter_id)) {
      return sendError(res, 'You cannot report yourself', 400);
    }

    const msg = message && String(message).trim() ? String(message).trim().slice(0, 2000) : null;

    const report = await UserReport.create({
      report_id: generateId('report'),
      reporter_id,
      reported_user_id,
      reason: reasonStr.slice(0, 500),
      plan_id: post_id || null,
      message: msg,
      status: 'pending',
    });

    return sendSuccess(res, 'User reported successfully', {
      report_id: report.report_id,
      status: report.status,
    }, 201);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get reports list (admin only)
 */
exports.getReports = async (req, res) => {
  try {
    const { admin_key } = req.query;
    
    // In production, verify admin key
    if (admin_key !== process.env.ADMIN_KEY) {
      return sendError(res, 'Unauthorized', 401);
    }
    
    const reports = await UserReport.find({})
      .sort({ created_at: -1 });
    
    return sendSuccess(res, 'Reports retrieved successfully', reports);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

