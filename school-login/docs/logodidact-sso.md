# LogoDIDACT SSO

Diese Anwendung unterstuetzt jetzt OpenID Connect SSO fuer LogoDIDACT/Keycloak und besitzt zusaetzlich einen eingebauten lokalen Mock-Provider zum Simulieren des kompletten Flows.

## Relevante Umgebungsvariablen

```env
SSO_ENABLED=true
SSO_ALLOW_LOCAL_LOGIN=true
SSO_DISPLAY_NAME=LogoDIDACT
SSO_PROVIDER_KEY=logodidact

# Bevorzugt: Issuer URL des LogoDIDACT-IDP
SSO_ISSUER=https://idp.example.school/realms/example-school

# Optional als Alternative, falls nur die Discovery-URL bekannt ist
# SSO_DISCOVERY_URL=https://idp.example.school/realms/example-school/.well-known/openid-configuration

SSO_CLIENT_ID=your-client-id
SSO_CLIENT_SECRET=your-client-secret

# Optional, wenn nicht automatisch aus Request/Host gebaut werden soll
# SSO_REDIRECT_URI=https://grades.example.school/auth/sso/callback
# SSO_POST_LOGOUT_REDIRECT_URI=https://grades.example.school/login

SSO_SCOPE=openid profile email
SSO_EMAIL_CLAIM=email
SSO_USERNAME_CLAIM=preferred_username
SSO_ROLE_CLAIM=role
SSO_AUTO_LINK_BY_EMAIL=true
SSO_AUTO_CREATE_USERS=false
SSO_REQUIRE_VERIFIED_EMAIL=false
```

## Lokale Simulation

Die Simulation benoetigt keinen externen Dienst.

```env
SSO_ENABLED=true
SSO_ALLOW_LOCAL_LOGIN=true
SSO_SIMULATION_ENABLED=true
SSO_DISPLAY_NAME=LogoDIDACT
```

Dann:

1. `npm install`
2. Optional auf bestehender Datenbank: `npm run migrate:sso`
3. App starten
4. `/login` aufrufen
5. Auf `Mit LogoDIDACT anmelden` klicken
6. Im Mock-Provider einen Demo-Benutzer waehlen

Standard-Testbenutzer fuer die lokale Simulation:

- `admin@test.local`
- `teacher@example.com`
- `student@example.com`

## Was der LogoDIDACT-Admin spaeter liefern muss

1. `Issuer URL` oder `Discovery URL`
2. `Client ID`
3. `Client Secret`
4. registrierte Redirect-URI: `/auth/sso/callback`
5. bestaetigte Claims fuer `email` und/oder `preferred_username`

## Wichtige Projektbesonderheit

Dieses Projekt ordnet Benutzer fachlich weiterhin lokal zu:

- Login und Rollen kommen aus der Tabelle `users`
- Schuelerprofile werden ueber `students.email` geladen

Deshalb muss die vom LogoDIDACT-IDP gelieferte E-Mail-Adresse mit `users.email` uebereinstimmen. Fuer Schueler muss sie zusaetzlich auch mit `students.email` zusammenpassen.
