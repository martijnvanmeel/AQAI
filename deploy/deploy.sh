#!/usr/bin/env bash
# Run this locally on your Mac whenever a new version is ready to publish.
# It pulls the latest committed code on the server and restarts the service.
# Usage: deploy/deploy.sh user@your-vps-ip-or-hostname
set -euo pipefail
HOST="${1:?Usage: deploy.sh user@host}"
ssh "$HOST" 'sudo -u aqai git -C /opt/aqai/player pull && sudo systemctl restart aqai'
echo "Deployed."
