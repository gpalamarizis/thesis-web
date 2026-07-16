// src/utils/mydata-client.js
// Thin HTTP client for the AADE myDATA REST API.
//
// Uses Node 18+ built-in fetch. No external deps.

const ENDPOINTS = {
  dev:  'https://mydata-dev.azure-api.net',
  prod: 'https://mydatapi.aade.gr/myDATA',
};

function endpointFor(env) {
  return ENDPOINTS[env] || ENDPOINTS.dev;
}

async function post(path, xml, { env, userId, subscriptionKey }) {
  const url = endpointFor(env) + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'aade-user-id':            userId,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'Content-Type':            'text/xml',
      'Accept':                  'application/xml',
    },
    body: xml,
  });
  const body = await res.text();
  return {
    ok:     res.ok,
    status: res.status,
    body,
  };
}

// SendInvoices — POST XML body with InvoicesDoc
async function sendInvoices(xml, creds) {
  return post('/SendInvoices', xml, creds);
}

// CancelInvoice — parametric, no body
async function cancelInvoice(mark, creds) {
  const url = endpointFor(creds.env) + `/CancelInvoice?mark=${encodeURIComponent(mark)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'aade-user-id':            creds.userId,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
      'Accept':                  'application/xml',
    },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// RequestDocs — used later to verify status or fetch received invoices
async function requestDocs(mark, creds) {
  const url = endpointFor(creds.env) + `/RequestDocs?mark=${encodeURIComponent(mark)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'aade-user-id':            creds.userId,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
      'Accept':                  'application/xml',
    },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

module.exports = {
  sendInvoices,
  cancelInvoice,
  requestDocs,
  endpointFor,
};
