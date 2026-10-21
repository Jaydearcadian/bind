#!/usr/bin/env bash
# Vercel build: the API function, the browser SDK, and the static site in public/ (ADR 0054, 0056).
# It lives in a script because Vercel rejects a buildCommand longer than 256 characters.
set -euo pipefail
npm run build:vercel
npm run sdk:build
npm run web:bundle
rm -rf public
mkdir -p public/brand
cp -r web/. public/
cp docs/brand/tokens.css public/brand/
cp -r docs/brand/fonts public/brand/fonts
cp -r docs/brand/assets public/brand/assets
node scripts/copy-sdk-browser.mjs public/sdk
