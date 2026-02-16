// TEST SCRIPT - Mobile Detection testen
// Füge dieses Script temporär zu einer View hinzu zum Testen

console.log('=== MOBILE DETECTION TEST ===');
console.log('User Agent:', navigator.userAgent);
console.log('Screen Width:', window.innerWidth);
console.log('Screen Height:', window.innerHeight);
console.log('Is Touch Device:', 'ontouchstart' in window);
console.log('Device Pixel Ratio:', window.devicePixelRatio);

// Prüfe ob Mobile-CSS geladen wurde
const mobileCSS = document.querySelector('link[href*="mobile.css"]');
console.log('Mobile CSS loaded:', !!mobileCSS);

// Prüfe Body-Klassen
console.log('Body classes:', document.body.className);

// Prüfe isMobile Variable (falls im Template gesetzt)
if (typeof isMobile !== 'undefined') {
  console.log('isMobile variable:', isMobile);
}

// Prüfe Mobile Nav Toggle
const mobileToggle = document.querySelector('.mobile-nav-toggle');
console.log('Mobile nav toggle found:', !!mobileToggle);

// Event Listener für Window Resize
window.addEventListener('resize', function() {
  console.log('Window resized to:', window.innerWidth, 'x', window.innerHeight);
});

console.log('=== END TEST ===');
