import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { processCsvFile, getAvailableClients as getUploadClients } from './bulk-upload.js';
import { processUpdateCsvFile, getAvailableClients as getUpdateClients } from './bulk-update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Authentication credentials from environment variables
const AUTH_USERNAME = (process.env.AUTH_USERNAME || 'admin').trim();
const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || 'admin123').trim();

if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD) {
  console.warn('⚠️  WARNING: AUTH_USERNAME and AUTH_PASSWORD not set in .env file!');
  console.warn('⚠️  Using default credentials (admin/admin123). Please set secure credentials!');
} else {
  console.log('✅ Authentication credentials loaded from .env');
  console.log(`   Username: ${AUTH_USERNAME}`);
  console.log(`   Password: ${'*'.repeat(AUTH_PASSWORD.length)}`);
}

// Configure multer for file uploads
// Use /tmp for Vercel (serverless), or uploads/ for local development
const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
const uploadDir = isVercel ? '/tmp' : path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!isVercel) {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'upload-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed!'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Parse JSON, URL-encoded bodies, and cookies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Simple session storage (in production, use express-session with a proper store)
// For Vercel compatibility, we'll use a hybrid approach:
// - In-memory for local dev (faster)
// - Cookie-based validation for Vercel (no server-side storage needed)
const sessions = new Map();

// Secret for signing auth tokens (use AUTH_PASSWORD as salt for simplicity)
const AUTH_SECRET = AUTH_PASSWORD + '_auth_secret';

// Generate session ID
function generateSessionId() {
  return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
}

// Simple token generation/validation (for Vercel compatibility)
function generateAuthToken() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  // Simple hash-like token (not cryptographically secure, but sufficient for this use case)
  return Buffer.from(`${timestamp}-${random}-${AUTH_SECRET}`).toString('base64');
}

function validateAuthToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    return decoded.endsWith(`-${AUTH_SECRET}`);
  } catch {
    return false;
  }
}

// Authentication Middleware
function requireAuth(req, res, next) {
  // Skip authentication for login page, login route, login assets, and health check
  if (req.path === '/login' || 
      req.path === '/login.html' || 
      req.path === '/login.css' || 
      req.path === '/login.js' ||
      req.path === '/health') {
    return next();
  }

  // Check for session cookie or auth token
  const sessionId = req.cookies?.sessionId || req.headers['x-session-id'];
  const authToken = req.cookies?.authToken;
  
  // For Vercel (serverless), use token-based auth (no server-side storage)
  const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
  
  if (isVercel) {
    // On Vercel, validate token from cookie
    if (authToken && validateAuthToken(authToken)) {
      return next();
    }
  } else {
    // Local dev: use in-memory sessions
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      // Check if session is expired
      if (session.expiresAt > Date.now()) {
        // Valid session
        return next();
      } else {
        // Expired session - remove it
        sessions.delete(sessionId);
      }
    }
  }

  // No valid session - redirect to login or return 401 for API calls
  // Allow /api/clients without auth (it's safe, just returns available clients)
  if ((req.path.startsWith('/api/') && req.path !== '/api/clients') || 
      req.path === '/upload' || 
      req.path === '/update' ||
      req.path.startsWith('/progress/') ||
      req.path.endsWith('.json')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // For HTML pages, redirect to login
  if (req.path === '/' || req.path.endsWith('.html') || req.accepts('html')) {
    return res.redirect('/login.html');
  }
  
  // For other requests, return 401
  return res.status(401).json({ error: 'Authentication required' });
}

// Login route
app.post('/login', (req, res) => {
  const { username, password, rememberme } = req.body;

  // Trim whitespace from inputs
  const inputUsername = (username || '').trim();
  const inputPassword = (password || '').trim();

  // Debug logging (remove in production)
  console.log('Login attempt:', {
    inputUsername,
    inputPassword: inputPassword ? '***' : '(empty)',
    expectedUsername: AUTH_USERNAME,
    usernameMatch: inputUsername === AUTH_USERNAME,
    passwordMatch: inputPassword === AUTH_PASSWORD
  });

  // Verify credentials
  if (inputUsername === AUTH_USERNAME && inputPassword === AUTH_PASSWORD) {
    const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
    const maxAge = rememberme === 'forever' ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    
    if (isVercel) {
      // On Vercel: use token-based auth (no server-side storage)
      const authToken = generateAuthToken();
      res.cookie('authToken', authToken, {
        httpOnly: true,
        secure: true, // Always secure on Vercel (HTTPS)
        sameSite: 'strict',
        maxAge: maxAge
      });
    } else {
      // Local dev: use in-memory sessions
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        username: username,
        createdAt: Date.now(),
        expiresAt: Date.now() + maxAge
      });
      
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: maxAge
      });
    }

    return res.json({ success: true, message: 'Login successful' });
  } else {
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
  }
});

