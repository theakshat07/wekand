const express = require('express');
const router = express.Router();
const businessAnalyticsController = require('../controllers/businessAnalyticsController');
const { authenticate } = require('../middleware/auth');

router.get('/event/:plan_id', authenticate, businessAnalyticsController.getEventAnalytics);
router.get('/overall', authenticate, businessAnalyticsController.getOverallAnalytics);
router.get('/events', authenticate, businessAnalyticsController.getBusinessAnalyticsEvents);

module.exports = router;
