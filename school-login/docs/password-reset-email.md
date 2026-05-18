# Passwort-Zuruecksetzung per E-Mail

Admins koennen unter `/admin/users/<id>/edit` ein Einmalpasswort erzeugen. Das Passwort wird gehasht in `password_reset_requests` gespeichert, per E-Mail an den Nutzer gesendet und ist standardmaessig 24 Stunden gueltig. Beim Login wird es einmalig verbraucht; danach muss der Nutzer sofort ein neues Passwort setzen.

## Server-Konfiguration

1. Abhaengigkeiten installieren:

   ```bash
   npm install
   ```

2. In der Server-Umgebung oder `.env` SMTP konfigurieren. Standard ist lokaler Postfix auf Port 25 ohne Authentifizierung:

   ```env
   APP_BASE_URL=https://nvs.htlwydev.at
   EMAIL_DELIVERY_MODE=smtp
   SMTP_HOST=localhost
   SMTP_PORT=25
   SMTP_SECURE=false
   SMTP_REQUIRE_TLS=false
   SMTP_USER=
   SMTP_PASS=
   MAIL_FROM="NVS <no-reply@nvs.htlwydev.at>"
   PASSWORD_RESET_TTL_HOURS=24
   ONE_TIME_PASSWORD_LENGTH=16
   ```

   Hinweise:

   - Es wird keine externe Mail-API verwendet; die App liefert per SMTP an den lokalen Mailserver ein.
   - Wenn die App in einem Container laeuft, zeigt `localhost` auf den Container. Dann muss `SMTP_HOST` auf die erreichbare Host-/Gateway-IP oder einen Mailserver-Container-Namen gesetzt werden.
   - `APP_BASE_URL` muss die oeffentliche HTTPS-Adresse der App sein, damit der Login-Link in der E-Mail stimmt.
   - `EMAIL_DELIVERY_MODE=console` nur fuer Tests verwenden; am Server muss `smtp` aktiv sein.

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

- `Einmalpasswort wurde nicht versendet`: lokalen Postfix, Firewall, Container-Netzwerk und Postfix-Relay-Regeln pruefen.
- Mail kommt nicht an, aber die App meldet Erfolg: Spam-Ordner, SPF/DKIM/DMARC und SMTP-Provider-Logs pruefen.