// Logout route
app.post('/logout', (req, res) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('sessionId');
  res.clearCookie('authToken'); // Clear Vercel token too
  res.json({ success: true, message: 'Logged out successfully' });
});

// Clean up expired sessions periodically
// Disabled for Vercel (serverless functions don't persist state)
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      if (session.expiresAt < now) {
        sessions.delete(sessionId);
      }
    }
  }, 60 * 60 * 1000); // Run every hour
}

// Serve login page assets (CSS, JS) without authentication
app.use('/login.css', express.static(path.join(__dirname, 'public', 'login.css')));
app.use('/login.js', express.static(path.join(__dirname, 'public', 'login.js')));

// Login page route (must be before auth middleware)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Apply authentication middleware (protects all routes after this)
app.use(requireAuth);

// Protected routes - serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static files (CSS, JS, images) after authentication
// Exclude index.html from static serving to prevent bypassing auth
app.use(express.static(path.join(__dirname, 'public'), {
  index: false // Don't serve index.html automatically - it's served by the route above
}));

// Store active SSE connections
const sseConnections = new Map();

// SSE endpoint for progress updates
app.get('/progress/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  
  // Store the response object for this session
  if (!sseConnections.has(sessionId)) {
    sseConnections.set(sessionId, []);
  }
  sseConnections.get(sessionId).push(res);
  
  // Keep connection alive
  const interval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);
  
  // Clean up on close
  req.on('close', () => {
    clearInterval(interval);
    const connections = sseConnections.get(sessionId);
    if (connections) {
      const index = connections.indexOf(res);
      if (index > -1) {
        connections.splice(index, 1);
      }
      if (connections.length === 0) {
        sseConnections.delete(sessionId);
      }
    }
    res.end();
  });
});

// Helper function to broadcast progress to all connections for a session
function broadcastProgress(sessionId, progress) {
  const connections = sseConnections.get(sessionId);
  if (connections) {
    connections.forEach(res => {
      try {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      } catch (error) {
        console.error('Error broadcasting progress:', error);
      }
    });
  }
}

// Upload and process CSV
app.post('/upload', upload.single('csvfile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Get sessionId and clientId from form data or generate one
  const sessionId = req.body.sessionId || Date.now().toString();
  const clientId = req.body.clientId || null;

  try {
    const csvPath = req.file.path;
    console.log(`Processing uploaded file: ${csvPath}${clientId ? ` for client: ${clientId}` : ''}`);
    
    // Progress callback - broadcast immediately to SSE connections
    const progressCallback = (progress) => {
      broadcastProgress(sessionId, progress);
    };
    
    // Process the CSV file using the existing bulk upload logic
    const result = await processCsvFile(csvPath, progressCallback, clientId);
    
    // Clean up uploaded file after processing
    fs.unlinkSync(csvPath);
    
    res.json({
      success: true,
      message: 'Upload completed successfully',
      result: result,
      sessionId: sessionId
    });
  } catch (error) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred during upload',
      sessionId: sessionId
    });
  }
});

// Update existing posts from CSV
app.post('/update', upload.single('csvfile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Get sessionId and clientId from form data or generate one
  const sessionId = req.body.sessionId || Date.now().toString();
  const clientId = req.body.clientId || null;

  try {
    const csvPath = req.file.path;
    console.log(`Processing update file: ${csvPath}${clientId ? ` for client: ${clientId}` : ''}`);
    
    // Progress callback - broadcast immediately to SSE connections
    const progressCallback = (progress) => {
      broadcastProgress(sessionId, progress);
    };
    
    // Process the CSV file using the bulk update logic
    const result = await processUpdateCsvFile(csvPath, progressCallback, clientId);
    
    // Clean up uploaded file after processing
    fs.unlinkSync(csvPath);
    
    res.json({
      success: true,
      message: 'Update completed successfully',
      result: result,
      sessionId: sessionId
    });
  } catch (error) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Update error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred during update',
      sessionId: sessionId
    });
  }
});

// Get available clients endpoint
app.get('/api/clients', (req, res) => {
  try {
    const clients = getUploadClients();
    res.json({ success: true, clients });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'WordPress Bulk Uploader Server is running' });
});

// Export for Vercel serverless (always export for ES modules compatibility)
export default app;

// Only start server when running locally (not on Vercel)
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 WordPress Bulk Uploader Web Interface`);
    console.log(`📡 Server running at http://localhost:${PORT}`);
    console.log(`🔐 Authentication enabled`);
    console.log(`\n💡 Open your browser and navigate to: http://localhost:${PORT}`);
    console.log(`   Username: ${AUTH_USERNAME}`);
    console.log(`   Password: ${'*'.repeat(AUTH_PASSWORD.length)}\n`);
  });
}
