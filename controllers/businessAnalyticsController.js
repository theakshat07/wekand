const { BusinessPlan, Registration, User } = require('../models');
const { sendSuccess, sendError, paginate } = require('../utils');

const REGISTERED_STATUSES = ['pending', 'approved'];

/** All plan_ids owned by this organizer (business plans). */
async function getOwnerPlanIds(owner_id) {
  const rows = await BusinessPlan.find({
    $or: [{ user_id: owner_id }, { business_id: owner_id }],
  })
    .select('plan_id')
    .lean();
  return rows.map((p) => p.plan_id);
}

function bucketGender(raw) {
  const g = String(raw || '')
    .trim()
    .toLowerCase();
  if (g === 'male' || g === 'm' || g === 'man' || g === 'men') return 'male';
  if (g === 'female' || g === 'f' || g === 'woman' || g === 'women') return 'female';
  return 'other';
}

/** Cancelled / removed listing — do not count its ticket revenue in org totals (no date logic). */
function isCancelledPlanExcludeRevenue(plan) {
  if (!plan || !plan.plan_id) return false;
  const st = String(plan.post_status || '').toLowerCase();
  return st === 'deleted' || st === 'cancelled';
}

/** Lifetime sum of price_paid for all owner plans, excluding cancelled plans. */
async function computeLifetimeRevenueForOwner(callerId) {
  const allPlans = await BusinessPlan.find({
    $or: [{ user_id: callerId }, { business_id: callerId }],
  })
    .select('plan_id post_status')
    .lean();

  if (allPlans.length === 0) return 0;

  const exclude = new Set();
  for (const p of allPlans) {
    if (isCancelledPlanExcludeRevenue(p)) exclude.add(p.plan_id);
  }

  const planIds = allPlans.map((p) => p.plan_id);
  const regs = await Registration.find({
    plan_id: { $in: planIds },
    status: { $in: REGISTERED_STATUSES },
  })
    .select('plan_id price_paid')
    .lean();

  let sum = 0;
  for (const r of regs) {
    if (exclude.has(r.plan_id)) continue;
    sum += Number(r.price_paid) || 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Ticket / pass slice percents that sum to 100 (largest remainder). */
function ticketPercentsNormalized(countByPassId, total, passNameById) {
  if (total <= 0) return [];
  const entries = Object.entries(countByPassId).map(([pass_id, count]) => ({
    pass_id,
    name: passNameById[pass_id] || (pass_id === 'unknown' ? 'Other' : pass_id),
    count,
    raw: (count / total) * 100,
  }));
  entries.sort((a, b) => b.count - a.count);
  const floors = entries.map((e) => Math.floor(e.raw));
  let rem = 100 - floors.reduce((s, f) => s + f, 0);
  const sortedIdx = entries
    .map((e, i) => ({ i, frac: e.raw - Math.floor(e.raw) }))
    .sort((a, b) => b.frac - a.frac);
  const ints = [...floors];
  for (let k = 0; k < sortedIdx.length && rem > 0; k += 1) {
    ints[sortedIdx[k].i] += 1;
    rem -= 1;
  }
  return entries.map((e, i) => ({
    pass_id: e.pass_id,
    name: e.name,
    count: e.count,
    percent: ints[i],
  }));
}

/**
 * Per-event analytics
 * GET /analytics/business/event/:plan_id
 * Auth: required; caller must be event owner (user_id or business_id)
 */
exports.getEventAnalytics = async (req, res) => {
  try {
    const { plan_id } = req.params;
    const caller_id = req.user?.user_id;
    if (!caller_id) {
      return sendError(res, 'Unauthorized', 401);
    }

    const plan = await BusinessPlan.findOne({ plan_id }).lean();
    if (!plan) {
      return sendError(res, 'Event not found', 404);
    }
    const owner_id = plan.user_id || plan.business_id;
    if (owner_id !== caller_id) {
      return sendError(res, 'Only the event organizer can view analytics', 403);
    }

    const registrations = await Registration.find({
      plan_id,
      status: { $in: REGISTERED_STATUSES },
    }).lean();

    const total_registered = registrations.length;
    const checked_in_count = registrations.filter((r) => r.checked_in).length;
    const showup_rate = total_registered > 0 ? checked_in_count / total_registered : 0;

    const revenue = registrations.reduce((sum, r) => sum + (Number(r.price_paid) || 0), 0);

    const user_ids = [...new Set(registrations.map((r) => r.user_id))];
    const unique_attendees = user_ids.length;

    const ownerPlanIds = await getOwnerPlanIds(owner_id);
    const registrationCountByUser = await Registration.aggregate([
      {
        $match: {
          status: { $in: REGISTERED_STATUSES },
          user_id: { $in: user_ids },
          plan_id: { $in: ownerPlanIds },
        },
      },
      { $group: { _id: '$user_id', count: { $sum: 1 } } },
    ]);
    const countByUser = Object.fromEntries(registrationCountByUser.map((r) => [r._id, r.count]));
    let first_timers_count = 0;
    let returning_count = 0;
    user_ids.forEach((uid) => {
      const c = countByUser[uid] || 0;
      if (c <= 1) first_timers_count += 1;
      else returning_count += 1;
    });
    const first_timers_percent =
      unique_attendees > 0 ? (first_timers_count / unique_attendees) * 100 : 0;
    const returning_percent =
      unique_attendees > 0 ? (returning_count / unique_attendees) * 100 : 0;

    const users = await User.find({ user_id: { $in: user_ids } })
      .select('user_id gender')
      .lean();
    const userGender = Object.fromEntries(users.map((u) => [u.user_id, u.gender]));
    const genderMap = { male: 0, female: 0, other: 0 };
    user_ids.forEach((uid) => {
      const reg = registrations.find((r) => r.user_id === uid);
      const raw = (reg?.gender || userGender[uid] || '').trim();
      const b = bucketGender(raw);
      if (b === 'male') genderMap.male += 1;
      else if (b === 'female') genderMap.female += 1;
      else genderMap.other += 1;
    });
    const gender_distribution = {
      male: genderMap.male,
      female: genderMap.female,
      other: genderMap.other,
    };
    const total_gender = genderMap.male + genderMap.female + genderMap.other;
    const gender_distribution_percent = {
      male: total_gender > 0 ? (genderMap.male / total_gender) * 100 : 0,
      female: total_gender > 0 ? (genderMap.female / total_gender) * 100 : 0,
      other: total_gender > 0 ? (genderMap.other / total_gender) * 100 : 0,
    };

    const passes = plan.passes || [];
    const passNameById = passes.reduce((acc, p) => {
      acc[p.pass_id] = p.name || 'Pass';
      return acc;
    }, {});
    const byPass = {};
    registrations.forEach((r) => {
      const pid = r.pass_id || 'unknown';
      byPass[pid] = (byPass[pid] || 0) + 1;
    });
    const ticket_distribution = ticketPercentsNormalized(byPass, total_registered, passNameById);

    const ratingAgg = { amazing: 0, good: 0, average: 0, bad: 0 };
    registrations.forEach((r) => {
      const k = r.post_event_rating;
      if (k === 'amazing') ratingAgg.amazing += 1;
      else if (k === 'good') ratingAgg.good += 1;
      else if (k === 'average') ratingAgg.average += 1;
      else if (k === 'bad' || k === 'terrible') ratingAgg.bad += 1;
    });
    const total_rating_votes =
      ratingAgg.amazing + ratingAgg.good + ratingAgg.average + ratingAgg.bad;
    const audience_feedback =
      total_rating_votes > 0
        ? {
            total_votes: total_rating_votes,
            amazing_pct: Math.round((ratingAgg.amazing / total_rating_votes) * 10000) / 100,
            good_pct: Math.round((ratingAgg.good / total_rating_votes) * 10000) / 100,
            average_pct: Math.round((ratingAgg.average / total_rating_votes) * 10000) / 100,
            bad_pct: Math.round((ratingAgg.bad / total_rating_votes) * 10000) / 100,
          }
        : {
            total_votes: 0,
            amazing_pct: 0,
            good_pct: 0,
            average_pct: 0,
            bad_pct: 0,
          };

    const now = new Date();
    const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const [regsThisMonth, regsLastMonth] = await Promise.all([
      Registration.find({
        plan_id: { $in: ownerPlanIds },
        status: { $in: REGISTERED_STATUSES },
        created_at: { $gte: startThisMonth, $lte: now },
      })
        .select('price_paid')
        .lean(),
      Registration.find({
        plan_id: { $in: ownerPlanIds },
        status: { $in: REGISTERED_STATUSES },
        created_at: { $gte: startLastMonth, $lte: endLastMonth },
      })
        .select('price_paid')
        .lean(),
    ]);
    const revThisMonth = regsThisMonth.reduce((s, r) => s + (Number(r.price_paid) || 0), 0);
    const revLastMonth = regsLastMonth.reduce((s, r) => s + (Number(r.price_paid) || 0), 0);
    let revenue_growth_percent = null;
    if (revLastMonth > 0) {
      revenue_growth_percent =
        Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 10000) / 100;
    } else if (revThisMonth > 0 && revLastMonth === 0) {
      revenue_growth_percent = 100;
    } else {
      revenue_growth_percent = 0;
    }

    return sendSuccess(res, 'Event analytics retrieved', {
      plan_id,
      title: plan.title,
      is_paid_plan: !!plan.is_paid_plan,
      registered_count: total_registered,
      checked_in_count,
      showup_rate: Math.round(showup_rate * 100) / 100,
      showup_rate_percent: Math.round(showup_rate * 10000) / 100,
      first_timers_count,
      returning_count,
      first_timers_percent: Math.round(first_timers_percent * 100) / 100,
      returning_percent: Math.round(returning_percent * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
      revenue_growth_percent,
      gender_distribution,
      gender_distribution_percent,
      ticket_distribution,
      audience_feedback,
    });
  } catch (error) {
    console.error('Error in getEventAnalytics:', error);
    return sendError(res, error.message || 'Failed to get event analytics', 500);
  }
};

/**
 * Overall business analytics (e.g. last N months)
 * GET /analytics/business/overall?months=1
 * Auth: required; uses req.user.user_id as business owner
 */
exports.getOverallAnalytics = async (req, res) => {
  try {
    const caller_id = req.user?.user_id;
    if (!caller_id) {
      return sendError(res, 'Unauthorized', 401);
    }
    const months = Math.max(1, Math.min(12, parseInt(req.query.months, 10) || 1));
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const plans = await BusinessPlan.find({
      $or: [{ user_id: caller_id }, { business_id: caller_id }],
      created_at: { $gte: since },
    })
      .select('plan_id title created_at media')
      .lean();

    const plan_ids = plans.map((p) => p.plan_id);
    // Top-card "Revenue Generated": lifetime total for all plans, excluding cancelled/deleted plans.
    const revenueLifetime = await computeLifetimeRevenueForOwner(caller_id);

    if (plan_ids.length === 0) {
      return sendSuccess(res, 'Overall analytics retrieved', {
        since: since.toISOString(),
        months,
        plan_ids: [],
        events_count: 0,
        events_this_month: 0,
        avg_attendance_per_event: 0,
        retention_rate: 0,
        registered_count: 0,
        checked_in_count: 0,
        showup_rate: 0,
        showup_rate_percent: 0,
        first_timers_count: 0,
        returning_count: 0,
        first_timers_percent: 0,
        returning_percent: 0,
        revenue: revenueLifetime,
        gender_distribution: { male: 0, female: 0, other: 0 },
        gender_distribution_percent: { male: 0, female: 0, other: 0 },
        per_event: [],
      });
    }

    const registrations = await Registration.find({
      plan_id: { $in: plan_ids },
      status: { $in: REGISTERED_STATUSES },
    }).lean();

    const total_registered = registrations.length;
    const checked_in_count = registrations.filter((r) => r.checked_in).length;
    const showup_rate = total_registered > 0 ? checked_in_count / total_registered : 0;

    const user_ids = [...new Set(registrations.map((r) => r.user_id))];
    const ownerPlanIdsAll = plan_ids;
    const registrationCountByUser = await Registration.aggregate([
      {
        $match: {
          status: { $in: REGISTERED_STATUSES },
          user_id: { $in: user_ids },
          plan_id: { $in: ownerPlanIdsAll },
        },
      },
      { $group: { _id: '$user_id', count: { $sum: 1 } } },
    ]);
    const countByUser = Object.fromEntries(registrationCountByUser.map((r) => [r._id, r.count]));
    let first_timers_count = 0;
    let returning_count = 0;
    user_ids.forEach((uid) => {
      const c = countByUser[uid] || 0;
      if (c <= 1) first_timers_count += 1;
      else returning_count += 1;
    });
    const unique_attendees = user_ids.length;
    const first_timers_percent =
      unique_attendees > 0 ? (first_timers_count / unique_attendees) * 100 : 0;
    const returning_percent =
      unique_attendees > 0 ? (returning_count / unique_attendees) * 100 : 0;

    const users = await User.find({ user_id: { $in: user_ids } })
      .select('user_id gender')
      .lean();
    const userGender = Object.fromEntries(users.map((u) => [u.user_id, u.gender]));
    const genderMap = { male: 0, female: 0, other: 0 };
    user_ids.forEach((uid) => {
      const reg = registrations.find((r) => r.user_id === uid);
      const raw = (reg?.gender || userGender[uid] || '').trim();
      const b = bucketGender(raw);
      if (b === 'male') genderMap.male += 1;
      else if (b === 'female') genderMap.female += 1;
      else genderMap.other += 1;
    });
    const total_gender = genderMap.male + genderMap.female + genderMap.other;
    const gender_distribution_percent = {
      male: total_gender > 0 ? (genderMap.male / total_gender) * 100 : 0,
      female: total_gender > 0 ? (genderMap.female / total_gender) * 100 : 0,
      other: total_gender > 0 ? (genderMap.other / total_gender) * 100 : 0,
    };

    const per_event = await Promise.all(
      plans.map(async (p) => {
        const regs = registrations.filter((r) => r.plan_id === p.plan_id);
        const reg_count = regs.length;
        const check_in = regs.filter((r) => r.checked_in).length;
        const rev = regs.reduce((s, r) => s + (Number(r.price_paid) || 0), 0);
        return {
          plan_id: p.plan_id,
          title: p.title,
          created_at: p.created_at,
          registered_count: reg_count,
          checked_in_count: check_in,
          showup_rate_percent: reg_count > 0 ? Math.round((check_in / reg_count) * 10000) / 100 : 0,
          revenue: Math.round(rev * 100) / 100,
          media: p.media && Array.isArray(p.media) ? p.media : [],
        };
      })
    );

    // Calculate events this month
    const now = new Date();
    const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const plansThisMonth = plans.filter(p => new Date(p.created_at) >= startThisMonth);
    const eventsThisMonth = plansThisMonth.length;

    // Calculate average attendance per event
    const avgAttendancePerEvent = plans.length > 0 
      ? Math.round((total_registered / plans.length) * 100) / 100 
      : 0;

    // Retention rate is already calculated as returning_percent
    const retentionRate = Math.round(returning_percent * 100) / 100;

    return sendSuccess(res, 'Overall analytics retrieved', {
      since: since.toISOString(),
      months,
      plan_ids,
      events_count: plans.length,
      events_this_month: eventsThisMonth,
      avg_attendance_per_event: avgAttendancePerEvent,
      retention_rate: retentionRate,
      registered_count: total_registered,
      checked_in_count,
      showup_rate: Math.round(showup_rate * 100) / 100,
      showup_rate_percent: Math.round(showup_rate * 10000) / 100,
      first_timers_count,
      returning_count,
      first_timers_percent: Math.round(first_timers_percent * 100) / 100,
      returning_percent: Math.round(returning_percent * 100) / 100,
      revenue: revenueLifetime,
      gender_distribution: { male: genderMap.male, female: genderMap.female, other: genderMap.other },
      gender_distribution_percent,
      per_event,
    });
  } catch (error) {
    console.error('Error in getOverallAnalytics:', error);
    return sendError(res, error.message || 'Failed to get overall analytics', 500);
  }
};

/**
 * Get paginated events for business analytics
 * Returns all events (ongoing, ended, cancelled) with pagination
 */
exports.getBusinessAnalyticsEvents = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const { skip, limit: limitNum } = paginate(page, limit);

    const userId = req.user?.user_id;
    if (!userId) {
      return sendError(res, 'User authentication required', 401);
    }

    const ownerQuery = { $or: [{ user_id: userId }, { business_id: userId }] };

    const [plans, total] = await Promise.all([
      BusinessPlan.find(ownerQuery)
        .skip(skip)
        .limit(limitNum)
        .sort({ created_at: -1 })
        .select(
          'plan_id title category_main status start_date end_date created_at media ticket_image is_paid_plan',
        )
        .lean(),
      BusinessPlan.countDocuments(ownerQuery),
    ]);

    const planIds = plans.map((p) => p.plan_id);
    const allRegs =
      planIds.length > 0
        ? await Registration.find({
            plan_id: { $in: planIds },
            status: { $in: REGISTERED_STATUSES },
          }).lean()
        : [];

    const regsByPlan = {};
    planIds.forEach((id) => {
      regsByPlan[id] = [];
    });
    allRegs.forEach((r) => {
      if (!regsByPlan[r.plan_id]) regsByPlan[r.plan_id] = [];
      regsByPlan[r.plan_id].push(r);
    });

    const eventsWithAnalytics = plans.map((plan) => {
      const regs = regsByPlan[plan.plan_id] || [];
      const registered_count = regs.length;
      const checked_in_count = regs.filter((r) => r.checked_in).length;
      const showup_rate = registered_count > 0 ? checked_in_count / registered_count : 0;
      const revenue = regs.reduce((sum, r) => sum + (Number(r.price_paid) || 0), 0);

      return {
        plan_id: plan.plan_id,
        title: plan.title,
        category_main: plan.category_main,
        status: plan.status,
        start_date: plan.start_date,
        end_date: plan.end_date,
        created_at: plan.created_at,
        is_paid_plan: !!plan.is_paid_plan,
        media: Array.isArray(plan.media) ? plan.media : [],
        ticket_image: plan.ticket_image || null,
        analytics: {
          registered_count,
          checked_in_count,
          showup_rate: Math.round(showup_rate * 10000) / 100,
          revenue: Math.round(revenue * 100) / 100,
        },
      };
    });

    return sendSuccess(res, 'Business analytics events retrieved successfully', {
      events: eventsWithAnalytics,
      pagination: {
        page: parseInt(page, 10),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (error) {
    console.error('Error in getBusinessAnalyticsEvents:', error);
    return sendError(res, error.message || 'Failed to get business analytics events', 500);
  }
};
