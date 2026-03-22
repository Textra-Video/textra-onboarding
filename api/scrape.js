export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const url = req.query && req.query.url;
  if (!url) { res.status(400).json({ error: 'No URL' }); return; }
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await r.text();
    res.status(200).json({ contents: html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
