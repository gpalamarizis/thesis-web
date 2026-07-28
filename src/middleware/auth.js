const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      organization_id: user.organization_id,
      email: user.email,
      role: user.role,
      is_platform_admin: user.is_platform_admin || false,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.sub,
      organization_id: payload.organization_id,
      email: payload.email,
      role: payload.role,
      is_platform_admin: payload.is_platform_admin || false,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// authenticateJWT: alias του requireAuth (το admin-orgs.js το καλεί έτσι)
const authenticateJWT = requireAuth;

module.exports = { signToken, requireAuth, authenticateJWT, requireRole, JWT_SECRET };
