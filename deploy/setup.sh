#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu/Debian VPS. Run once, as root
# (e.g. `sudo bash setup.sh`), after DNS for your domain already points
# at this server's IP.
set -euo pipefail

# public repo -> plain HTTPS clone, no SSH key needed on this VPS at all
GIT_REMOTE="https://github.com/martijnvanmeel/AQAI.git"

# 1. packages -----------------------------------------------------------
apt-get update
apt-get install -y python3 rsync git curl debian-keyring debian-archive-keyring apt-transport-https gnupg

# Caddy's official apt repo (verified against https://caddyserver.com/docs/install).
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# 2. dedicated, unprivileged user + directory ---------------------------
id -u aqai &>/dev/null || useradd -r -m -d /opt/aqai -s /usr/sbin/nologin aqai
mkdir -p /opt/aqai
chown aqai:aqai /opt/aqai

# 3. app code -------------------------------------------------------------
sudo -u aqai git clone "$GIT_REMOTE" /opt/aqai/player

# 4. wire up the service + reverse proxy --------------------------------
cp /opt/aqai/player/deploy/aqai.service /etc/systemd/system/aqai.service
cp /opt/aqai/player/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now aqai
systemctl reload caddy

echo
echo "Server code is running. Two things still needed:"
echo "  1. rsync your media library into /opt/aqai/ (see deploy/README.md)"
echo "  2. confirm your domain's DNS A/AAAA records point at this server's IP"
