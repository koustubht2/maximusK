// Netlify serverless function — proxies ALL Oura API requests
// Handles: token exchange, token refresh, and data API calls
exports.handler = async (event) => {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }

  const CLIENT_ID = 'c90143af-0a79-478d-97a5-76ba08c2e76d';
  const CLIENT_SECRET = 'ZOGmMiUKvPbO3kEqQfo6-X1_zEAtUms3SOzTjhipAVc';
  const REDIRECT_URI = 'https://maximusk.netlify.app/';

  try {
    const params = JSON.parse(event.body);

    // ── TOKEN EXCHANGE / REFRESH ──
    if (params.action === 'token') {
      const body = new URLSearchParams({
        grant_type: params.grant_type,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      });
      if (params.grant_type === 'authorization_code') {
        body.set('code', params.code);
      } else if (params.grant_type === 'refresh_token') {
        body.set('refresh_token', params.refresh_token);
      }
      const res = await fetch('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json();
      return {
        statusCode: res.ok ? 200 : res.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    // ── DATA API PROXY ──
    if (params.action === 'api') {
      const url = 'https://api.ouraring.com' + params.endpoint +
        (params.qs ? '?' + new URLSearchParams(params.qs).toString() : '');
      const res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + params.access_token },
      });
      const data = await res.json();
      return {
        statusCode: res.ok ? 200 : res.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unknown action' }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
