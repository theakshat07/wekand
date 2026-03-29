const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb+srv://yashvardhan:yashvardhan@vybeme.gjmypef.mongodb.net/?appName=vybeme';
    
    const conn = await mongoose.connect(mongoURI, {
      // Remove deprecated options, use defaults
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Ticket numbers repeat across events (e.g. Akshat01 per event) but are unique per plan.
    // Older DBs may still have a global unique index `ticket_number_1`, which causes E11000
    // when the same human-readable number appears on another event. syncIndexes() drops
    // indexes not defined on the schema and ensures { plan_id, ticket_number } unique.
    try {
      const Ticket = require('../models/plan/Ticket');
      await Ticket.syncIndexes();
    } catch (idxErr) {
      console.warn('[MongoDB] Ticket index sync (non-fatal):', idxErr?.message || idxErr);
    }

    // Run scripts/dedupe-notifications.js first if you have duplicate (user_id,type,source_plan_id) rows,
    // or creating a unique index on grouped_key may fail until duplicates are removed.
    try {
      const Notification = require('../models/other/Notification');
      await Notification.syncIndexes();
    } catch (idxErr) {
      console.warn('[MongoDB] Notification index sync (non-fatal):', idxErr?.message || idxErr);
    }

    return conn;
  } catch (error) {
    console.error('Error connecting to MongoDB:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

