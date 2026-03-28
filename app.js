require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/database');
const routes = require('./routes');
const { sendError } = require('./utils');
const initializeSocket = require('./socket/socketHandler');
const deactivatePastEventPlans = require('./jobs/deactivatePastEventPlans');

// Load environment variables
require('dotenv').config();

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Initialize socket handlers
initializeSocket(io);

// Connect to MongoDB
connectDB();

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or curl)
    if (!origin) return callback(null, true);
    
    // Allow all origins in development (including localhost and ngrok)
    if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
      return callback(null, true);
    }
    
    // In production, you can specify allowed origins here
    const allowedOrigins = [
      'http://localhost:8081',
      'http://localhost:19006',
      'http://localhost:3000',
      'https://vybeme.app',
      'https://app.weknd.in', // Web app (shared post links, checkout WebView)
      'https://app.vybeme.in', // Legacy domain during cutover
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('ngrok')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'ngrok-skip-browser-warning',
    'Accept',
    'Origin',
  ],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

// Middleware
app.use(cors(corsOptions));
// Razorpay webhook: must use raw body for signature verification (before express.json())
// Support both URLs: /api/webhooks/razorpay and /api/razorpay/webhook (Razorpay dashboard may use the latter)
const razorpayWebhookHandler = (req, res) => {
  const ticketController = require('./controllers/ticketController');
  ticketController.handleRazorpayWebhook(req, res);
};
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), razorpayWebhookHandler);
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), razorpayWebhookHandler);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Note: CORS middleware automatically handles OPTIONS preflight requests

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// API routes
app.use('/api', routes);

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Vybeme Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      auth: '/api/auth',
      users: '/api/user',
      tags: '/api/tags',
      feed: '/api/feed',
      posts: '/api/post',
      chat: '/api/chat',
      notifications: '/api/notifications'
    }
  });
});

// 404 handler (must be after all routes, before error handler)
app.use((req, res, next) => {
  return sendError(res, 'Route not found', 404);
});

// Error handling middleware (must have 4 parameters)
app.use((err, req, res, next) => {
  console.error('Error:', err);
  console.error('Error Stack:', err.stack);
  
  // Handle multer errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 'File too large. Maximum size is 10MB per file', 400);
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return sendError(res, 'Too many files. Maximum is 10 files', 400);
    }
    return sendError(res, err.message || 'File upload error', 400);
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return sendError(res, 'Invalid or expired token', 401);
  }
  
  // Handle validation errors
  if (err.name === 'ValidationError') {
    return sendError(res, err.message, 400);
  }
  
  // Handle operational errors
  if (err.isOperational) {
    return sendError(res, err.message, err.statusCode || 500);
  }
  
  // Handle other errors
  return sendError(res, err.message || 'Internal server error', 500);
});

// Start server
const PORT = process.env.PORT || 8000;

if (!PORT || isNaN(PORT)) {
  console.error('Invalid PORT in environment variables');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io server initialized`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`API Base URL: http://localhost:${PORT}/api`);
  deactivatePastEventPlans.start();
});

module.exports = { app, server, io };

