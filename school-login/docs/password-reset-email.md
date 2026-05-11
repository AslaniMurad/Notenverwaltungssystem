# Passwort-Zuruecksetzung per E-Mail

Admins koennen unter `/admin/users/<id>/edit` ein Einmalpasswort erzeugen. Das Passwort wird gehasht in `password_reset_requests` gespeichert, per E-Mail an den Nutzer gesendet und ist standardmaessig 24 Stunden gueltig. Beim Login wird es einmalig verbraucht; danach muss der Nutzer sofort ein neues Passwort setzen.

## Server-Konfiguration

1. Abhaengigkeiten installieren:

   ```bash
   npm install
   ```

2. In der Server-Umgebung oder `.env` SMTP konfigurieren:

   ```env
   APP_BASE_URL=https://deine-nvs-domain.example
   EMAIL_DELIVERY_MODE=smtp
   SMTP_HOST=smtp.example.at
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_REQUIRE_TLS=true
   SMTP_USER=nvs@example.at
   SMTP_PASS=dein-smtp-passwort
   MAIL_FROM="NVS <nvs@example.at>"
   PASSWORD_RESET_TTL_HOURS=24
   ONE_TIME_PASSWORD_LENGTH=16
   ```

   Hinweise:

   - Fuer Port `465` normalerweise `SMTP_SECURE=true` setzen.
   - Fuer Port `587` normalerweise `SMTP_SECURE=false` und `SMTP_REQUIRE_TLS=true` setzen.
   - `APP_BASE_URL` muss die oeffentliche HTTPS-Adresse der App sein, damit der Login-Link in der E-Mail stimmt.
   - `EMAIL_DELIVERY_MODE=console` nur lokal verwenden; am Server muss `smtp` aktiv sein.

3. App neu starten:

   ```bash
   npm run start
   ```

   Bei systemd entsprechend:

   ```bash
   sudo systemctl restart nvs
   sudo journalctl -u nvs -n 100 --no-pager
   ```

4. Funktion testen:

   - Als Admin anmelden.
   - `/admin/users/<id>/edit` oeffnen.
   - `Einmalpasswort senden` ausloesen.
   - Pruefen, ob die E-Mail beim Nutzer ankommt.
   - Nutzer meldet sich mit dem Einmalpasswort an und setzt danach ein neues Passwort.

## Fehlerdiagnose

- `Mailversand ist nicht konfiguriert`: `SMTP_HOST`, `SMTP_PORT` und `MAIL_FROM` fehlen oder werden vom Prozess nicht geladen.
- `Einmalpasswort wurde nicht versendet`: SMTP-Zugangsdaten, Firewall, TLS-Einstellungen oder Provider-Limits pruefen.
- Mail kommt nicht an, aber die App meldet Erfolg: Spam-Ordner, SPF/DKIM/DMARC und SMTP-Provider-Logs pruefen.
