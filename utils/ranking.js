/**
 * Personalized Feed Ranking Algorithm
 * 
 * For Registered Users:
 * - Plan Recency: 45%
 * - User Relevance: 30% (interests, age compatibility, women-only constraint)
 * - Plan Urgency: 15% (how close the event is)
 * - Popularity Signals: 10% (joins, interactions, views)
 * 
 * For Guest Users:
 * - Plan Recency: 50%
 * - Event Urgency: 25%
 * - Popularity: 25%
 */

/**
 * Calculate recency score (0-1)
 * Newer plans get higher scores, older plans gradually lose relevancy
 */
function calculateRecencyScore(planCreatedAt) {
  const now = new Date();
  const planDate = new Date(planCreatedAt);
  const hoursSinceCreation = (now - planDate) / (1000 * 60 * 60);
  
  // Exponential decay: score decreases as time passes
  // Plans from last 24 hours: 1.0
  // Plans from last 7 days: ~0.7
  // Plans from last 30 days: ~0.3
  // Plans older than 30 days: ~0.1
  
  if (hoursSinceCreation <= 24) {
    return 1.0;
  } else if (hoursSinceCreation <= 168) { // 7 days
    return Math.max(0.7, 1 - (hoursSinceCreation - 24) / 1000);
  } else if (hoursSinceCreation <= 720) { // 30 days
    return Math.max(0.3, 0.7 - (hoursSinceCreation - 168) / 2000);
  } else {
    return Math.max(0.1, 0.3 - (hoursSinceCreation - 720) / 5000);
  }
}

/**
 * Calculate urgency score based on event date (0-1)
 * Events happening today or tomorrow get higher scores
 */
