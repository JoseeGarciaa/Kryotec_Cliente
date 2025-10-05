#!/usr/bin/env bash
set -euo pipefail

# Silence Browserslist old data warnings inside Railway builds
export BROWSERSLIST_IGNORE_OLD_DATA=1
# Railway sets npm_config_production=true by default; clear it so dev deps remain available
export NPM_CONFIG_PRODUCTION=
export npm_config_production=

# Ensure latest browserslist DB so tailwind stops warning
npx update-browserslist-db@latest --quiet || true

# Build assets and TypeScript without invoking `npm run` (avoids deprecation warnings in Railway logs)
npx tailwindcss -c tailwind.config.cjs -i ./src/styles/tailwind.css -o ./public/css/app.css --minify
npx tsc -p .

# Launch the server
node dist/server.js
