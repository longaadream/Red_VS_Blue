#!/usr/bin/env bash
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER=root@38.22.90.175
STAGING=/tmp/rvb-release-108

echo "Packaging candidate-gm6PW2..."
tar -czf "$SCRIPT_DIR/server-gm6PW2.tar.gz" -C "$SCRIPT_DIR/linux-room-server/candidate-gm6PW2" .

echo "Uploading to $SERVER:$STAGING ..."
ssh "$SERVER" "mkdir -p $STAGING"
scp "$SCRIPT_DIR/server-gm6PW2.tar.gz"   "$SERVER:$STAGING/server.tar.gz"
scp "$SCRIPT_DIR/install-profile-0112.cjs"                    "$SERVER:$STAGING/install-profile.cjs"
scp "$SCRIPT_DIR/../config/content-script-publishers.json"   "$SERVER:$STAGING/content-script-publishers.json"
scp "$SCRIPT_DIR/signed-1.0.8.rvbpack"                       "$SERVER:$STAGING/content.rvbpack"
scp "$SCRIPT_DIR/deploy-108.sh"            "$SERVER:$STAGING/deploy-108.sh"
ssh "$SERVER" "chmod +x $STAGING/deploy-108.sh"

echo "Upload complete."
echo "Run deploy with:  ssh $SERVER bash $STAGING/deploy-108.sh <target-name>"
echo "Example:          ssh $SERVER bash $STAGING/deploy-108.sh release-108-content-108"
