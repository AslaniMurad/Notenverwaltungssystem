# SSO Ist-Zustand

Diese Datei dokumentiert, wie das Single Sign-on im Projekt aktuell implementiert ist.

## Zielbild

Die Anwendung unterstuetzt derzeit zwei Login-Arten:

- lokalen Login mit `E-Mail + Passwort`
- OIDC-basierten SSO-Login ueber `LogoDIDACT` oder den eingebauten lokalen Mock-Provider

Die eigentliche Fachlogik der Anwendung bleibt lokal. SSO ersetzt nur die Anmeldung.

## Aktueller Einstieg

Relevante Routen:

- `GET /login`
- `POST /login`
- `GET /auth/sso/start`
- `GET /auth/sso/callback`
- `POST /logout`
- `GET /dev/mock-oidc/.well-known/openid-configuration`
- `GET /dev/mock-oidc/authorize`
- `POST /dev/mock-oidc/token`
- `GET|POST /dev/mock-oidc/userinfo`

Nach erfolgreichem Login leitet `/` direkt in den Rollenbereich weiter:

- `admin -> /admin`
- `teacher -> /teacher`
- `student -> /student`

## Session-Verhalten

Die App verwendet serverseitige Sessions mit `express-session`.

- Session-Cookie: `sid`
- `httpOnly: true`
- `sameSite: "lax"`
- `secure: true` nur in Production
- `maxAge: 1 Stunde`

Wichtig:

- Das Schließen des Browsers loescht die Session nicht automatisch.
- Solange Cookie und Session noch gueltig sind, bleibt der Benutzer eingeloggt.
- Nach Ablauf der App-Session kann bei echtem SSO spaeter ein erneutes Login oft unbemerkt erfolgen, wenn die Session beim externen IdP noch aktiv ist.

## Wie der SSO-Flow aktuell funktioniert

### 1. Start

Beim Klick auf `Mit LogoDIDACT anmelden` wird `GET /auth/sso/start` aufgerufen.

Dabei werden fuer OIDC erzeugt und in der Session gespeichert:

- `state`
- `nonce`
- `PKCE code_verifier`
- optional `returnTo`

### 2. Weiterleitung zum IdP

Danach wird zur Authorization-URL des IdP weitergeleitet.

Aktuell gibt es zwei Modi:

- echter OIDC-Provider ueber `SSO_ISSUER` oder `SSO_DISCOVERY_URL`
- lokaler Mock-Provider ueber `SSO_SIMULATION_ENABLED=true`

### 3. Callback

`GET /auth/sso/callback` tauscht den Authorization Code gegen Tokens und liest Claims aus:

- `sub`
- `email`
- `preferred_username`
- optional `role`

### 4. Lokale Benutzerzuordnung

Die Anwendung uebernimmt Rollen und Berechtigungen nicht automatisch aus dem externen Token, sondern ordnet zuerst lokal zu.

Zuordnung in dieser Reihenfolge:

1. Suche in `users` nach `auth_provider + auth_subject`
2. Falls nicht gefunden und erlaubt: Suche in `users` nach `email`
3. Falls gefunden und noch nicht verknuepft: lokale Verknuepfung mit `auth_provider + auth_subject`
4. Optional koennte ein Benutzer automatisch angelegt werden, ist aktuell aber standardmaessig deaktiviert

## Aktuelle Datenbank-Felder fuer SSO

In `users` wurden folgende Felder fuer SSO ergaenzt:

- `auth_provider`
- `auth_subject`
- `email_verified`
- `local_login_enabled`
- `last_sso_login`

Zusatz:

- eindeutiger Index auf `(auth_provider, auth_subject)`

## Wichtige Projektbesonderheit

Die Anwendung arbeitet fachlich weiterhin lokal mit E-Mail-Zuordnung:

- Login-Zuordnung: `users.email`
- Rollen: `users.role`
- Schuelerbereich: `students.email`

Deshalb gilt:

- Die vom IdP gelieferte E-Mail muss zu `users.email` passen.
- Bei Schuelern muss sie zusaetzlich zu `students.email` passen.

Wenn der IdP keine echte Mailadresse liefert, sondern nur ein Konto-Kuerzel, reicht die aktuelle Standardkonfiguration nicht aus.

## Mock-Provider fuer lokale Simulation

Wenn `SSO_SIMULATION_ENABLED=true` gesetzt ist, stellt die App selbst einen lokalen OIDC-Testprovider bereit.

Zweck:

- End-to-End-Test ohne Zugriff auf die echte LogoDIDACT-Organisation
- realistische Simulation von Discovery, Authorize, Token und UserInfo

Standard-Demo-Benutzer:

- `admin@test.local`
- `teacher@example.com`
- `student@example.com`

## Aktuelle Standard-Umgebungsvariablen fuer Simulation

```env
SSO_ENABLED=true
SSO_ALLOW_LOCAL_LOGIN=true
SSO_SIMULATION_ENABLED=true
SSO_DISPLAY_NAME=LogoDIDACT
SSO_PROVIDER_KEY=logodidact
```

## Logout-Verhalten

Beim Logout wird die lokale Session zerstoert.

- bei lokalem Login: Weiterleitung zu `/login`
- bei SSO-Login: Weiterleitung zur gespeicherten Logout-URL des IdP, falls vorhanden

## Bekannte Annahmen

- SSO dient derzeit primaer der Authentifizierung.
- Rollenverwaltung bleibt lokal in der Anwendung.
- Benutzeranlage und Pflege bleiben derzeit lokal im System.
- Automatisches Benutzer-Anlegen ueber externe Claims ist im Code vorbereitet, aber standardmaessig nicht aktiv.

## Technische Referenzen im Projekt

- `server.js`
- `services/ssoService.js`
- `views/login.ejs`
- `views/mock-oidc-login.ejs`
- `db.js`
- `migrate_add_sso_columns.js`
