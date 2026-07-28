// src/middleware/platform-admin.js
// Middleware that requires the authenticated user to have is_platform_admin = true.
// Must be used AFTER requireAuth middleware.

function requirePlatformAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.user.is_platform_admin) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

module.exports = { requirePlatformAdmin };