function calculateUrgencyScore(eventDate) {
  if (!eventDate) {
    // If no event date, give neutral score
    return 0.5;
  }
  
  const now = new Date();
  const event = new Date(eventDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(event.getFullYear(), event.getMonth(), event.getDate());
  
  // Past events should be filtered out, but if they slip through, give 0
  if (eventDay < today) {
    return 0;
  }
  
  const daysUntilEvent = Math.ceil((eventDay - today) / (1000 * 60 * 60 * 24));
  
  // Today: 1.0
  // Tomorrow: 0.9
  // This week: 0.7
  // This month: 0.5
  // Next month: 0.3
  // Far future: 0.1
  
  if (daysUntilEvent === 0) {
    return 1.0;
  } else if (daysUntilEvent === 1) {
    return 0.9;
  } else if (daysUntilEvent <= 7) {
    return Math.max(0.7, 1 - (daysUntilEvent - 1) / 30);
  } else if (daysUntilEvent <= 30) {
    return Math.max(0.5, 0.7 - (daysUntilEvent - 7) / 100);
  } else if (daysUntilEvent <= 90) {
    return Math.max(0.3, 0.5 - (daysUntilEvent - 30) / 200);
  } else {
    return Math.max(0.1, 0.3 - (daysUntilEvent - 90) / 500);
  }
}

/**
 * Calculate popularity score (0-1)
 * Based on joins, interactions, and views
 */
function calculatePopularityScore(plan) {
  const joins = plan.joins_count || 0;
  const interactions = plan.interaction_count || 0;
  const views = plan.views_count || 0;
  
  // Normalize each metric (using logarithmic scale to prevent one metric from dominating)
  const normalizedJoins = Math.min(1, Math.log10(joins + 1) / Math.log10(100)); // 100+ joins = 1.0
  const normalizedInteractions = Math.min(1, Math.log10(interactions + 1) / Math.log10(50)); // 50+ interactions = 1.0
  const normalizedViews = Math.min(1, Math.log10(views + 1) / Math.log10(500)); // 500+ views = 1.0
  
  // Weighted average: joins are most important, then interactions, then views
  const popularityScore = (
    normalizedJoins * 0.5 +
    normalizedInteractions * 0.3 +
    normalizedViews * 0.2
  );
  
  return popularityScore;
}

/**
 * Calculate user relevance score (0-1)
 * Based on interests, age compatibility, and women-only constraint
 */
function calculateRelevanceScore(plan, user) {
  if (!user) {
    return 0.5; // Neutral score if no user data
  }
  
  let score = 0;
  let factors = 0;
  
  // 1. Interest matching (40% of relevance score)
  if (user.interests && user.interests.length > 0) {
    const userInterests = user.interests.map(i => i.toLowerCase());
    const planCategoryMain = (plan.category_main || '').toLowerCase();
    const planCategorySub = (plan.category_sub || []).map(c => c.toLowerCase());
    
    let interestMatch = 0;
    
    // Check main category match
    if (planCategoryMain && userInterests.includes(planCategoryMain)) {
      interestMatch += 0.5;
    }
    
    // Check sub-category matches
    const matchingSubs = planCategorySub.filter(sub => userInterests.includes(sub));
    if (matchingSubs.length > 0) {
      interestMatch += Math.min(0.5, matchingSubs.length * 0.2);
    }
    
    score += interestMatch * 0.4;
    factors += 0.4;
  }
  
  // 2. Women-only constraint (30% of relevance score)
  if (plan.is_women_only !== undefined) {
    if (plan.is_women_only) {
      // If plan is women-only, check if user is female
      if (user.gender === 'female') {
        score += 1.0 * 0.3;
      } else {
        score += 0 * 0.3; // Men can't join women-only events
      }
    } else {
      // If plan is not women-only, everyone can join (neutral)
      score += 0.5 * 0.3;
    }
    factors += 0.3;
  }
  
  // 3. Age compatibility (30% of relevance score)
  // Note: Age field might not exist in User model, so we'll use a neutral score for now
  // If age data becomes available, implement age range matching here
  // For now, give neutral score
  score += 0.5 * 0.3;
  factors += 0.3;
  
  // Normalize score based on available factors
  if (factors > 0) {
    return score / factors;
  }
  
  return 0.5; // Default neutral score
}

/**
 * Calculate final score for registered users
 */
function calculateRegisteredUserScore(plan, user) {
  const recency = calculateRecencyScore(plan.created_at);
  const relevance = calculateRelevanceScore(plan, user);
  const urgency = calculateUrgencyScore(plan.date);
  const popularity = calculatePopularityScore(plan);
  
  const finalScore = (
    recency * 0.45 +
    relevance * 0.30 +
    urgency * 0.15 +
    popularity * 0.10
  );
  
  return {
    finalScore,
    breakdown: {
      recency,
      relevance,
      urgency,
      popularity
    }
  };
}

/**
 * Calculate final score for guest users
 */
function calculateGuestUserScore(plan) {
  const recency = calculateRecencyScore(plan.created_at);
  const urgency = calculateUrgencyScore(plan.date);
  const popularity = calculatePopularityScore(plan);
  
  const finalScore = (
    recency * 0.50 +
    urgency * 0.25 +
    popularity * 0.25
  );
  
  return {
    finalScore,
    breakdown: {
      recency,
      urgency,
      popularity
    }
  };
}

/**
 * Filter out past events
 */
function isPastEvent(eventDate) {
  if (!eventDate) {
    return false; // If no date, don't filter out
  }
  
  const now = new Date();
  const event = new Date(eventDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(event.getFullYear(), event.getMonth(), event.getDate());
  
  return eventDay < today;
}

/**
 * Rank plans for a registered user
 */
function rankPlansForUser(plans, user) {
  // Include past events (urgency score is 0 for past days; they rank lower but stay visible)
  const validPlans = plans;

  const plansWithScores = validPlans.map(plan => {
    const scoreData = calculateRegisteredUserScore(plan, user);
    return {
      ...plan.toObject ? plan.toObject() : plan,
      _rankingScore: scoreData.finalScore,
      _rankingBreakdown: scoreData.breakdown
    };
  });
  
  // Sort by score (highest first)
  plansWithScores.sort((a, b) => b._rankingScore - a._rankingScore);
  
  return plansWithScores;
}

/**
 * Rank plans for a guest user
 */
function rankPlansForGuest(plans) {
  const validPlans = plans;

  const plansWithScores = validPlans.map(plan => {
    const scoreData = calculateGuestUserScore(plan);
    return {
      ...plan.toObject ? plan.toObject() : plan,
      _rankingScore: scoreData.finalScore,
      _rankingBreakdown: scoreData.breakdown
    };
  });
  
  // Sort by score (highest first)
  plansWithScores.sort((a, b) => b._rankingScore - a._rankingScore);
  
  return plansWithScores;
}

module.exports = {
  calculateRecencyScore,
  calculateUrgencyScore,
  calculatePopularityScore,
  calculateRelevanceScore,
  calculateRegisteredUserScore,
  calculateGuestUserScore,
  isPastEvent,
  rankPlansForUser,
  rankPlansForGuest
};
