// middleware/deviceDetection.js
// Middleware to detect mobile devices

function detectDevice(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  const mobileHint = req.headers['sec-ch-ua-mobile'];

  // Keep matching strict to avoid desktop false positives.
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone/i;

  // Prefer client hint when available, fallback to user-agent matching.
  const hintedMobile = mobileHint === '?1' ? true : mobileHint === '?0' ? false : null;
  const isMobileByUserAgent = mobileRegex.test(userAgent);
  const isMobile = hintedMobile !== null ? hintedMobile : isMobileByUserAgent;

  // Optional query override, e.g. ?mobile=true
  const mobileQuery = String(req.query.mobile || '').toLowerCase();
  const isMobileByScreenWidth = mobileQuery === 'true' || mobileQuery === '1';

  res.locals.isMobile = isMobile || isMobileByScreenWidth;
  res.locals.deviceType = res.locals.isMobile ? 'mobile' : 'desktop';

  if (req.session) {
    req.session.isMobile = res.locals.isMobile;
  }

  next();
}

module.exports = { detectDevice };
