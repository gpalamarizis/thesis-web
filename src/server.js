// Thesis Web v3 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Main entry point
// Node 18+, Express 4, PostgreSQL, JWT auth

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

const { pool } = require('./db');

const app = express();

// --- Middleware ---------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: false,      // API only ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ÃƒÅ½Ã‚Â´ÃƒÅ½Ã‚ÂµÃƒÅ½Ã‚Â½ ÃƒÂÃ†â€™ÃƒÅ½Ã‚ÂµÃƒÂÃ‚ÂÃƒÅ½Ã‚Â²ÃƒÅ½Ã‚Â¯ÃƒÂÃ‚ÂÃƒÅ½Ã‚ÂµÃƒÅ½Ã‚Â¹ HTML
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => cb(null, true),  // ÃƒÅ½Ã‚ÂµÃƒÂÃ¢â€šÂ¬ÃƒÅ½Ã‚Â¹ÃƒÂÃ¢â‚¬Å¾ÃƒÂÃ‚ÂÃƒÅ½Ã‚Â­ÃƒÂÃ¢â€šÂ¬ÃƒÅ½Ã‚ÂµÃƒÅ½Ã‚Â¹ ÃƒÂÃ…â€™ÃƒÅ½Ã‚Â»ÃƒÅ½Ã‚Â± (Cloudflare frontend)
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ÃƒÅ½Ã¢â‚¬ËœÃƒÂÃ¢â€šÂ¬ÃƒÅ½Ã‚Â»ÃƒÂÃ…â€™ request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Health -------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({
    service: 'thesis-web',
    version: '3.0.0',
    status: 'ok',
    time: new Date().toISOString(),
  });
});

app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ status: 'ok', db: r.rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ status: 'error', db: false, error: err.message });
  }
});

// --- Routes -------------------------------------------------------
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/cases',     require('./routes/cases'));
app.use('/api/fysika',    require('./routes/fysika'));
app.use('/api/nomika',    require('./routes/nomika'));
app.use('/api/people',    require('./routes/people'));
app.use('/api/courts',    require('./routes/courts'));
app.use('/api/actions',   require('./routes/actions'));
app.use('/api/lists',     require('./routes/lists'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/phonebook', require('./routes/phonebook'));
app.use('/api/finance',   require('./routes/finance'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/case-related-persons', require('./routes/case-related-persons'));
app.use('/api/case-related-cases',   require('./routes/case-related-cases'));

// --- 404 & Error handler -----------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// --- Start --------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[thesis-web v3] listening on :${PORT}`);
  console.log(`[thesis-web v3] node ${process.version}`);
  console.log(`[thesis-web v3] env ${process.env.NODE_ENV || 'development'}`);
});
