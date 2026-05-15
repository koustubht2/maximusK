// Netlify serverless function — proxies Oura OAuth token exchange
// so the client secret stays server-side and CORS is avoided.
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

  try {
    const params = JSON.parse(event.body);

    const body = new URLSearchParams({
      grant_type: params.grant_type,
      client_id: 'c90143af-0a79-478d-97a5-76ba08c2e76d',
      client_secret: 'ZOGmMiUKvPbO3kEqQfo6-X1_zEAtUms3SOzTjhipAVc',
      redirect_uri: 'https://maximusk.netlify.app/',
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
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
