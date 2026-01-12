# Mobile Version - Notenverwaltungssystem

## Übersicht

Das Notenverwaltungssystem erkennt automatisch, ob du mit einem Handy oder PC eingeloggt bist und passt die Ansicht entsprechend an.

## Wie funktioniert die Erkennung?

### Automatische Device-Detection

Die Middleware `deviceDetection.js` analysiert den User-Agent des Browsers:
- **Mobile Geräte**: Android, iPhone, iPad, iPod, BlackBerry, Windows Phone, etc.
- **Desktop**: Alle anderen Geräte

### Was passiert bei Mobile?

1. **Automatisches Laden von Mobile-CSS**
   - `mobile.css` - Generelle mobile Optimierungen
   - `mobile-sidebar.css` - Spezielle Sidebar-Anpassungen

2. **Mobile Navigation**
   - Hamburger-Menu Button (☰) oben links
   - Sidebar wird als Overlay von links eingeblendet
   - Touch-optimierte Buttons und Links

3. **Responsive Tabellen**
   - Tabellen werden automatisch für kleine Bildschirme umformatiert
   - Cards-Layout statt Tabellen-Spalten
   - Horizontales Scrollen wenn nötig

## Features der Mobile-Version

### 🎨 Design-Anpassungen

- **Größere Touch-Targets**: Mindestens 44x44px für alle klickbaren Elemente
- **Optimierte Schriftgrößen**: Bessere Lesbarkeit auf kleinen Bildschirmen
- **Vereinfachtes Layout**: Single-Column Design
- **Mobile-optimierte Formulare**: Verhindert ungewolltes Zoomen auf iOS

### 📱 Navigation

- **Sliding Sidebar**: Öffnet sich von links mit Animation
- **Overlay-Hintergrund**: Verdunkelt den Inhalt wenn Sidebar offen
- **Auto-Close**: Schließt sich bei Klick außerhalb

### 📊 Tabellen & Listen

- **Card-basierte Ansicht**: Tabellen werden zu Cards umgewandelt
- **Data-Labels**: Jede Zelle zeigt ihren Header-Titel
- **Bessere Übersicht**: Kompaktere Darstellung wichtiger Daten

### ⚡ Performance

- **Conditional Loading**: Mobile-CSS wird nur auf Mobilgeräten geladen
- **Touch-Optimierungen**: Schnellere Touch-Reaktionen
- **Lazy Loading**: Optimierte Bild- und Ressourcen-Ladung

## Technische Details

### Dateien

```
school-login/
├── middleware/
│   └── deviceDetection.js        # Device-Erkennung
├── public/
│   ├── css/
│   │   ├── mobile.css            # Mobile Styles
│   │   └── mobile-sidebar.css    # Sidebar Mobile
│   └── js/
│       └── mobile-nav.js         # Mobile Navigation Logic
└── views/
    └── layout.ejs                 # Conditional CSS/JS Loading
```

### Verwendung in Views

```ejs
<!-- Prüfe ob Mobile -->
<% if (locals.isMobile) { %>
  <button class="mobile-nav-toggle"></button>
<% } %>

<!-- Device-spezifische Klassen -->
<div class="<%= locals.isMobile ? 'mobile-only' : 'desktop-only' %>">
  ...
</div>
```

### Middleware Integration

Die Middleware setzt automatisch diese Variablen:
- `res.locals.isMobile` (Boolean)
- `res.locals.deviceType` ('mobile' oder 'desktop')
- `req.session.isMobile` (persistent in Session)

## Testen

### Mobile-Ansicht testen ohne Handy

1. **Browser DevTools**
   - F12 drücken
   - "Toggle Device Toolbar" (Ctrl+Shift+M)
   - Gerät auswählen (z.B. iPhone, Galaxy)

2. **URL-Parameter**
   - Füge `?mobile=true` an die URL
   - Beispiel: `http://localhost:3000/?mobile=true`

3. **User-Agent ändern**
   - Browser Extensions wie "User-Agent Switcher"

## Weitere Anpassungen für andere Views

### Beispiel: Admin-Seite Mobile machen

1. **View anpassen** ([views/admin/index.ejs](views/admin/index.ejs))
```ejs
<% if (locals.isMobile) { %>
  <button class="mobile-nav-toggle"></button>
<% } %>
```

2. **Spezifische CSS hinzufügen** (falls nötig)
```css
.mobile-view .admin-table {
  /* Mobile-spezifische Styles */
}
```

## CSS-Klassen

### Helper-Klassen

- `.mobile-only` - Nur auf Mobile sichtbar
- `.desktop-only` - Nur auf Desktop sichtbar
- `.mobile-view` - Wird automatisch zum Body hinzugefügt
- `.desktop-view` - Wird automatisch zum Body hinzugefügt

### Komponenten

- `.mobile-nav-toggle` - Hamburger Menu Button
- `.mobile-active` - Sidebar ist geöffnet
- `.touch-target` - Optimierte Touch-Größe

## Browser-Kompatibilität

✅ iOS Safari (iPhone/iPad)
✅ Chrome Mobile (Android)
✅ Samsung Internet
✅ Firefox Mobile
✅ Opera Mobile

## Performance-Tipps

1. **Bilder optimieren**: Verwende `srcset` für verschiedene Auflösungen
2. **Touch Events**: Nutze `touch-action` für bessere Touch-Performance
3. **Viewport**: Meta-Tag ist bereits gesetzt für optimale Darstellung
4. **Caching**: Mobile-CSS wird vom Browser gecached

## Bekannte Einschränkungen

- Sehr alte Browser (< IE11) werden nicht unterstützt
- Einige komplexe Tabellen benötigen Desktop-Ansicht
- PDF-Export funktioniert besser auf Desktop

## Support & Fragen

Bei Problemen oder Fragen zur Mobile-Version:
- Check Browser Console für Fehler
- Teste mit verschiedenen Geräten
- Prüfe ob `isMobile` korrekt erkannt wird (Console-Log in mobile-nav.js)

---

**Version**: 1.0  
**Erstellt**: Januar 2026  
**Projekt**: HTL Waidhofen Notenverwaltungssystem
