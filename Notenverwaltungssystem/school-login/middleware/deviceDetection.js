// middleware/deviceDetection.js
// Middleware zur Erkennung von mobilen Geräten

function detectDevice(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  
  // Liste von mobilen Geräte-Identifikatoren
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
  
  // Prüfe ob der User-Agent einen mobilen Identifier enthält
  const isMobile = mobileRegex.test(userAgent);
  
  // Alternativ: Prüfe auch die Bildschirmbreite über einen Query-Parameter (optional)
  // Dies kann später via JavaScript Client-Side gesetzt werden
  const isMobileByScreenWidth = req.query.mobile === 'true';
  
  // Setze die Information in res.locals, damit sie in allen Views verfügbar ist
  res.locals.isMobile = isMobile || isMobileByScreenWidth;
  res.locals.deviceType = res.locals.isMobile ? 'mobile' : 'desktop';
  
  // Optional: Setze auch in der Session für persistent tracking
  if (req.session) {
    req.session.isMobile = res.locals.isMobile;
  }
  
  next();
}

module.exports = { detectDevice };
