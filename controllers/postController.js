const { BasePlan, RegularPlan, CategoryTag } = require("../models");
const { sendSuccess, sendError, generateId } = require("../utils");
const { uploadImage, uploadVideo } = require("../config/cloudinary");
const { cleanupFile } = require("../middleware/upload");

/**
 * Create regular post
 * Supports both file uploads and URL-based media
 */
exports.createPost = async (req, res) => {
  try {
    let media = [];

    // Handle file uploads if present
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        try {
          const isVideo = file.mimetype.startsWith("video/");
          const result = isVideo
            ? await uploadVideo(file)
            : await uploadImage(file);

          cleanupFile(file.path);

          return {
            url: result.url,
            type: isVideo ? "video" : "image",
            size: result.bytes,
          };
        } catch (error) {
          cleanupFile(file.path);
          throw error;
        }
      });

      media = await Promise.all(uploadPromises);
    } else if (req.body.media && Array.isArray(req.body.media)) {
      media = req.body.media;
    }

    const planData = {
      plan_id: generateId("plan"),
      ...req.body,
      media: media,
      media_count: media.length,
      type: "regular",
      post_status: "published",
      posted_at: new Date(),
    };

    delete planData.files;

    // ✅ CREATE POST
    const plan = await RegularPlan.create(planData);

    // ✅ CATEGORY LOGIC (MAIN + SUB)
    if (req.body.category_main) {
      const mainCategory = req.body.category_main.toLowerCase().trim();

      let categoryDoc = await CategoryTag.findOne({
        tag_name: mainCategory,
      });

      // If main category does NOT exist → create it
      if (!categoryDoc) {
        await CategoryTag.create({
          tag_id: generateId("cat"),
          tag_name: mainCategory,
          sub_tags: Array.isArray(req.body.category_sub)
            ? req.body.category_sub.map((sub) => ({
                sub_tag_id: generateId("sub"),
                sub_tag_name: sub.toLowerCase().trim(),
              }))
            : [],
        });
      }
      // If main category exists → add missing sub-tags
      else if (Array.isArray(req.body.category_sub)) {
        const existingSubs = categoryDoc.sub_tags.map(
          (sub) => sub.sub_tag_name
        );

        const newSubs = req.body.category_sub
          .map((sub) => sub.toLowerCase().trim())
          .filter((sub) => !existingSubs.includes(sub))
          .map((sub) => ({
            sub_tag_id: generateId("sub"),
            sub_tag_name: sub,
          }));

        if (newSubs.length > 0) {
          categoryDoc.sub_tags.push(...newSubs);
          await categoryDoc.save();
        }
      }
    }

    return sendSuccess(
      res,
      "Post created successfully",
      { post_id: plan.plan_id },
      201
    );
  } catch (error) {
    if (req.files) {
      req.files.forEach((file) => cleanupFile(file.path));
    }
    return sendError(res, error.message, 500);
  }
};

/**
 * Update regular post
 * Supports file uploads for media updates
 */
exports.updatePost = async (req, res) => {
  try {
    const { post_id } = req.params;
    const updateData = { ...req.body };

    const plan = await RegularPlan.findOne({ plan_id: post_id });
    if (!plan) {
      return sendError(res, "Post not found", 404);
    }

    // Handle file uploads if present
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        try {
          const isVideo = file.mimetype.startsWith("video/");
          const result = isVideo
            ? await uploadVideo(file)
            : await uploadImage(file);

          cleanupFile(file.path);

          return {
            url: result.url,
            type: isVideo ? "video" : "image",
            size: result.bytes,
          };
        } catch (error) {
          cleanupFile(file.path);
          throw error;
        }
      });

      const newMedia = await Promise.all(uploadPromises);
      updateData.media = [...(plan.media || []), ...newMedia];
      updateData.media_count = updateData.media.length;
    }

    // Remove files from update data
    delete updateData.files;

    Object.assign(plan, updateData);
    await plan.save();

    return sendSuccess(res, "Post updated successfully", plan);
  } catch (error) {
    // Cleanup any remaining files
    if (req.files) {
      req.files.forEach((file) => cleanupFile(file.path));
    }
    return sendError(res, error.message, 500);
  }
};

/**
 * Delete regular post
 */
exports.deletePost = async (req, res) => {
  try {
    const { post_id } = req.params;

    const plan = await BasePlan.findOne({ plan_id: post_id });
    if (!plan) {
      return sendError(res, "Post not found", 404);
    }

    // Archive: keep row and all related data; do not set deleted_at (used for feed/notification hydration).
    plan.post_status = "deleted";
    plan.deleted_at = null;
    await plan.save();

    return sendSuccess(res, "Post deleted successfully");
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get post details
 */
exports.getPostDetails = async (req, res) => {
  try {
    const { post_id } = req.params;
    const plan = await BasePlan.findOne({ plan_id: post_id });

    if (!plan) {
      return sendError(res, "Post not found", 404);
    }

    return sendSuccess(res, "Post retrieved successfully", plan);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get post analytics
 */
exports.getPostAnalytics = async (req, res) => {
  try {
    const { post_id } = req.params;
    const plan = await BasePlan.findOne({ plan_id: post_id });

    if (!plan) {
      return sendError(res, "Post not found", 404);
    }

    return sendSuccess(res, "Analytics retrieved successfully", {
      views_count: plan.views_count,
      joins_count: plan.joins_count,
      reposts_count: plan.reposts_count,
      shares_count: plan.shares_count,
      chat_message_count: plan.chat_message_count,
      unique_users_interacted: plan.unique_users_interacted,
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;
