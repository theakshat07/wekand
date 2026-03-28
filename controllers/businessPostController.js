const { BusinessPlan, ChatGroup, ChatMessage, BasePlan, Registration } = require('../models');
const CategoryTag = require('../models/other/CategoryTag');
const { sendSuccess, sendError, generateId } = require('../utils');
const { uploadImage, uploadVideo } = require('../config/cloudinary');
const { cleanupFile } = require('../middleware/upload');
const { refundPaidTicketsForPlan } = require('./ticketController');
const { createGeneralNotification } = require('./notificationController');

// req.files from multer.fields() is an object { files: [...], ticket_image: [...] }, not an array
function getAllFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  if (typeof files === 'object') return Object.values(files).flat().filter(Boolean);
  return [];
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  return val != null ? [val] : [];
}

/**
 * Create business post
 * Supports both file uploads and URL-based media
 */
exports.createBusinessPost = async (req, res) => {
  try {
    let media = [];
    let ticketImageUrl = null;
    
    // Handle post media file uploads if present (req.files.files can be array or single file)
    const postMediaFiles = ensureArray(req.files?.files);
    if (postMediaFiles.length > 0) {
      const uploadPromises = postMediaFiles.map(async (file) => {
        try {
          const isVideo = file.mimetype.startsWith('video/');
          const result = isVideo 
            ? await uploadVideo(file) 
            : await uploadImage(file);
          
          cleanupFile(file.path);
          
          return {
            url: result.url,
            type: isVideo ? 'video' : 'image',
            size: result.bytes
          };
        } catch (error) {
          cleanupFile(file.path);
          throw error;
        }
      });
      
      media = await Promise.all(uploadPromises);
    } else if (req.body.media && Array.isArray(req.body.media)) {
      // Use provided media URLs
      media = req.body.media;
    }
    
    // Handle ticket image upload if present
    const ticketImageFiles = ensureArray(req.files?.ticket_image);
    const ticketImageFile = ticketImageFiles[0];
    if (ticketImageFile) {
      try {
        const result = await uploadImage(ticketImageFile, 'vybeme/tickets');
        ticketImageUrl = result.url;
        cleanupFile(ticketImageFile.path);
      } catch (error) {
        cleanupFile(ticketImageFile.path);
        // Don't fail the whole request if ticket image upload fails
        console.error('Ticket image upload failed:', error);
      }
    } else if (req.body.ticket_image) {
      // Use provided ticket image URL
      ticketImageUrl = req.body.ticket_image;
    }
    
    const body = { ...req.body };
    if (typeof body.category_sub === 'string') {
      try { body.category_sub = JSON.parse(body.category_sub); } catch (_) { body.category_sub = []; }
    }
    if (!Array.isArray(body.category_sub)) body.category_sub = [];

    // FormData sends all fields as strings; passes and add_details must be arrays of objects for Mongoose
    if (typeof body.passes === 'string') {
      try { body.passes = JSON.parse(body.passes); } catch (_) { body.passes = []; }
    }
    if (!Array.isArray(body.passes)) body.passes = [];
    if (typeof body.add_details === 'string') {
      try { body.add_details = JSON.parse(body.add_details); } catch (_) { body.add_details = []; }
    }
    if (!Array.isArray(body.add_details)) body.add_details = [];

    // FormData may send form_id as string; ignore empty / literal "undefined"
    if (body.form_id !== undefined && body.form_id !== null) {
      const fid = String(body.form_id).trim();
      if (fid === '' || fid === 'undefined' || fid === 'null') {
        delete body.form_id;
      } else {
        body.form_id = fid;
      }
    }

    const planData = {
      plan_id: generateId('plan'),
      ...body,
      media: media,
      media_count: media.length,
      ticket_image: ticketImageUrl,
      type: 'business',
      post_status: 'published',
      posted_at: new Date()
    };
    
    delete planData.files;
    
    const plan = await BusinessPlan.create(planData);

    // Category logic (main + sub) – same as normal plan posts: ensure CategoryTag exists
    if (body.category_main) {
      const mainCategory = String(body.category_main).toLowerCase().trim();
      const subTags = Array.isArray(body.category_sub)
        ? body.category_sub.map((s) => String(s).toLowerCase().trim())
        : [];
      let categoryDoc = await CategoryTag.findOne({ tag_name: mainCategory });
      if (!categoryDoc) {
        await CategoryTag.create({
          tag_id: generateId('cat'),
          tag_name: mainCategory,
          sub_tags: subTags.map((sub) => ({
            sub_tag_id: generateId('sub'),
            sub_tag_name: sub,
          })),
        });
      } else if (subTags.length > 0) {
        const existingSubs = categoryDoc.sub_tags.map((s) => s.sub_tag_name);
        const newSubs = subTags
          .filter((sub) => !existingSubs.includes(sub))
          .map((sub) => ({ sub_tag_id: generateId('sub'), sub_tag_name: sub }));
        if (newSubs.length > 0) {
          categoryDoc.sub_tags.push(...newSubs);
          await categoryDoc.save();
        }
      }
    }
    
    // Event-specific group: one per plan; group_id stored on plan; all registrants get added; everyone can text
    try {
      const organiserId = String(plan.user_id || plan.business_id || '').trim();
      if (!organiserId) {
        console.warn('⚠️ Skipping event group: plan has no user_id/business_id', plan.plan_id);
      } else {
      const driveDetail = (plan.add_details || []).find((d) => d.detail_type === 'google_drive_link');
      const driveLinkFromPlan = driveDetail ? ((driveDetail.description || driveDetail.title || '').trim() || null) : null;
      const groupData = {
        group_id: generateId('group'),
        plan_id: plan.plan_id,
        created_by: organiserId,
        members: [organiserId],
        is_announcement_group: false,
        group_name: plan.title || `Event: ${plan.plan_id}`,
        ...(driveLinkFromPlan ? { drive_link: driveLinkFromPlan } : {})
      };
      
      console.log(`🔍 Creating group with data:`, JSON.stringify(groupData, null, 2));
      
      const group = await ChatGroup.create(groupData);
      
      // Verify group was created and saved
      const verifyGroup = await ChatGroup.findOne({ group_id: group.group_id }).lean();
      if (!verifyGroup) {
        console.error(`❌ Group ${group.group_id} was not saved to database!`);
      } else {
        console.log(`✅ Verified group exists in database: ${verifyGroup.group_id}`);
        console.log(`   - Members in DB: [${(verifyGroup.members || []).join(', ')}]`);
      }
      
      // Update plan with group_id - use updateOne to ensure it's saved
      const updateResult = await BusinessPlan.updateOne(
        { plan_id: plan.plan_id },
        { $set: { group_id: group.group_id } }
      );
      
      console.log(`🔍 Update result:`, updateResult);
      
      // Verify the update worked and refresh the plan object
      const updatedPlan = await BusinessPlan.findOne({ plan_id: plan.plan_id });
      if (!updatedPlan || !updatedPlan.group_id) {
        console.error(`❌ Failed to save group_id to plan! Update result:`, updateResult);
        console.error(`   - Updated plan group_id: ${updatedPlan?.group_id || 'null'}`);
        // Try direct assignment as fallback
        plan.group_id = group.group_id;
        const saveResult = await plan.save();
        console.log(`   - Attempted fallback save, result:`, saveResult);
        
        // Verify again after fallback
        const recheckPlan = await BusinessPlan.findOne({ plan_id: plan.plan_id }).lean();
        console.log(`   - Recheck after fallback: group_id = ${recheckPlan?.group_id || 'null'}`);
      } else {
        console.log(`✅ Saved group_id ${group.group_id} to plan ${plan.plan_id}`);
        // Update the plan object in memory
        plan.group_id = updatedPlan.group_id;
      }
      
      console.log(`✅ Auto-created group ${group.group_id} for business plan ${plan.plan_id}`);
      console.log(`   - Group name: "${group.group_name}"`);
      console.log(`   - Plan user_id: ${plan.user_id}`);
      console.log(`   - Group members: [${(group.members || []).join(', ')}]`);
      // No automated message on group creation
      }
    } catch (groupError) {
      console.error('⚠️ Failed to auto-create group for business plan:', groupError);
      console.error('   Error details:', groupError.message);
      console.error('   Stack:', groupError.stack);
      // Continue even if group creation fails - don't block post creation
    }
    
    // Notify business user: Post Live
    if (plan.user_id && plan.title) {
      await createGeneralNotification(plan.user_id, 'post_live', {
        source_plan_id: plan.plan_id,
        source_user_id: 'system',
        payload: {
          event_title: plan.title,
          cta_type: 'go_to_event',
          notification_text: `${plan.title} is Live`
        }
      });
    }

    // Get the final plan with group_id to ensure we return the correct data
    const finalPlan = await BusinessPlan.findOne({ plan_id: plan.plan_id }).lean();
    
    return sendSuccess(res, 'Business post created successfully', { 
      post_id: plan.plan_id,
      group_id: finalPlan?.group_id || plan.group_id || null
    }, 201);
  } catch (error) {
    const allFiles = getAllFiles(req.files);
    allFiles.forEach((file) => file && file.path && cleanupFile(file.path));
    return sendError(res, error.message, 500);
  }
};

