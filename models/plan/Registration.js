const mongoose = require('mongoose');

const registrationSchema = new mongoose.Schema({
  registration_id: {
    type: String,
    required: true,
    unique: true
  },
  plan_id: {
    type: String,
    required: true,
    index: true
  },
  user_id: {
    type: String,
    required: true,
    index: true
  },
  pass_id: {
    type: String,
    default: null // Which pass/ticket type was selected
  },
  ticket_id: {
    type: String,
    default: null, // Reference to Ticket if ticket was generated
    index: true
  },
  // For free events without tickets: human–readable check‑in / confirmation code
  checkin_code: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending'
  },
  checked_in: {
    type: Boolean,
    default: false
  },
  checked_in_at: {
    type: Date,
    default: null
  },
  checked_in_by: {
    type: String, // user_id of business owner who checked in
    default: null
  },
  checked_in_via: {
    type: String,
    enum: ['qr', 'manual'],
    default: null // 'manual' = checked in via attendee list; 'qr' = scanned; null = legacy (treat as qr)
  },
  price_paid: {
    type: Number,
    default: 0
  },
  message: {
    type: String,
    default: null // Optional message from user
  },
  age_range: {
    type: String,
    default: null // e.g. "Under 18yrs", "18-24yrs", "25-34yrs", "35-44yrs", "above 45yrs"
  },
  gender: {
    type: String,
    default: null // e.g. "Male", "Female", "Prefer not to say"
  },
  running_experience: {
    type: String,
    default: null // e.g. "This will be my first time.", "I run occasionally", etc.
  },
  what_brings_you: {
    type: String,
    default: null // Free text: what brings you to BREATHE?
  },
  /** Post-event experience (optional); used for organizer analytics */
  post_event_rating: {
    type: String,
    default: null,
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  razorpay_order_id: { type: String, default: null },
  razorpay_payment_id: { type: String, default: null }
});

registrationSchema.index({ plan_id: 1, user_id: 1 }, { unique: true }); // One registration per user per plan
registrationSchema.index({ plan_id: 1, status: 1 });
registrationSchema.index({ plan_id: 1, checked_in: 1 });

module.exports = mongoose.model('Registration', registrationSchema);
