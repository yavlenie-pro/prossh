#!/usr/bin/env node
// Sync the bundle version across Tauri/Cargo manifests.
//
// Invoked from the release workflow right after the tag is parsed so that
// `tauri build` emits artefacts named after the tag (e.g. `ProSSH_0.1.1_*`)
// instead of whatever was last committed to `src-tauri/tauri.conf.json`.
//
// Pre-release / build metadata (`-rc.2`, `+sha.abc`) are STRIPPED before the
// version is stamped into the manifests: Windows Installer's ProductVersion
// field is a 4-part numeric ("1.2.3.4") string and the MSI/WiX bundler errors
// out on semver pre-release suffixes. The About dialog keeps the full tag
// (including `-rc.N`) via PROSSH_BUILD_VERSION — see src-tauri/build.rs.
//
// Usage: node scripts/set-version.mjs <version>
//   <version>  semver string without the leading `v` (e.g. `0.1.1` or `0.1.1-rc.1`)

import fs from 'node:fs';

const rawVersion = process.argv[2];
if (!rawVersion) {
  console.error('usage: set-version.mjs <version>');
  process.exit(1);
}

const bundleVersion = rawVersion.replace(/[-+].*$/, '');

// --- tauri.conf.json ------------------------------------------------------
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = bundleVersion;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

// --- src-tauri/Cargo.toml -------------------------------------------------
// Only touch the first `version = "..."` line, which belongs to [package].
// Dependencies further down also use `version = "..."` and must stay put.
const cargoPath = 'src-tauri/Cargo.toml';
const cargo = fs.readFileSync(cargoPath, 'utf8');
const versionRe = /^version = "[^"]+"/m;
if (!versionRe.test(cargo)) {
  console.error(`failed to find package version line in ${cargoPath}`);
  process.exit(1);
}
fs.writeFileSync(cargoPath, cargo.replace(versionRe, `version = "${bundleVersion}"`));

if (bundleVersion === rawVersion) {
  console.log(`bundle version → ${bundleVersion}`);
} else {
  console.log(`bundle version → ${bundleVersion} (stripped pre-release from ${rawVersion}; About dialog keeps full via PROSSH_BUILD_VERSION)`);
}
