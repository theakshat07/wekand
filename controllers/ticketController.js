const crypto = require('crypto');
const config = require('../config');
const { Ticket, Registration, BusinessPlan, User, ChatGroup, Notification, PaymentOrder } = require('../models');
const { sendSuccess, sendError, generateId } = require('../utils');
const {
  addMemberToChatGroupIfNeeded,
  postMemberAddedSystemMessage,
} = require('../services/chatGroupMemberNotifications');

/**
 * Generate human-readable ticket number: OwnerFirstName01, OwnerFirstName02, …
 * Uses the plan's ticket_sequence (atomic update) to guarantee per-event sequencing.
 */
async function generateTicketNumber(plan) {
  const ownerId = plan.user_id || plan.business_id;
  let firstName = 'GUEST';
  if (ownerId) {
    const owner = await User.findOne({ user_id: ownerId }).select('name').lean();
    if (owner && owner.name) {
      const letters = owner.name.trim().split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');
      if (letters) firstName = letters;
    }
  }
  const prefix = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  const planId = plan.plan_id;
  // Backfill-safe seed for old plans that don't have ticket_sequence yet.
  if (plan.ticket_sequence == null) {
    const existingTickets = await Ticket.countDocuments({ plan_id: planId });
    await BusinessPlan.updateOne(
      { plan_id: planId, ticket_sequence: { $exists: false } },
      { $set: { ticket_sequence: existingTickets } }
    );
    await BusinessPlan.updateOne(
      { plan_id: planId, ticket_sequence: null },
      { $set: { ticket_sequence: existingTickets } }
    );
  }

  // Atomic increment: guarantees sequential unique number per event.
  const updated = await BusinessPlan.findOneAndUpdate(
    { plan_id: planId },
    { $inc: { ticket_sequence: 1 } },
    { new: true }
  );
  if (!updated || updated.ticket_sequence == null) {
    throw new Error('Failed to allocate ticket sequence for plan');
  }
  const seq = updated.ticket_sequence;
  const seqStr = seq < 100 ? String(seq).padStart(2, '0') : String(seq);
  return `${prefix}${seqStr}`;
}

/**
 * Human-readable check-in code: "BREATHE 01", "BREATHE 02", …
 * Prefix = organizer’s first name (letters only, max 12), rank = monotonic per plan via atomic $inc
 * (countDocuments+1 would collide when two users register at the same time).
 */
async function generateOrganizerCheckinCode(plan) {
  const planId = plan.plan_id;
  const ownerId = plan.user_id || plan.business_id;
  let firstWord = 'Guest';
  if (ownerId) {
    const owner = await User.findOne({ user_id: ownerId }).lean();
    if (owner && owner.name) {
      firstWord = owner.name.trim().split(/\s+/)[0] || firstWord;
    }
  }
  const lettersOnly = String(firstWord).replace(/[^a-zA-Z]/g, '');
  const prefix = (lettersOnly.length ? lettersOnly : 'GUEST').slice(0, 12).toUpperCase();

  if (plan.checkin_sequence == null) {
    const existingCount = await Registration.countDocuments({
      plan_id: planId,
      status: { $in: ['pending', 'approved'] },
    });
    await BusinessPlan.updateOne(
      { plan_id: planId, checkin_sequence: { $exists: false } },
      { $set: { checkin_sequence: existingCount } }
    );
    await BusinessPlan.updateOne(
      { plan_id: planId, checkin_sequence: null },
      { $set: { checkin_sequence: existingCount } }
    );
  }

  // Atomic increment: guarantees sequential unique code per event.
  const updated = await BusinessPlan.findOneAndUpdate(
    { plan_id: planId },
    { $inc: { checkin_sequence: 1 } },
    { new: true }
  );
  if (!updated || updated.checkin_sequence == null) {
    throw new Error('Failed to allocate check-in sequence for plan');
  }
  const rank = updated.checkin_sequence;
  const rankStr = rank < 100 ? String(rank).padStart(2, '0') : String(rank);
  return `${prefix} ${rankStr}`;
}

/**
 * Generate QR code data and hash
 */
function generateQRCodeData(ticketId, planId, userId) {
  // Create a secure, unique QR code payload
  const payload = {
    ticket_id: ticketId,
    plan_id: planId,
    user_id: userId,
    timestamp: Date.now()
  };
  
  const qrData = JSON.stringify(payload);
  const qrHash = crypto.createHash('sha256').update(qrData).digest('hex');
  
  return { qrData, qrHash };
}

/**
 * Register for business event and generate ticket
 */
