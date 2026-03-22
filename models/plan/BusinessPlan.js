const mongoose = require('mongoose');
const BasePlan = require('./BasePlan');

const addDetailSchema = new mongoose.Schema({
  detail_type: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: ''  // For non–additional_info: label (e.g. "Distance"); for additional_info: legacy/fallback
  },
  description: {
    type: String,
    default: ''
  },
  // For detail_type === 'additional_info' only: explicit sub-fields
  heading: {
    type: String,
    default: ''
  }
}, { _id: false });

const passMediaSchema = new mongoose.Schema({
  url: { type: String, required: true },
  type: { type: String, enum: ['image', 'video'], default: 'image' }
}, { _id: false });

const passSchema = new mongoose.Schema({
  pass_id: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  capacity: {
    type: Number,
    default: null // Number of people this pass is for (e.g., 1, 2, 4)
  },
  media: {
    type: [passMediaSchema],
    default: [] // Optional image per pass (ticket image); fallback to plan.media[0] or plan.ticket_image
  }
}, { _id: false });

const businessPlanSchema = new mongoose.Schema({
  type: {
    type: String,
    default: 'business',
    immutable: true
  },
  business_id: {
    type: String,
    required: true
  },
  business_type: {
    type: String,
    default: ''
  },
  price_per_person: {
    type: Number,
    default: null
  },
  is_paid_plan: {
    type: Boolean,
    default: false
  },
  registration_required: {
    type: Boolean,
    default: false
  },
  interaction_message: {
    type: String,
    default: ''
  },
  add_details: {
    type: [addDetailSchema],
    default: []
  },
  download_csv_enabled: {
    type: Boolean,
    default: false
  },
  csv_export_url: {
    type: String,
    default: null
  },
  approved_registrations: {
    type: Number,
    default: 0
  },
  rejected_registrations: {
    type: Number,
    default: 0
  },
  interactions_count: {
    type: Number,
    default: 0
  },
  unique_visitors: {
    type: Number,
    default: 0
  },
  reshare_to_announcement_group: {
    type: Boolean,
    default: false
  },
  passes: {
    type: [passSchema],
    default: []
  },
  venue_required: {
    type: Boolean,
    default: false
  },
  allow_view_guest_list: {
    type: Boolean,
    default: false
  },
  event_production: {
    type: [String],
    default: [] // e.g., ["Musician", "Content Creator"]
  },
  group_id: {
    type: String,
    default: null // Auto-created chat group for the event
  },
  ticket_image: {
    type: String,
    default: null // Separate image for ticket display (different from post media)
  },
  form_id: {
    type: String,
    default: null // Reference to custom form for registration
  },
  registration_limit: {
    type: Number,
    default: null // Max number of attendees; null = unlimited
  },
  // Monotonic sequence for human check-in codes (PREFIX 01, 02, …). Updated atomically to avoid duplicate codes under concurrent registrations.
  checkin_sequence: {
    type: Number
  }
});

const BusinessPlan = BasePlan.discriminator('BusinessPlan', businessPlanSchema);

module.exports = BusinessPlan;

