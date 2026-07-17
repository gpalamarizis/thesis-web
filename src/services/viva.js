// src/services/viva.js
// Viva Payments Smart Checkout integration.
//
// Flow:
//   1. Backend: getAccessToken() -> OAuth2 client credentials
//   2. Backend: createPaymentOrder(...) -> returns orderCode
//   3. Frontend: redirect to https://{demo.}vivapayments.com/web/checkout?ref=<orderCode>
//   4. Viva: after payment, redirects to FRONTEND_URL/subscription/success?t=<transactionId>&s=<orderCode>
//   5. Viva: also fires webhook to /api/viva/webhook
//   6. Backend: on webhook or explicit verify, calls transactions API to confirm
//
// Required env vars:
//   VIVA_ENV               'demo' | 'production'  (default: 'demo')
//   VIVA_CLIENT_ID         Smart Checkout OAuth client id
//   VIVA_CLIENT_SECRET     Smart Checkout OAuth client secret
//   VIVA_SOURCE_CODE       Payment source code from Viva dashboard
//   VIVA_MERCHANT_ID       Merchant ID (for webhook verification GET response)
//   VIVA_API_KEY           API Key (for webhook verification GET response)
//   FRONTEND_URL           e.g. https://thesis-frontend.gpal.workers.dev

function getEnv() {
  return process.env.VIVA_ENV || 'demo';
}

function getBaseUrls() {
  if (getEnv() === 'production') {
    return {
      accounts: 'https://accounts.vivapayments.com',
      api:      'https://api.vivapayments.com',
      checkout: 'https://www.vivapayments.com/web/checkout',
      legacy:   'https://www.vivapayments.com',
    };
  }
  return {
    accounts: 'https://demo-accounts.vivapayments.com',
    api:      'https://demo-api.vivapayments.com',
    checkout: 'https://demo.vivapayments.com/web/checkout',
    legacy:   'https://demo.vivapayments.com',
  };
}

// Cache access token
let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const { VIVA_CLIENT_ID, VIVA_CLIENT_SECRET } = process.env;
  if (!VIVA_CLIENT_ID || !VIVA_CLIENT_SECRET) {
    throw new Error('Viva credentials missing (VIVA_CLIENT_ID / VIVA_CLIENT_SECRET)');
  }

  const { accounts } = getBaseUrls();
  const basicAuth = Buffer.from(`${VIVA_CLIENT_ID}:${VIVA_CLIENT_SECRET}`).toString('base64');

  const r = await fetch(`${accounts}/connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Viva OAuth failed: ${r.status} ${t}`);
  }

  const d = await r.json();
  cachedToken = { token: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
  return cachedToken.token;
}

/**
 * Create Viva payment order.
 *   amount: EUR (decimal, e.g. 199.90)
 *   customerEmail, customerName?, customerPhone?
 *   orderId: internal reference (goes to merchantTrns for webhook matching)
 *   description: shown on checkout page
 * Returns: orderCode (integer) → use in checkout URL
 */
async function createPaymentOrder({ amount, customerEmail, customerName, customerPhone, orderId, description }) {
  const { VIVA_SOURCE_CODE, FRONTEND_URL } = process.env;
  if (!VIVA_SOURCE_CODE) throw new Error('VIVA_SOURCE_CODE not configured');

  const token = await getAccessToken();
  const { api } = getBaseUrls();
  const [firstName, ...rest] = String(customerName || '').split(' ');

  const body = {
    amount: Math.round(Number(amount) * 100), // cents
    customerTrns: description || 'Thesis Subscription',
    customer: {
      email: customerEmail,
      fullName: customerName || undefined,
      phone: customerPhone || undefined,
      countryCode: 'GR',
      requestLang: 'el-GR',
    },
    paymentTimeout: 1800,           // 30 min
    preauth: false,
    allowRecurring: false,
    maxInstallments: 0,
    disableCash: true,
    disableWallet: false,
    sourceCode: VIVA_SOURCE_CODE,
    merchantTrns: orderId,           // <-- our internal reference
    tags: ['thesis-subscription'],
    successUrl: FRONTEND_URL ? `${FRONTEND_URL}/subscription/success` : undefined,
    failureUrl: FRONTEND_URL ? `${FRONTEND_URL}/subscription/failure` : undefined,
  };

  const r = await fetch(`${api}/checkout/v2/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Viva order failed: ${r.status} ${t}`);
  }
  const d = await r.json();
  return { orderCode: d.orderCode };
}

/**
 * Get checkout URL for a given orderCode.
 */
function getCheckoutUrl(orderCode) {
  return `${getBaseUrls().checkout}?ref=${orderCode}`;
}

/**
 * Verify a transaction (called from webhook or success return).
 * Returns transaction details or throws.
 */
async function verifyTransaction(transactionId) {
  const token = await getAccessToken();
  const { api } = getBaseUrls();
  const r = await fetch(`${api}/checkout/v2/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Viva verify failed: ${r.status} ${t}`);
  }
  return r.json();
}

/**
 * Webhook verification key. Viva calls GET on webhook URL first and expects { Key: <key> }.
 * The key must come from Viva API (not env static value).
 */
async function getWebhookVerificationKey() {
  const { VIVA_MERCHANT_ID, VIVA_API_KEY } = process.env;
  if (!VIVA_MERCHANT_ID || !VIVA_API_KEY) throw new Error('VIVA_MERCHANT_ID / VIVA_API_KEY not configured');

  const { legacy } = getBaseUrls();
  const basicAuth = Buffer.from(`${VIVA_MERCHANT_ID}:${VIVA_API_KEY}`).toString('base64');

  const r = await fetch(`${legacy}/api/messages/config/token`, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!r.ok) throw new Error(`Viva webhook key fetch failed: ${r.status}`);
  const d = await r.json();
  return d.Key;
}

module.exports = {
  getAccessToken,
  createPaymentOrder,
  getCheckoutUrl,
  verifyTransaction,
  getWebhookVerificationKey,
  getEnv,
};
