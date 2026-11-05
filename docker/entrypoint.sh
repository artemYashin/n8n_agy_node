#!/bin/sh
set -eu

# Bind mounts can be created by Docker as root-owned empty directories.
# Seed the CLI from the image, then run the application as the node user.
mkdir -p /home/node/.n8n/agy-runtime /home/node/.gemini /home/node/.agy-api
cp -Rn /opt/agy-runtime/. /home/node/.n8n/agy-runtime/
chown -R node:node /home/node/.n8n /home/node/.gemini /home/node/.agy-api
chmod 700 /home/node/.gemini /home/node/.agy-api
exec su-exec node:node "$@"
