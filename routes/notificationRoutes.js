const express = require('express');
const router = express.Router();
const { notificationController } = require('../controllers');
const { authenticate } = require('../middleware/auth');

router.get('/list', authenticate, notificationController.getNotifications);
router.post('/mark-read', authenticate, notificationController.markAsRead);
router.post('/mark-read-bulk', authenticate, notificationController.markAsReadBulk);
router.get('/counter', authenticate, notificationController.getUnreadCount);

module.exports = router;

