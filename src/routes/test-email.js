// src/routes/test-email.js - Diagnostic endpoint για SMTP test
// GET /api/test-email?to=your@email.com

const express = require('express');
const emailSvc = require('../services/email');

const router = express.Router();

router.get('/', async (req, res) => {
  const to = req.query.to || 'test@example.com';
  const diagnostics = {
    env_check: {
      SMTP_HOST:      !!process.env.SMTP_HOST,
      SMTP_PORT:      process.env.SMTP_PORT || 'not set',
      SMTP_USER:      !!process.env.SMTP_USER,
      SMTP_PASS:      !!process.env.SMTP_PASS,
      SMTP_PASS_len:  (process.env.SMTP_PASS || '').length,
      SMTP_FROM:      process.env.SMTP_FROM || 'not set',
    },
    nodemailer_loaded: null,
    send_result: null,
    send_error: null,
  };

  try {
    require('nodemailer');
    diagnostics.nodemailer_loaded = true;
  } catch (e) {
    diagnostics.nodemailer_loaded = false;
    diagnostics.nodemailer_error = e.message;
  }

  try {
    const r = await emailSvc.sendWelcome({
      to,
      firstName: 'Test',
      organizationName: 'SMTP Test',
    });
    diagnostics.send_result = r;
  } catch (err) {
    diagnostics.send_error = {
      message: err.message,
      code: err.code,
      command: err.command,
      responseCode: err.responseCode,
      response: err.response,
    };
  }

  res.json(diagnostics);
});

module.exports = router;
