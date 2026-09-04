const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'https://c961b78d0a57151e06078c75129d144e@o4512022016688128.ingest.de.sentry.io/4512022043230288',
  tracesSampleRate: 1.0,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const url = req.query.url;
  if (!url) { res.status(400).json({ error: 'No URL' }); return; }
  try {
    const r = await fetch(decodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await r.text();
    res.status(200).json({ contents: html });
  } catch (err) {
    Sentry.captureException(err);
    await Sentry.flush(2000);
    res.status(500).json({ error: err.message });
  }
};
