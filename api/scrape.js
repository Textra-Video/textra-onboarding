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
    res.status(500).json({ error: err.message });
  }
};
