const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const { authenticate, optionalAuth } = require('../middleware/auth');

// Razorpay: create order (authenticated)
router.post('/create-order', authenticate, ticketController.createOrder);
// Razorpay: verify payment and create ticket + registration
router.post('/verify-payment', authenticate, ticketController.verifyPayment);
// Refund all paid tickets for a plan (organizer only)
router.post('/refund-plan/:plan_id', authenticate, ticketController.refundAllForPlan);

// Register for event and generate ticket (free passes only; paid use create-order → verify-payment)
router.post('/register', authenticate, ticketController.registerForEvent);

// Get ticket by ticket_id (must come before /:plan_id/:user_id to avoid route conflicts)
router.get('/by-id/:ticket_id', authenticate, ticketController.getTicketById);

// Get all tickets for a user (profile / tickets & passes)
router.get('/user/:user_id', authenticate, ticketController.getTicketsByUser);

// Get attendee list (must be before /:plan_id/:user_id)
router.get('/attendees/:plan_id', authenticate, ticketController.getAttendeeList);

// Get guest list – who's coming (optionalAuth so we can check ownership for allow_view_guest_list)
router.get('/guest-list/:plan_id', optionalAuth, ticketController.getGuestList);

// Get registration count for a plan (public – check if event is full)
router.get('/registration-count/:plan_id', ticketController.getRegistrationCount);

// Yashvardhan internal: no auth – list plans, attendees, get ticket
router.get('/yashvardhan/plans', ticketController.getYashvardhanPlans);
router.get('/yashvardhan/attendees/:plan_id', ticketController.getYashvardhanAttendees);
router.get('/yashvardhan/ticket/:plan_id/:user_id', ticketController.getYashvardhanTicket);

// Get user's ticket for an event (catch-all :plan_id/:user_id – must be last)
router.get('/:plan_id/:user_id', authenticate, ticketController.getUserTicket);

// Scan QR code
router.post('/scan', authenticate, ticketController.scanQRCode);

// Manual check-in/check-out
router.post('/checkin', authenticate, ticketController.manualCheckIn);

module.exports = router;
