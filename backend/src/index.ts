import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';

dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 3000;

// Database connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// JWT Types
interface TokenPayload {
  userId: number;
  organizationId: number;
  email: string;
  role: string;
}

interface AuthRequest extends Request {
  user?: TokenPayload;
  organizationId?: number;
}

// Auth Middleware
export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as TokenPayload;
    req.user = decoded;
    req.organizationId = decoded.organizationId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Organization middleware - extract from token
export const orgMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.organizationId = req.user.organizationId;
  next();
};

// API Routes - will be in separate files
app.use('/api/auth', await import('./routes/auth.ts').then(m => m.default));
app.use('/api/users', authMiddleware, orgMiddleware, await import('./routes/users.ts').then(m => m.default));
app.use('/api/cases', authMiddleware, orgMiddleware, await import('./routes/cases.ts').then(m => m.default));
app.use('/api/persons', authMiddleware, orgMiddleware, await import('./routes/persons.ts').then(m => m.default));
app.use('/api/courts', authMiddleware, orgMiddleware, await import('./routes/courts.ts').then(m => m.default));
app.use('/api/finance', authMiddleware, orgMiddleware, await import('./routes/finance.ts').then(m => m.default));
app.use('/api/documents', authMiddleware, orgMiddleware, await import('./routes/documents.ts').then(m => m.default));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Thesis API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
