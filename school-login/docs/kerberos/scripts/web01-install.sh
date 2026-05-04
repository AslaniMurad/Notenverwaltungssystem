#!/usr/bin/env bash
set -euo pipefail

sudo tee /etc/apt/apt.conf.d/99force-ipv4 >/dev/null <<'EOF'
Acquire::ForceIPv4 "true";
EOF

sudo apt clean
sudo apt update
sudo apt install -y apache2 libapache2-mod-auth-gssapi krb5-user git curl build-essential nodejs npm
sudo a2enmod ssl proxy proxy_http headers auth_gssapi rewrite
sudo systemctl restart apache2

echo "WEB01 base packages installed."
