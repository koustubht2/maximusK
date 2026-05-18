module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const CLIENT_ID = 'c90143af-0a79-478d-97a5-76ba08c2e76d';
  const CLIENT_SECRET = 'ZOGmMiUKvPbO3kEqQfo6-X1_zEAtUms3SOzTjhipAVc';
  const REDIRECT_URI = 'https://maximusk.vercel.app/';

  try {
    const params = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

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
      const fetchRes = await fetch('https://api.ouraring.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await fetchRes.json();
      return res.status(fetchRes.ok ? 200 : fetchRes.status).json(data);
    }

    if (params.action === 'api') {
      const url = 'https://api.ouraring.com' + params.endpoint +
        (params.qs ? '?' + new URLSearchParams(params.qs).toString() : '');
      const fetchRes = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + params.access_token },
      });
      const data = await fetchRes.json();
      return res.status(fetchRes.ok ? 200 : fetchRes.status).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
