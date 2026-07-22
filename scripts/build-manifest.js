#!/usr/bin/env node
'use strict';

// Generates manifest.json (gitignored) from manifest.template.json (tracked)
// by substituting values loaded from .env (also gitignored).
//
// Usage: node scripts/build-manifest.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const TEMPLATE_PATH = path.join(ROOT, 'manifest.template.json');
const OUTPUT_PATH = path.join(ROOT, 'manifest.json');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing ${path.basename(filePath)}. Copy .env.example to .env and fill in your values first.`);
    process.exit(1);
  }

  const env = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip matching surrounding quotes, if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function main() {
  const env = loadEnvFile(ENV_PATH);

  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId || clientId.includes('your-client-id-here')) {
    console.error('GOOGLE_OAUTH_CLIENT_ID is missing or still set to the placeholder in .env.');
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const output = template.replace(/__GOOGLE_OAUTH_CLIENT_ID__/g, clientId);

  // Sanity-check the result is valid JSON before writing it out
  JSON.parse(output);

  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${path.basename(OUTPUT_PATH)} with your OAuth client ID.`);
}

main();