/**
 * Update business post
 * Supports file uploads for media updates
 */
exports.updateBusinessPost = async (req, res) => {
  try {
    const { post_id } = req.params;
    const updateData = { ...req.body };
    if (typeof updateData.category_sub === 'string') {
      try { updateData.category_sub = JSON.parse(updateData.category_sub); } catch (_) { updateData.category_sub = []; }
    }
    if (updateData.category_sub && !Array.isArray(updateData.category_sub)) updateData.category_sub = [];
    if (typeof updateData.passes === 'string') {
      try { updateData.passes = JSON.parse(updateData.passes); } catch (_) { updateData.passes = []; }
    }
    if (updateData.passes !== undefined && !Array.isArray(updateData.passes)) updateData.passes = [];
    if (typeof updateData.add_details === 'string') {
      try { updateData.add_details = JSON.parse(updateData.add_details); } catch (_) { updateData.add_details = []; }
    }
    if (updateData.add_details !== undefined && !Array.isArray(updateData.add_details)) updateData.add_details = [];
    if (typeof updateData.media === 'string') {
      try { updateData.media = JSON.parse(updateData.media); } catch (_) { updateData.media = []; }
    }
    if (updateData.media !== undefined && !Array.isArray(updateData.media)) updateData.media = [];
    if (updateData.form_id !== undefined && updateData.form_id !== null) {
      const fid = String(updateData.form_id).trim();
      if (fid === '' || fid === 'undefined' || fid === 'null') {
        updateData.form_id = null;
      } else {
        updateData.form_id = fid;
      }
    }

    const plan = await BusinessPlan.findOne({ plan_id: post_id }).lean();
    if (!plan) {
      return sendError(res, 'Business post not found', 404);
    }

    // Post media: client sends a manifest in `media` (JSON array) with { url, type } for existing
    // CDN images and { url: null, type } for each new local file, plus multipart `files` only for locals.
    // Never append uploads to existing DB media (that duplicated the same image on every save).
    const postMediaFiles = ensureArray(req.files?.files);
    let uploadedMedia = [];
    if (postMediaFiles.length > 0) {
      const uploadPromises = postMediaFiles.map(async (file) => {
        try {
          const isVideo = file.mimetype.startsWith('video/');
          const result = isVideo ? await uploadVideo(file) : await uploadImage(file);
          cleanupFile(file.path);
          return {
            url: result.url,
            type: isVideo ? 'video' : 'image',
            size: result.bytes,
          };
        } catch (error) {
          cleanupFile(file.path);
          throw error;
        }
      });
      uploadedMedia = await Promise.all(uploadPromises);
    }

    const manifest = Array.isArray(updateData.media) ? updateData.media : null;
    const hasNullSlot =
      manifest &&
      manifest.some(
        (m) =>
          m &&
          typeof m === 'object' &&
          (m.url === null || m.url === undefined || String(m.url).trim() === ''),
      );

    if (uploadedMedia.length > 0) {
      if (manifest && manifest.length > 0 && hasNullSlot) {
        let ui = 0;
        updateData.media = manifest
          .map((slot) => {
            if (!slot || typeof slot !== 'object') return null;
            const rawUrl = slot.url;
            const hasUrl =
              rawUrl !== null &&
              rawUrl !== undefined &&
              String(rawUrl).trim() !== '';
            if (hasUrl) {
              return {
                url: String(rawUrl).trim(),
                type: slot.type || 'image',
                size: slot.size,
              };
            }
            const up = uploadedMedia[ui++];
            return up || null;
          })
          .filter(Boolean);
        if (ui !== uploadedMedia.length) {
          console.warn(
            `[businessPost] Media manifest / upload count mismatch for ${post_id}: expected ${uploadedMedia.length} uploads, used ${ui}`,
          );
        }
      } else if (manifest && manifest.length > 0 && !hasNullSlot) {
        // Old clients: manifest is all URLs but files were still sent — keep URLs only (no duplicate uploads)
        updateData.media = manifest
          .filter((m) => m && m.url && String(m.url).trim())
          .map((m) => ({
            url: String(m.url).trim(),
            type: m.type || 'image',
            size: m.size,
          }));
      } else {
        updateData.media = uploadedMedia;
      }
      updateData.media_count = Array.isArray(updateData.media) ? updateData.media.length : 0;
    } else if (manifest && Array.isArray(manifest)) {
      updateData.media = manifest
        .filter((m) => m && m.url && String(m.url).trim())
        .map((m) => ({
          url: String(m.url).trim(),
          type: m.type || 'image',
          size: m.size,
        }));
      updateData.media_count = updateData.media.length;
    }
    
    // Handle ticket image upload if present
    const ticketImageFiles = ensureArray(req.files?.ticket_image);
    const ticketImageFile = ticketImageFiles[0];
    if (ticketImageFile) {
      try {
        const result = await uploadImage(ticketImageFile, 'vybeme/tickets');
        updateData.ticket_image = result.url;
        cleanupFile(ticketImageFile.path);
      } catch (error) {
        cleanupFile(ticketImageFile.path);
        console.error('Ticket image upload failed:', error);
      }
    }

    // If organiser updated event media but didn't explicitly set ticket_image,
    // keep tickets in sync by using the latest image from the updated media.
    if (req.body.ticket_image === undefined && !ticketImageFile && Array.isArray(updateData.media) && updateData.media.length > 0) {
      const lastImage = [...updateData.media]
        .reverse()
        .find((m) => m && typeof m === 'object' && (m.url || m.url === '') && (String(m.type || 'image').toLowerCase() === 'image'));
      if (lastImage?.url) {
        updateData.ticket_image = lastImage.url;
      }
    }

    // Category logic (main + sub) – sync with CategoryTag like normal plans
    if (updateData.category_main) {
      const mainCategory = String(updateData.category_main).toLowerCase().trim();
      const subTags = Array.isArray(updateData.category_sub)
        ? updateData.category_sub.map((s) => String(s).toLowerCase().trim())
        : [];
      let categoryDoc = await CategoryTag.findOne({ tag_name: mainCategory });
      if (!categoryDoc) {
        await CategoryTag.create({
          tag_id: generateId('cat'),
          tag_name: mainCategory,
          sub_tags: subTags.map((sub) => ({ sub_tag_id: generateId('sub'), sub_tag_name: sub })),
        });
      } else if (subTags.length > 0) {
        const existingSubs = categoryDoc.sub_tags.map((s) => s.sub_tag_name);
        const newSubs = subTags.filter((sub) => !existingSubs.includes(sub)).map((sub) => ({ sub_tag_id: generateId('sub'), sub_tag_name: sub }));
        if (newSubs.length > 0) {
          categoryDoc.sub_tags.push(...newSubs);
          await categoryDoc.save();
        }
      }
    }

    if (req.body.ticket_image !== undefined && !ticketImageFile) {
      // Allow updating ticket image URL directly
      updateData.ticket_image = req.body.ticket_image;
    }

    delete updateData.files;

    const wasDeleted = updateData.post_status === 'deleted';
    const refundPaidTickets = req.body.refund_paid_tickets === true || req.body.refund_paid_tickets === 'true';

    const sanitized = {};
    Object.keys(updateData).forEach((k) => {
      if (updateData[k] !== undefined) sanitized[k] = updateData[k];
    });

    await BusinessPlan.updateOne({ plan_id: post_id }, { $set: sanitized });

    const planAfter = await BusinessPlan.findOne({ plan_id: post_id }).lean();
    if (!planAfter) {
      return sendError(res, 'Business post not found after update', 404);
    }

    // Only when event is explicitly CANCELLED (refund_paid_tickets: true), refund paid tickets.
    // When event is just DELETED (e.g. after event is done), do not refund.
    if (wasDeleted && refundPaidTickets && planAfter.plan_id) {
      refundPaidTicketsForPlan(planAfter.plan_id)
        .then((result) => {
          if (result.refunded > 0 || result.failed > 0) {
            console.log(`[businessPost] Auto-refund on cancel plan ${planAfter.plan_id}: refunded=${result.refunded}, failed=${result.failed}`);
          }
        })
        .catch((err) => console.error('[businessPost] Auto-refund on cancel failed:', err.message));
    }

    // Event cancelled: notify owner (business user) and all registrants (regular users)
    if (wasDeleted && planAfter.plan_id && planAfter.title) {
      const notifType = refundPaidTickets ? 'paid_event_cancelled' : 'free_event_cancelled';
      const notifTextOwner = refundPaidTickets
        ? `${planAfter.title} is cancelled. Refunds are processed`
        : `${planAfter.title} is cancelled.`;
      const notifTextUser = refundPaidTickets
        ? `${planAfter.title} is cancelled. Your refund is processed`
        : `${planAfter.title} is cancelled.`;

      if (planAfter.user_id) {
        await createGeneralNotification(planAfter.user_id, notifType, {
          source_plan_id: planAfter.plan_id,
          source_user_id: 'system',
          payload: { event_title: planAfter.title, cta_type: 'go_to_event', notification_text: notifTextOwner }
        });
      }
      const registrations = await Registration.find({ plan_id: planAfter.plan_id, status: { $in: ['pending', 'approved'] } }).select('user_id').lean();
      for (const reg of registrations) {
        if (reg.user_id && reg.user_id !== planAfter.user_id) {
          await createGeneralNotification(reg.user_id, notifType, {
            source_plan_id: planAfter.plan_id,
            source_user_id: 'system',
            payload: { event_title: planAfter.title, cta_type: 'go_to_event', notification_text: notifTextUser }
          });
        }
      }
    }

    return sendSuccess(res, 'Business post updated successfully', planAfter);
  } catch (error) {
    const allFiles = getAllFiles(req.files);
    allFiles.forEach((file) => file && file.path && cleanupFile(file.path));
    return sendError(res, error.message, 500);
  }
};

