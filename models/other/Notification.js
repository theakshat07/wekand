const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  notification_id: {
    type: String,
    required: true,
    unique: true
  },
  user_id: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: [
      'comment', 'reaction', 'join', 'repost', 'message',
      'post_live', 'event_ended', 'event_ended_registered', 'event_ended_attended',
      'free_event_cancelled', 'paid_event_cancelled',
      'registration_successful', 'plan_shared_chat',
      'event_chat_poll_vote'
    ],
    required: true
  },
  source_plan_id: {
    type: String,
    default: null
  },
  source_user_id: {
    type: String,
    required: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  is_read: {
    type: Boolean,
    default: false
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  delivered_via: {
    type: [String],
    enum: ['in_app', 'push'],
    default: ['in_app']
  },
  grouped_key: {
    type: String,
    default: null
  }
});

notificationSchema.index({ user_id: 1, is_read: 1 });
notificationSchema.index({ user_id: 1, created_at: -1 });
/** Idempotency: one logical notification per (type, plan, recipient); sparse allows legacy docs with grouped_key null */
notificationSchema.index(
  { grouped_key: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model('Notification', notificationSchema);

