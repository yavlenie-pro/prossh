#!/usr/bin/env node
// Sync the bundle version across Tauri/Cargo manifests.
//
// Invoked from the release workflow right after the tag is parsed so that
// `tauri build` emits artefacts named after the tag (e.g. `ProSSH_0.1.1-rc.1_*`)
// instead of whatever was last committed to `src-tauri/tauri.conf.json`.
//
// Usage: node scripts/set-version.mjs <version>
//   <version>  semver string without the leading `v` (e.g. `0.1.1` or `0.1.1-rc.1`)

import fs from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: set-version.mjs <version>');
  process.exit(1);
}

// --- tauri.conf.json ------------------------------------------------------
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = version;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

// --- src-tauri/Cargo.toml -------------------------------------------------
// Only touch the first `version = "..."` line, which belongs to [package].
// Dependencies further down also use `version = "..."` and must stay put.
const cargoPath = 'src-tauri/Cargo.toml';
const cargo = fs.readFileSync(cargoPath, 'utf8');
const patched = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (patched === cargo) {
  console.error(`failed to find package version line in ${cargoPath}`);
  process.exit(1);
}
fs.writeFileSync(cargoPath, patched);

console.log(`bundle version → ${version}`);