/**
 * Get business post details
 */
exports.getBusinessPostDetails = async (req, res) => {
  try {
    const { post_id } = req.params;
    const plan = await BusinessPlan.findOne({ plan_id: post_id });
    
    if (!plan) {
      return sendError(res, 'Business post not found', 404);
    }
    
    return sendSuccess(res, 'Business post retrieved successfully', plan);
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Get registration analytics (count from Registration collection for accuracy)
 */
exports.getRegistrations = async (req, res) => {
  try {
    const { post_id } = req.params;
    const plan = await BusinessPlan.findOne({ plan_id: post_id });
    
    if (!plan) {
      return sendError(res, 'Business post not found', 404);
    }

    const { Registration } = require('../models');
    const total = await Registration.countDocuments({
      plan_id: post_id,
      status: { $in: ['pending', 'approved'] }
    });
    const approved = await Registration.countDocuments({ plan_id: post_id, status: 'approved' });
    const rejected = await Registration.countDocuments({ plan_id: post_id, status: 'rejected' });
    
    return sendSuccess(res, 'Registration analytics retrieved successfully', {
      total_registrations: total,
      approved_registrations: approved,
      rejected_registrations: rejected
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Export CSV
 */
exports.exportCSV = async (req, res) => {
  try {
    const { post_id } = req.params;
    const plan = await BusinessPlan.findOne({ plan_id: post_id });
    
    if (!plan) {
      return sendError(res, 'Business post not found', 404);
    }
    
    // In production, generate CSV and upload to storage
    const csvUrl = plan.csv_export_url || `https://storage.example.com/csv/${post_id}.csv`;
    
    return sendSuccess(res, 'CSV export URL generated', {
      csv_export_url: csvUrl
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

module.exports = exports;