exports.registerForEvent = async (req, res) => {
  try {
    const { plan_id, user_id, pass_id, message, age_range, gender, running_experience, what_brings_you } = req.body;
    
    if (!plan_id || !user_id) {
      return sendError(res, 'plan_id and user_id are required', 400);
    }
    
    // Check if plan exists and is a business plan
    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) {
      return sendError(res, 'Business plan not found', 404);
    }
    
    if (plan.type !== 'business') {
      return sendError(res, 'This endpoint is only for business plans', 400);
    }

    if (plan.post_status === 'completed' || plan.post_status === 'expired') {
      return sendError(res, 'Registration is closed for this event.', 400);
    }

    if (plan.is_women_only) {
      const registeringUser = await User.findOne({ user_id }).lean();
      const profileGender = (registeringUser?.gender || '').toLowerCase();
      if (profileGender !== 'female') {
        return sendError(res, 'Only women can register for this event', 403);
      }
    }

    // Business user cannot register for their own plan
    const planOwnerId = plan.user_id || plan.business_id;
    if (planOwnerId && planOwnerId === user_id) {
      return sendError(res, 'You cannot register for your own event', 403);
    }

    // One registration per user per plan. If a registration already exists but
    // the caller has provided survey fields we treat this as an update rather
    // than an error. This lets the front‑end show a post‑registration form for
    // paid events and attach the answers after the payment flow completes.
    const existing = await Registration.findOne({ plan_id, user_id }).lean();
    if (existing) {
      const hasSurvey = age_range || gender || running_experience || what_brings_you;
      if (hasSurvey) {
        await Registration.updateOne(
          { plan_id, user_id },
          {
            age_range: age_range || existing.age_range || null,
            gender: gender || existing.gender || null,
            running_experience: running_experience || existing.running_experience || null,
            what_brings_you: what_brings_you || existing.what_brings_you || null,
          }
        );
        // return the existing ticket/registration so client can proceed
        const ticket = await Ticket.findOne({ plan_id, user_id }).lean();
        return sendSuccess(res, 'Registration updated', { registration: existing, ticket: ticket || null });
      }
      return sendError(res, 'You have already registered for this event', 400);
    }

    // Get registration count (needed for checkin code generation)
    let registrationCount = await Registration.countDocuments({
      plan_id,
      status: { $in: ['pending', 'approved'] }
    });
    
    // Check registration limit if set
    if (plan.registration_limit && registrationCount >= plan.registration_limit) {
      return sendError(res, `This event has reached its capacity (${plan.registration_limit} attendees). No more registrations are allowed.`, 400);
    }

    let checkinCode = null;
    try {
      checkinCode = await generateOrganizerCheckinCode(plan);
    } catch (codeError) {
      console.error('Failed to generate checkin code:', codeError);
    }

    // Get pass details if pass_id provided
    let pricePaid = 0;
    let selectedPass = null;
    if (pass_id && plan.passes && plan.passes.length > 0) {
      selectedPass = plan.passes.find(p => p.pass_id === pass_id);
      if (selectedPass) {
        pricePaid = selectedPass.price;
        if (pricePaid > 0) {
          return sendError(res, 'Paid tickets require payment. Please complete payment on the event page.', 400);
        }
      }
    }

    // Generate ticket
    const ticketId = generateId('ticket');
    const ticketNumber = await generateTicketNumber(plan);
    const { qrData, qrHash } = generateQRCodeData(ticketId, plan_id, user_id);
    
    // Create ticket
    const ticket = await Ticket.create({
      ticket_id: ticketId,
      plan_id,
      user_id,
      pass_id: pass_id || null,
      qr_code: qrData,
      qr_code_hash: qrHash,
      ticket_number: ticketNumber,
      status: 'active',
      price_paid: pricePaid
    });
    
    // Create registration (with optional survey: age_range, gender, running_experience, what_brings_you)
    const registration = await Registration.create({
      registration_id: generateId('registration'),
      plan_id,
      user_id,
      pass_id: pass_id || null,
      ticket_id: ticketId,
      checkin_code: checkinCode,
      status: plan.registration_required ? 'pending' : 'approved',
      price_paid: pricePaid,
      message: message || null,
      age_range: age_range || null,
      gender: gender || null,
      running_experience: running_experience || null,
      what_brings_you: what_brings_you || null
    });
    
    // Update plan registration counts
    if (registration.status === 'approved') {
      await BusinessPlan.updateOne(
        { plan_id },
        { $inc: { approved_registrations: 1 } }
      );
    }
    
    // Add user to this event's group (plan.group_id = event-specific group; everyone can chat)
    if (plan.group_id) {
      try {
        const group = await ChatGroup.findOne({ group_id: plan.group_id });
        if (!group) {
          console.error(`⚠️ Group ${plan.group_id} not found for business plan ${plan_id}`);
        } else {
          console.log(`🔍 Group found: ${group.group_id}, current members: [${(group.members || []).join(', ')}]`);
          const { added } = await addMemberToChatGroupIfNeeded(group, user_id);
          if (added) {
            const verifyGroup = await ChatGroup.findOne({ group_id: plan.group_id }).lean();
            console.log(`✅ Added user ${user_id} to group ${plan.group_id} for business plan ${plan_id}`);
            console.log(`   - Verified in DB: members=[${(verifyGroup?.members || []).join(', ')}]`);
          } else {
            console.log(`ℹ️ User ${user_id} is already a member of group ${plan.group_id}`);
          }
        }
      } catch (groupError) {
        console.error('⚠️ Failed to add user to group:', groupError);
        // Continue even if adding to group fails - don't block registration
      }
    } else {
      // Fallback: create event group and save group_id to plan (for plans created before auto-create)
      console.error(`⚠️ Business plan ${plan_id} has no group_id - creating event group now`);
      try {
        const { ChatGroup } = require('../models');
        const { generateId } = require('../utils');
        
        const newGroup = await ChatGroup.create({
          group_id: generateId('group'),
          plan_id: plan.plan_id,
          created_by: plan.user_id,
          members: [plan.user_id, user_id], // Add both business owner and registering user
          is_announcement_group: false,
          group_name: plan.title || `Event: ${plan.plan_id}`
        });
        
        // Update plan with group_id
        await BusinessPlan.updateOne(
          { plan_id: plan.plan_id },
          { $set: { group_id: newGroup.group_id } }
        );
        plan.group_id = newGroup.group_id;
        await postMemberAddedSystemMessage(newGroup.group_id, user_id);

        console.log(`✅ Created missing group ${newGroup.group_id} for business plan ${plan_id}`);
        console.log(`   - Added user ${user_id} to the new group`);
      } catch (fallbackError) {
        console.error('⚠️ Failed to create fallback group:', fallbackError);
      }
    }
    
    // Get user details for response
    const user = await User.findOne({ user_id }).lean();

    // Notify registrant (regular user): Registration Successful
    const { createGeneralNotification } = require('./notificationController');
    if (plan.title) {
      await createGeneralNotification(user_id, 'registration_successful', {
        source_plan_id: plan_id,
        source_user_id: 'system',
        payload: {
          event_title: plan.title,
          cta_type: 'go_to_ticket',
          notification_text: `Booking Successful for ${plan.title}`,
          ticket_id: ticketId
        }
      });
    }

    // Notify plan/business owner when someone registers (unless they're notifying themselves)
    const ownerId = plan.user_id || plan.business_id;
    if (ownerId && ownerId !== user_id) {
      try {
        await Notification.create({
          notification_id: generateId('notification'),
          user_id: ownerId,
          type: 'join',
          source_plan_id: plan_id,
          source_user_id: user_id,
          payload: {
            registration_id: registration.registration_id,
            ticket_id: ticketId,
            plan_title: plan.title,
            message: user?.name ? `${user.name} registered for your event "${plan.title}".` : 'Someone registered for your event.',
          },
          is_read: false,
        });
      } catch (notifErr) {
        console.error('Failed to create registration notification:', notifErr);
      }
    }

    // Get plan details for ticket display (include group_id for "Go to chat")
    const planDetails = {
      plan_id: plan.plan_id,
      title: plan.title || '',
      description: plan.description || '',
      location_text: plan.location_text || null,
      date: plan.date || null,
      time: plan.time || null,
      media: plan.media || [],
      ticket_image: plan.ticket_image || null,
      passes: plan.passes || [],
      category_main: plan.category_main || null,
      category_sub: plan.category_sub || [],
      group_id: plan.group_id || null,
    };

    return sendSuccess(res, 'Registration successful', {
      registration: {
        ...registration.toObject(),
        user: user ? {
          user_id: user.user_id,
          name: user.name,
          profile_image: user.profile_image
        } : null
      },
      ticket: {
        ticket_id: ticket.ticket_id,
        ticket_number: ticket.ticket_number,
        qr_code: ticket.qr_code, // Frontend will generate QR image from this
        qr_code_hash: ticket.qr_code_hash,
        status: ticket.status,
        price_paid: ticket.price_paid,
        plan: planDetails,
        user: user ? {
          user_id: user.user_id,
          name: user.name,
          profile_image: user.profile_image
        } : null
      }
    }, 201);
  } catch (error) {
    console.error('Error registering for event:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get all tickets for a user (for profile / tickets & passes)
 */
exports.getTicketsByUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    if (!user_id) {
      return sendError(res, 'user_id is required', 400);
    }
    if (req.user && req.user.user_id && req.user.user_id !== user_id) {
      return sendError(res, 'You can only view your own tickets', 403);
    }

    const tickets = await Ticket.find({ user_id })
      .sort({ created_at: -1 })
      .lean();

    const planIds = [...new Set(tickets.map((t) => t.plan_id))];
    const plans = await BusinessPlan.find({ plan_id: { $in: planIds } }).lean();
    const planMap = plans.reduce((acc, p) => {
      acc[p.plan_id] = {
        plan_id: p.plan_id,
        title: p.title,
        description: p.description,
        location_text: p.location_text,
        date: p.date,
        time: p.time,
        media: p.media,
        ticket_image: p.ticket_image || null,
        post_status: p.post_status || null,
        passes: p.passes || [],
        add_details: p.add_details || [],
        category_main: p.category_main || null,
        category_sub: p.category_sub || [],
        group_id: p.group_id || null,
      };
      return acc;
    }, {});

    const registrations = await Registration.find({
      user_id,
      ticket_id: { $in: tickets.map((t) => t.ticket_id) },
    }).lean();
    const regByTicket = registrations.reduce((acc, r) => {
      acc[r.ticket_id] = r.status;
      return acc;
    }, {});

    const list = tickets.map((t) => ({
      ticket_id: t.ticket_id,
      ticket_number: t.ticket_number,
      pass_id: t.pass_id || null,
      qr_code_hash: t.qr_code_hash,
      status: t.status,
      price_paid: t.price_paid,
      created_at: t.created_at,
      registration_status: regByTicket[t.ticket_id] || null,
      plan: planMap[t.plan_id] || null,
    }));

    return sendSuccess(res, 'Tickets retrieved successfully', { tickets: list });
  } catch (error) {
    console.error('Error getTicketsByUser:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get user's ticket for an event
 */
exports.getUserTicket = async (req, res) => {
  try {
    const { plan_id, user_id } = req.params;
    
    const registration = await Registration.findOne({ plan_id, user_id });
    if (!registration || !registration.ticket_id) {
      return sendError(res, 'Ticket not found', 404);
    }
    
    const ticket = await Ticket.findOne({ ticket_id: registration.ticket_id });
    if (!ticket) {
      return sendError(res, 'Ticket not found', 404);
    }
    
    const plan = await BusinessPlan.findOne({ plan_id }).lean();
    const user = await User.findOne({ user_id }).lean();
    
    return sendSuccess(res, 'Ticket retrieved successfully', {
      ticket: {
        ...ticket.toObject(),
        checkin_code: registration.checkin_code || null,
        plan: plan ? {
          plan_id: plan.plan_id,
          title: plan.title,
          description: plan.description,
          location_text: plan.location_text,
          date: plan.date,
          time: plan.time,
          media: plan.media,
          ticket_image: plan.ticket_image || null,
          updated_at: plan.updated_at || null,
          passes: plan.passes || [],
          add_details: plan.add_details || [],
          category_main: plan.category_main || null,
          category_sub: plan.category_sub || [],
          group_id: plan.group_id || null
        } : null,
        user: user ? {
          user_id: user.user_id,
          name: user.name,
          profile_image: user.profile_image
        } : null
      }
    });
  } catch (error) {
    console.error('getUserTicket:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get ticket by ticket_id
 */
exports.getTicketById = async (req, res) => {
  try {
    const { ticket_id } = req.params;
    
    const ticket = await Ticket.findOne({ ticket_id });
    if (!ticket) {
      return sendError(res, 'Ticket not found', 404);
    }
    
    const plan = await BusinessPlan.findOne({ plan_id: ticket.plan_id }).lean();
    const user = await User.findOne({ user_id: ticket.user_id }).lean();
    
    return sendSuccess(res, 'Ticket retrieved successfully', {
      ticket: {
        ...ticket.toObject(),
        plan: plan ? {
          plan_id: plan.plan_id,
          title: plan.title,
          description: plan.description,
          location_text: plan.location_text,
          date: plan.date,
          time: plan.time,
          media: plan.media,
          ticket_image: plan.ticket_image || null,
          passes: plan.passes || [],
          add_details: plan.add_details || [],
          category_main: plan.category_main || null,
          category_sub: plan.category_sub || [],
          group_id: plan.group_id || null,
        } : null,
        user: user ? {
          user_id: user.user_id,
          name: user.name,
          profile_image: user.profile_image
        } : null
      }
    });
  } catch (error) {
    return sendError(res, error.message, 500);
  }
};

/**
 * Yashvardhan internal: list business plans (no auth)
 */
exports.getYashvardhanPlans = async (req, res) => {
  try {
    const plans = await BusinessPlan.find({ type: 'business', post_status: { $ne: 'deleted' } })
      .sort({ created_at: -1 })
      .limit(100)
      .lean();
    const list = plans.map((p) => ({
      plan_id: p.plan_id,
      title: p.title || 'Untitled',
      date: p.date,
      time: p.time,
      location_text: p.location_text
    }));
    return sendSuccess(res, 'Plans retrieved', { plans: list });
  } catch (error) {
    console.error('getYashvardhanPlans:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Yashvardhan internal: attendee list for a plan (no auth)
 */
exports.getYashvardhanAttendees = async (req, res) => {
  try {
    const { plan_id } = req.params;
    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) return sendError(res, 'Event not found', 404);
    const registrations = await Registration.find({ plan_id }).sort({ created_at: -1 }).lean();
    const attendeeList = await Promise.all(
      registrations.map(async (reg) => {
        const ticket = reg.ticket_id ? await Ticket.findOne({ ticket_id: reg.ticket_id }).lean() : null;
        const user = await User.findOne({ user_id: reg.user_id }).lean();
        return {
          registration_id: reg.registration_id,
          user_id: reg.user_id,
          user: user ? { user_id: user.user_id, name: user.name, profile_image: user.profile_image, phone_number: user.phone_number || null } : null,
          ticket_id: reg.ticket_id,
          ticket_number: ticket?.ticket_number || null,
          checkin_code: reg.checkin_code || null,
          status: reg.status,
          checked_in: reg.checked_in || ticket?.checked_in || false,
          price_paid: reg.price_paid,
          created_at: reg.created_at
        };
      })
    );
    return sendSuccess(res, 'Attendees retrieved', {
      attendees: attendeeList,
      statistics: { total: attendeeList.length, checked_in: attendeeList.filter((a) => a.checked_in).length }
    });
  } catch (error) {
    console.error('getYashvardhanAttendees:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Yashvardhan internal: get ticket by plan_id + user_id (no auth, same shape as getUserTicket)
 */
exports.getYashvardhanTicket = async (req, res) => {
  try {
    const { plan_id, user_id } = req.params;

    const registration = await Registration.findOne({ plan_id, user_id });
    if (!registration || !registration.ticket_id)
      return sendError(res, 'Ticket not found', 404);

    const ticket = await Ticket.findOne({ ticket_id: registration.ticket_id });
    if (!ticket) return sendError(res, 'Ticket not found', 404);

    const plan = await BusinessPlan.findOne({ plan_id }).lean();
    const user = await User.findOne({ user_id }).lean();

    return sendSuccess(res, 'Ticket retrieved', {
      ticket: {
        ...ticket.toObject(),
        plan: plan
          ? {
              plan_id: plan.plan_id,
              title: plan.title,
              description: plan.description,
              location_text: plan.location_text,
              date: plan.date,
              time: plan.time,
              media: plan.media,
              ticket_image: plan.ticket_image || null,
              updated_at: plan.updated_at || null,
              passes: plan.passes || [],
              add_details: plan.add_details || [], // ✅ SAME AS NORMAL
              category_main: plan.category_main || null,
              category_sub: plan.category_sub || [],
              group_id: plan.group_id || null,
            }
          : null,
        user: user
          ? {
              user_id: user.user_id,
              name: user.name,
              profile_image: user.profile_image,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('getYashvardhanTicket:', error);
    return sendError(res, error.message, 500);
  }
};
/**
 * Scan QR code and check in user
 */
exports.scanQRCode = async (req, res) => {
  try {
    const { qr_code_hash, scanner_user_id } = req.body;
    
    if (!qr_code_hash || !scanner_user_id) {
      return sendError(res, 'qr_code_hash and scanner_user_id are required', 400);
    }
    
    // Find ticket by QR hash
    const ticket = await Ticket.findOne({ qr_code_hash });
    if (!ticket) {
      return sendError(res, 'Invalid QR code', 404);
    }
    
    // Verify ticket is active
    if (ticket.status !== 'active') {
      return sendError(res, `Ticket is ${ticket.status}`, 400);
    }
    
    // Verify scanner is the business owner
    const plan = await BusinessPlan.findOne({ plan_id: ticket.plan_id });
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    
    if (plan.user_id !== scanner_user_id && plan.business_id !== scanner_user_id) {
      return sendError(res, 'Only event organizer can check in attendees', 403);
    }

    const planInfo = {
      plan_id: plan.plan_id,
      title: plan.title,
      date: plan.date,
      time: plan.time,
      location_text: plan.location_text
    };

    // Check if already checked in
    if (ticket.checked_in) {
      const user = await User.findOne({ user_id: ticket.user_id }).lean();
      const [checkedInCount, totalCount] = await Promise.all([
        Registration.countDocuments({ plan_id: ticket.plan_id, checked_in: true }),
        Registration.countDocuments({ plan_id: ticket.plan_id, status: { $in: ['pending', 'approved'] } })
      ]);
      return sendSuccess(res, 'Already checked in', {
        ticket: { ...ticket.toObject(), plan_id: ticket.plan_id },
        plan: planInfo,
        user: user ? { user_id: user.user_id, name: user.name, profile_image: user.profile_image } : null,
        attendee: user ? { user_id: user.user_id, name: user.name, profile_image: user.profile_image } : null,
        checked_in_count: checkedInCount,
        total: totalCount,
        already_checked_in: true
      });
    }

    // Check in the user
    ticket.checked_in = true;
    ticket.checked_in_at = new Date();
    ticket.checked_in_by = scanner_user_id;
    await ticket.save();

    // Update registration (QR check-in is permanent)
    const registration = await Registration.findOne({ ticket_id: ticket.ticket_id });
    if (registration) {
      registration.checked_in = true;
      registration.checked_in_at = new Date();
      registration.checked_in_by = scanner_user_id;
      registration.checked_in_via = 'qr';
      await registration.save();
    }

    // Get user details
    const user = await User.findOne({ user_id: ticket.user_id }).lean();

    // Check-in counts for this event (for scanner UI)
    const [checkedInCount, totalCount] = await Promise.all([
      Registration.countDocuments({ plan_id: ticket.plan_id, checked_in: true }),
      Registration.countDocuments({ plan_id: ticket.plan_id, status: { $in: ['pending', 'approved'] } })
    ]);

    return sendSuccess(res, 'Check-in successful', {
      ticket: { ...ticket.toObject(), plan_id: ticket.plan_id },
      plan: planInfo,
      user: user ? {
        user_id: user.user_id,
        name: user.name,
        profile_image: user.profile_image
      } : null,
      attendee: user ? {
        user_id: user.user_id,
        name: user.name,
        profile_image: user.profile_image
      } : null,
      checked_in_count: checkedInCount,
      total: totalCount,
      already_checked_in: false
    });
  } catch (error) {
    console.error('Error scanning QR code:', error);
    return sendError(res, error.message, 500);
  }
};

const REGISTERED_STATUSES = ['pending', 'approved'];

/**
 * Get guest list for an event (public: who's coming – name, avatar, bio only)
 * Any user can call this to see who has registered.
 * Each guest includes is_returning: true if they have registered for more than one of this owner's events.
 */
exports.getGuestList = async (req, res) => {
  try {
    const { plan_id } = req.params;

    const plan = await BusinessPlan.findOne({ plan_id }).lean();
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }

    const requestingUserId = req.user?.user_id || req.query?.user_id;
    const owner_id = plan.user_id || plan.business_id;
    const isOwner = requestingUserId && (
      String(requestingUserId) === String(plan.user_id) ||
      String(requestingUserId) === String(plan.business_id)
    );

    if (!plan.allow_view_guest_list && !isOwner) {
      return sendSuccess(res, 'Guest list is hidden for this event', {
        guests: [],
        total: 0,
      });
    }
    const registrations = await Registration.find({
      plan_id,
      status: { $in: REGISTERED_STATUSES },
    })
      .sort({ created_at: -1 })
      .lean();

    const user_ids = [...new Set(registrations.map((r) => r.user_id))];
    let countByUser = {};
    if (user_ids.length > 0) {
      const registrationCountByUser = await Registration.aggregate([
        { $match: { status: { $in: REGISTERED_STATUSES }, user_id: { $in: user_ids } } },
        { $lookup: { from: 'plans', localField: 'plan_id', foreignField: 'plan_id', as: 'plan' } },
        { $unwind: '$plan' },
        { $match: { $or: [{ 'plan.user_id': owner_id }, { 'plan.business_id': owner_id }] } },
        { $group: { _id: '$user_id', count: { $sum: 1 } } },
      ]);
      countByUser = Object.fromEntries(registrationCountByUser.map((r) => [r._id, r.count]));
    }

    const guestList = await Promise.all(
      registrations.map(async (reg) => {
        const user = await User.findOne({ user_id: reg.user_id }).lean();
        const count = countByUser[reg.user_id] || 0;
        return {
          user_id: reg.user_id,
          name: user?.name || 'Unknown',
          profile_image: user?.profile_image || null,
          bio: user?.bio || '',
          is_returning: count > 1,
        };
      })
    );

    return sendSuccess(res, 'Guest list retrieved successfully', {
      guests: guestList,
      total: guestList.length,
    });
  } catch (error) {
    console.error('Error getting guest list:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get attendee list for business event
 */
exports.getAttendeeList = async (req, res) => {
  try {
    const { plan_id } = req.params;
    const { user_id } = req.query; // Business owner user_id for verification
    
    // Verify user is the business owner
    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    
    if (user_id && plan.user_id !== user_id && plan.business_id !== user_id) {
      return sendError(res, 'Only event organizer can view attendee list', 403);
    }
    
    // Get all registrations for this plan
    const registrations = await Registration.find({ plan_id })
      .sort({ created_at: -1 })
      .lean();

    // Bulk-fetch users and tickets to avoid N+1 queries
    const userIds = [...new Set(registrations.map(r => r.user_id).filter(Boolean))];
    const ticketIds = [...new Set(registrations.map(r => r.ticket_id).filter(Boolean))];

    const [users, tickets] = await Promise.all([
      userIds.length > 0
        ? User.find({ user_id: { $in: userIds } }).select('user_id name profile_image phone_number gender').lean()
        : Promise.resolve([]),
      ticketIds.length > 0
        ? Ticket.find({ ticket_id: { $in: ticketIds } }).select('ticket_id ticket_number checked_in checked_in_at').lean()
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map(u => [u.user_id, u]));
    const ticketMap = new Map(tickets.map(t => [t.ticket_id, t]));

    const attendeeList = registrations.map((reg) => {
      const user = userMap.get(reg.user_id) || null;
      const ticket = reg.ticket_id ? ticketMap.get(reg.ticket_id) || null : null;
      return {
        registration_id: reg.registration_id,
        user_id: reg.user_id,
        user: user ? {
          user_id: user.user_id,
          name: user.name,
          profile_image: user.profile_image,
          phone_number: user.phone_number || null
        } : null,
        phone_number: user?.phone_number || null,
        ticket_id: reg.ticket_id,
        ticket_number: ticket?.ticket_number || null,
        checkin_code: reg.checkin_code || null,
        status: reg.status,
        checked_in: reg.checked_in || ticket?.checked_in || false,
        checked_in_at: reg.checked_in_at || ticket?.checked_in_at || null,
        checked_in_via: reg.checked_in_via || null,
        price_paid: reg.price_paid,
        created_at: reg.created_at,
        age_range: reg.age_range || null,
        gender: reg.gender || user?.gender || null,
        running_experience: reg.running_experience || null,
        what_brings_you: reg.what_brings_you || null
      };
    });
    
    // Get check-in statistics
    const totalRegistrations = registrations.length;
    const checkedInCount = attendeeList.filter(a => a.checked_in).length;
    
    return sendSuccess(res, 'Attendee list retrieved successfully', {
      attendees: attendeeList,
      statistics: {
        total: totalRegistrations,
        checked_in: checkedInCount,
        pending: totalRegistrations - checkedInCount
      }
    });
  } catch (error) {
    console.error('Error getting attendee list:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Get registration count for a plan (public endpoint - no auth required)
 */
exports.getRegistrationCount = async (req, res) => {
  try {
    const { plan_id } = req.params;
    
    // Get plan to verify it exists
    const plan = await BusinessPlan.findOne({ plan_id }).lean();
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    
    // Count registrations
    const count = await Registration.countDocuments({ plan_id });
    
    return sendSuccess(res, 'Registration count retrieved', { count });
  } catch (error) {
    console.error('Error getting registration count:', error);
    return sendError(res, error.message, 500);
  }
};

/**
 * Manual check-in/check-out
 */
exports.manualCheckIn = async (req, res) => {
  try {
    const { registration_id, user_id, action } = req.body; // action: 'checkin' or 'checkout'
    
    if (!registration_id || !user_id || !action) {
      return sendError(res, 'registration_id, user_id, and action are required', 400);
    }
    
    if (!['checkin', 'checkout'].includes(action)) {
      return sendError(res, 'action must be "checkin" or "checkout"', 400);
    }
    
    const registration = await Registration.findOne({ registration_id });
    if (!registration) {
      return sendError(res, 'Registration not found', 404);
    }
    
    // Verify user is the business owner
    const plan = await BusinessPlan.findOne({ plan_id: registration.plan_id });
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    
    if (plan.user_id !== user_id && plan.business_id !== user_id) {
      return sendError(res, 'Only event organizer can check in attendees', 403);
    }
    
    const isCheckIn = action === 'checkin';
    
    // Update registration (manual check-in: can be unchecked later)
    registration.checked_in = isCheckIn;
    registration.checked_in_at = isCheckIn ? new Date() : null;
    registration.checked_in_by = isCheckIn ? user_id : null;
    registration.checked_in_via = isCheckIn ? 'manual' : (registration.checked_in_via || null);
    await registration.save();
    
    // Update ticket if exists
    if (registration.ticket_id) {
      const ticket = await Ticket.findOne({ ticket_id: registration.ticket_id });
      if (ticket) {
        ticket.checked_in = isCheckIn;
        ticket.checked_in_at = isCheckIn ? new Date() : null;
        ticket.checked_in_by = isCheckIn ? user_id : null;
        await ticket.save();
      }
    }
    
    // Get user details
    const attendeeUser = await User.findOne({ user_id: registration.user_id }).lean();
    
    return sendSuccess(res, `${isCheckIn ? 'Check-in' : 'Check-out'} successful`, {
      registration: registration,
      user: attendeeUser ? {
        user_id: attendeeUser.user_id,
        name: attendeeUser.name,
        profile_image: attendeeUser.profile_image
      } : null
    });
  } catch (error) {
    console.error('Error in manual check-in:', error);
    return sendError(res, error.message, 500);
  }
};

// ---------- Razorpay payment ----------

function getRazorpayInstance() {
  let Razorpay;
  try {
    Razorpay = require('razorpay');
  } catch (e) {
    throw new Error('Razorpay SDK not installed. Run: npm install razorpay');
  }
  const keyId = config.RAZORPAY_KEY_ID;
  const keySecret = config.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials not configured (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)');
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

/**
 * Create Razorpay order for paid ticket. Frontend opens checkout with this order.
 */
exports.createOrder = async (req, res) => {
  try {
    const { plan_id, user_id, pass_id } = req.body;
    if (!plan_id || !user_id) {
      return sendError(res, 'plan_id and user_id are required', 400);
    }

    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) {
      return sendError(res, 'Business plan not found', 404);
    }
    if (plan.type !== 'business') {
      return sendError(res, 'This endpoint is only for business plans', 400);
    }

    const planOwnerId = plan.user_id || plan.business_id;
    if (planOwnerId && planOwnerId === user_id) {
      return sendError(res, 'You cannot buy a ticket for your own event', 403);
    }

    const existing = await Registration.findOne({ plan_id, user_id }).lean();
    if (existing) {
      return sendError(res, 'You have already registered for this event', 400);
    }

    // Check registration limit for paid events before creating an order.
    // Also consider other active created orders as temporary reservations to avoid overselling.
    if (plan.registration_limit) {
      const now = Date.now();
      const HOLD_MS = 10 * 60 * 1000; // 10 minutes
      const [registrationCount, activeHolds] = await Promise.all([
        Registration.countDocuments({ plan_id, status: { $in: ['pending', 'approved'] } }),
        PaymentOrder.countDocuments({
          plan_id,
          status: 'created',
          created_at: { $gte: new Date(now - HOLD_MS) }
        })
      ]);
      if (registrationCount + activeHolds >= plan.registration_limit) {
        return sendError(res, `This event has reached its capacity (${plan.registration_limit} attendees). No more registrations are allowed.`, 400);
      }
    }

    // Max 20 users per event (first come, first served) - COMMENTED OUT: removed limit
    // const registrationCount = await Registration.countDocuments({ plan_id });
    // if (registrationCount >= 20) {
    //   return sendError(res, "Event is full. Better luck next time.", 400);
    // }

    let amount = 0;
    if (pass_id && plan.passes && plan.passes.length > 0) {
      const pass = plan.passes.find((p) => p.pass_id === pass_id);
      if (!pass) {
        return sendError(res, 'Invalid pass selected', 400);
      }
      amount = Number(pass.price) || 0;
    }
    if (amount <= 0) {
      return sendError(res, 'Use the free registration flow for free tickets', 400);
    }

    const PLATFORM_FEE_PERCENT = 10;
    const baseAmountPaise = Math.round(amount * 100);
    const platformFeePaise = Math.round((baseAmountPaise * PLATFORM_FEE_PERCENT) / 100);
    const amountPaise = baseAmountPaise + platformFeePaise;
    // Razorpay receipt must be ≤40 chars; we store plan_id/user_id in PaymentOrder
    const receipt = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.slice(0, 40);

    const razorpay = getRazorpayInstance();
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
    });

    await PaymentOrder.create({
      razorpay_order_id: order.id,
      plan_id,
      user_id,
      pass_id: pass_id || null,
      amount_paise: amountPaise,
      status: 'created',
    });

    return sendSuccess(res, 'Order created', {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
    });
  } catch (error) {
    console.error('createOrder error:', error);
    return sendError(res, error.message || 'Failed to create order', 500);
  }
};

/**
 * Verify Razorpay payment signature and fulfill order: create ticket + registration.
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return sendError(res, 'razorpay_payment_id, razorpay_order_id and razorpay_signature are required', 400);
    }

    const keySecret = config.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return sendError(res, 'Payment verification not configured', 500);
    }
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expectedSignature !== razorpay_signature) {
      return sendError(res, 'Invalid payment signature', 400);
    }

    const orderRecord = await PaymentOrder.findOne({ razorpay_order_id, status: 'created' });
    if (!orderRecord) {
      return sendError(res, 'Order not found or already fulfilled', 404);
    }

    const { plan_id, user_id, pass_id, amount_paise } = orderRecord;
    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }

    if (plan.is_women_only) {
      const registeringUser = await User.findOne({ user_id }).lean();
      const profileGender = (registeringUser?.gender || '').toLowerCase();
      if (profileGender !== 'female') {
        return sendError(res, 'Only women can register for this event', 403);
      }
    }

    // Re-check registration limit at fulfillment time (race safety)
    if (plan.registration_limit) {
      const now = Date.now();
      const HOLD_MS = 10 * 60 * 1000; // 10 minutes
      const [registrationCount, activeHolds] = await Promise.all([
        Registration.countDocuments({ plan_id, status: { $in: ['pending', 'approved'] } }),
        PaymentOrder.countDocuments({
          plan_id,
          status: 'created',
          created_at: { $gte: new Date(now - HOLD_MS) },
          razorpay_order_id: { $ne: razorpay_order_id }
        })
      ]);
      if (registrationCount + activeHolds >= plan.registration_limit) {
        await PaymentOrder.updateOne(
          { razorpay_order_id },
          { status: 'failed', updated_at: new Date() }
        );
        return sendError(res, `This event has reached its capacity (${plan.registration_limit} attendees). Your payment will be refunded.`, 400);
      }
    }

    // Max 20 users per event (re-check in case of race between order and verify) - COMMENTED OUT: removed limit
    // const registrationCount = await Registration.countDocuments({ plan_id });
    // if (registrationCount >= 20) {
    //   return sendError(res, "Event is full. Better luck next time.", 400);
    // }

    const pricePaid = amount_paise / 100;
    const ticketId = generateId('ticket');
    const ticketNumber = await generateTicketNumber(plan);
    const { qrData, qrHash } = generateQRCodeData(ticketId, plan_id, user_id);

    const ticket = await Ticket.create({
      ticket_id: ticketId,
      plan_id,
      user_id,
      pass_id: pass_id || null,
      qr_code: qrData,
      qr_code_hash: qrHash,
      ticket_number: ticketNumber,
      status: 'active',
      price_paid: pricePaid,
      razorpay_order_id,
      razorpay_payment_id,
    });

    let paidCheckinCode = null;
    try {
      paidCheckinCode = await generateOrganizerCheckinCode(plan);
    } catch (e) {
      console.error('Failed to generate checkin code (paid):', e);
    }

    const registration = await Registration.create({
      registration_id: generateId('registration'),
      plan_id,
      user_id,
      pass_id: pass_id || null,
      ticket_id: ticketId,
      checkin_code: paidCheckinCode,
      status: plan.registration_required ? 'pending' : 'approved',
      price_paid: pricePaid,
      razorpay_order_id,
      razorpay_payment_id,
    });

    await PaymentOrder.updateOne(
      { razorpay_order_id },
      { status: 'paid', razorpay_payment_id, ticket_id: ticketId, registration_id: registration.registration_id, updated_at: new Date() }
    );

    if (registration.status === 'approved') {
      await BusinessPlan.updateOne({ plan_id }, { $inc: { approved_registrations: 1 } });
    }

    if (plan.group_id) {
      try {
        const group = await ChatGroup.findOne({ group_id: plan.group_id });
        if (group) {
          await addMemberToChatGroupIfNeeded(group, user_id);
        }
      } catch (e) {
        console.error('Failed to add user to group:', e);
      }
    }

    const user = await User.findOne({ user_id }).lean();
    const planDetails = {
      plan_id: plan.plan_id,
      title: plan.title,
      description: plan.description,
      location_text: plan.location_text,
      date: plan.date,
      time: plan.time,
      media: plan.media,
      ticket_image: plan.ticket_image,
      passes: plan.passes,
      category_main: plan.category_main,
      category_sub: plan.category_sub,
      group_id: plan.group_id,
    };

    return sendSuccess(res, 'Payment verified and ticket created', {
      registration: {
        ...registration.toObject(),
        user: user ? { user_id: user.user_id, name: user.name, profile_image: user.profile_image } : null,
      },
      ticket: {
        ticket_id: ticket.ticket_id,
        ticket_number: ticket.ticket_number,
        qr_code: ticket.qr_code,
        qr_code_hash: ticket.qr_code_hash,
        status: ticket.status,
        price_paid: ticket.price_paid,
        plan: planDetails,
        user: user ? { user_id: user.user_id, name: user.name, profile_image: user.profile_image } : null,
      },
    }, 201);
  } catch (error) {
    console.error('verifyPayment error:', error);
    return sendError(res, error.message || 'Payment verification failed', 500);
  }
};

/**
 * Razorpay webhook: verify signature, handle payment.captured and refund.processed.
 * Must be called with raw body (express.raw) for signature verification.
 */
exports.handleRazorpayWebhook = async (req, res) => {
  const webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook not configured');
  }
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    return res.status(400).send('Missing signature');
  }
  const body = req.body;
  const rawBody = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body)));
  const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  if (expectedSignature !== signature) {
    return res.status(400).send('Invalid webhook signature');
  }
  let event;
  try {
    event = typeof body === 'object' && body !== null ? body : JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid JSON');
  }
  const eventType = event.event;
  try {
    if (eventType === 'payment.captured') {
      // We already fulfill in verify-payment; nothing extra unless you want idempotency
    } else if (eventType === 'refund.processed' || eventType === 'refund.created') {
      const refundEntity = event.payload?.refund?.entity;
      const paymentId = refundEntity?.payment_id || event.payload?.payment?.entity?.id;
      if (paymentId) {
        await Ticket.updateMany({ razorpay_payment_id: paymentId }, { status: 'cancelled', updated_at: new Date() });
        await Registration.updateMany({ razorpay_payment_id: paymentId }, { status: 'cancelled', updated_at: new Date() });
        await PaymentOrder.updateMany({ razorpay_payment_id: paymentId }, { status: 'refunded', updated_at: new Date() });
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.status(500).send('Handler error');
  }
  return res.status(200).send('OK');
};

/**
 * Refund all paid tickets for a plan (Razorpay). Used when event is cancelled or by refund API.
 * Returns { refunded, failed, errors }. Does not throw; logs and returns on Razorpay errors.
 */
async function refundPaidTicketsForPlan(plan_id) {
  const results = { refunded: 0, failed: 0, errors: [] };
  try {
    const paidRegistrations = await Registration.find({
      plan_id,
      status: { $in: ['pending', 'approved'] },
      razorpay_payment_id: { $exists: true, $ne: null, $ne: '' },
    }).lean();

    if (paidRegistrations.length === 0) return results;

    const razorpay = getRazorpayInstance();
    for (const reg of paidRegistrations) {
      try {
        await razorpay.payments.refund(reg.razorpay_payment_id, { amount: Math.round((reg.price_paid || 0) * 100) });
        results.refunded += 1;
      } catch (e) {
        results.failed += 1;
        results.errors.push({ registration_id: reg.registration_id, message: e.message || String(e) });
      }
    }
    if (results.refunded > 0 || results.failed > 0) {
      console.log(`[refund] Plan ${plan_id}: refunded=${results.refunded}, failed=${results.failed}`);
    }
  } catch (error) {
    console.error('[refund] refundPaidTicketsForPlan error:', error.message);
    results.errors.push({ message: error.message || String(error) });
  }
  return results;
}

exports.refundPaidTicketsForPlan = refundPaidTicketsForPlan;

/**
 * Refund all paid tickets for a plan (e.g. when event is cancelled). Call Razorpay refund API for each payment.
 */
exports.refundAllForPlan = async (req, res) => {
  try {
    const { plan_id } = req.params;
    const { user_id } = req.query;
    const plan = await BusinessPlan.findOne({ plan_id });
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    const ownerId = plan.user_id || plan.business_id;
    if (user_id && ownerId !== user_id) {
      return sendError(res, 'Only the event organizer can refund tickets', 403);
    }
    const results = await refundPaidTicketsForPlan(plan_id);
    return sendSuccess(res, 'Refund initiated for paid tickets', results);
  } catch (error) {
    console.error('refundAllForPlan error:', error);
    return sendError(res, error.message || 'Refund failed', 500);
  }
};

module.exports = exports;
