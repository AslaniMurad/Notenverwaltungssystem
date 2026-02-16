// middleware/deviceDetection.js
// Middleware to detect mobile clients for server-side rendering.

function toBooleanOverride(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseNumericHeader(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function detectDevice(req, res, next) {
  const userAgent = String(req.headers["user-agent"] || "");
  const uaMobileRegex =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Windows Phone|Opera Mini|Mobile|CriOS/i;
  const isMobileByUa = uaMobileRegex.test(userAgent);

  const secChUaMobile = String(req.headers["sec-ch-ua-mobile"] || "");
  const isMobileByClientHint = secChUaMobile === "?1";

  const viewportWidth =
    parseNumericHeader(req.headers["viewport-width"]) ||
    parseNumericHeader(req.headers["sec-ch-viewport-width"]);
  const isMobileByViewport = viewportWidth != null && viewportWidth <= 900;

  const queryOverride = toBooleanOverride(req.query.mobile);
  const sessionOverride =
    req.session && typeof req.session.isMobile === "boolean" ? req.session.isMobile : null;

  const computedMobile = isMobileByClientHint || isMobileByViewport || isMobileByUa;
  const isMobile =
    queryOverride !== null ? queryOverride : sessionOverride !== null ? sessionOverride : computedMobile;

  res.locals.isMobile = isMobile;
  res.locals.deviceType = isMobile ? "mobile" : "desktop";

  if (req.session) {
    req.session.isMobile = isMobile;
  }

  next();
}

module.exports = { detectDevice };
