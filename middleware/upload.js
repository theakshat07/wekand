const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  // Allow images and videos
  const allowedMimes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo'
  ];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and videos are allowed.'), false);
  }
};

// Same limits and filter for both disk and memory
const multerLimits = { fileSize: 10 * 1024 * 1024 }; // 10MB max per file

// Configure multer (disk storage - for routes that need files on disk)
const upload = multer({
  storage: storage,
  limits: multerLimits,
  fileFilter: fileFilter
});

// Memory storage - no disk I/O; faster for post create (files go straight to R2 from buffer)
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({
  storage: memoryStorage,
  limits: multerLimits,
  fileFilter: fileFilter
});

// Error handling wrapper for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB per file'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Too many files. Maximum is 10 files'
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload error'
    });
  }
  next();
};

// Middleware for single file upload (optional - allows requests without files)
const uploadSingle = (fieldName = 'file') => {
  return (req, res, next) => {
    // Log request details for debugging
    console.log('📥 Multer middleware - Field name:', fieldName);
    console.log('📥 Request headers:', {
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length']
    });
    
    const middleware = upload.single(fieldName);
    middleware(req, res, (err) => {
      if (err) {
        console.error('❌ Multer error:', err);
        return handleMulterError(err, req, res, next);
      }
      
      // Log what multer received
      console.log('📥 Multer result - req.file:', req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      } : 'No file');
      
      // Log request body to see what was sent
      console.log('📥 Request body:', req.body);
      console.log('📥 Request body keys:', Object.keys(req.body || {}));
      
      // If no file uploaded, that's okay - continue
      next();
    });
  };
};

// Middleware for multiple files upload (optional - allows requests without files)
const uploadMultiple = (fieldName = 'files', maxCount = 10) => {
  return (req, res, next) => {
    const middleware = upload.array(fieldName, maxCount);
    middleware(req, res, (err) => {
      if (err) {
        return handleMulterError(err, req, res, next);
      }
      if (!req.files) req.files = [];
      next();
    });
  };
};

// Multiple files into memory (faster for post create - no disk write/read)
const uploadMultipleMemory = (fieldName = 'files', maxCount = 10) => {
  return (req, res, next) => {
    const middleware = uploadMemory.array(fieldName, maxCount);
    middleware(req, res, (err) => {
      if (err) {
        return handleMulterError(err, req, res, next);
      }
      if (!req.files) req.files = [];
      next();
    });
  };
};

// Middleware for multiple fields
const uploadFields = (fields) => {
  return (req, res, next) => {
    upload.fields(fields)(req, res, (err) => {
      if (err) {
        return handleMulterError(err, req, res, next);
      }
      next();
    });
  };
};

// Multiple fields into memory (faster for business post create)
const uploadFieldsMemory = (fields) => {
  return (req, res, next) => {
    uploadMemory.fields(fields)(req, res, (err) => {
      if (err) {
        return handleMulterError(err, req, res, next);
      }
      next();
    });
  };
};

// Clean up uploaded file after processing
const cleanupFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting file:', err);
    });
  }
};

module.exports = {
  upload,
  uploadSingle,
  uploadMultiple,
  uploadMultipleMemory,
  uploadFields,
  uploadFieldsMemory,
  cleanupFile
};

