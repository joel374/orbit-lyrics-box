#!/usr/bin/env node

/**
 * All-in-One Release Tool for Orbit Lyrics Box
 * Syncs version across package.json, Git, VS Code Marketplace, and Open VSX.
 *
 * Usage:
 *   npm run release <patch|minor|major|version>
 *   Example:
 *     npm run release patch    (e.g. 1.0.2 -> 1.0.3)
 *     npm run release 1.0.3
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PKG_PATH = path.join(ROOT_DIR, "package.json");
const EXT_PATH = path.join(ROOT_DIR, "extension.js");
const README_PATH = path.join(ROOT_DIR, "README.md");
const ENV_PATH = path.join(ROOT_DIR, ".env");

// Auto-load .env if present
if (fs.existsSync(ENV_PATH)) {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

function run(cmd, opts = {}) {
  console.log(`\x1b[36m> ${cmd}\x1b[0m`);
  return execSync(cmd, { cwd: ROOT_DIR, stdio: "inherit", ...opts });
}

function bumpVersion(current, bumpType) {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver version: ${current}`);
  }
  let [major, minor, patch] = parts;

  if (bumpType === "patch") patch += 1;
  else if (bumpType === "minor") { minor += 1; patch = 0; }
  else if (bumpType === "major") { major += 1; minor = 0; patch = 0; }
  else if (/^\d+\.\d+\.\d+$/.test(bumpType)) return bumpType;
  else throw new Error(`Unknown bump type or version: "${bumpType}". Use patch, minor, major, or explicit version (e.g. 1.0.3)`);

  return `${major}.${minor}.${patch}`;
}

async function main() {
  const targetBump = process.argv[2] || "patch";
  console.log(`\n\x1b[35m=== Orbit Lyrics Box Release Tool ===\x1b[0m\n`);

  // 1. Read package.json
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, targetBump);

  console.log(`Bumping version: \x1b[33m${oldVersion}\x1b[0m -> \x1b[32m${newVersion}\x1b[0m\n`);

  // 2. Run Tests
  console.log(`\x1b[34m[1/6] Running test suite...\x1b[0m`);
  run("npm test");

  // 3. Update package.json
  console.log(`\n\x1b[34m[2/6] Updating version in files...\x1b[0m`);
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

  // Update extension.js USER_AGENT
  let extContent = fs.readFileSync(EXT_PATH, "utf8");
  extContent = extContent.replace(
    /const USER_AGENT = "OrbitLyricsBox\/[^"]+";/,
    `const USER_AGENT = "OrbitLyricsBox/${newVersion}";`
  );
  fs.writeFileSync(EXT_PATH, extContent);

  // Update README.md version references & vsix filename
  let readmeContent = fs.readFileSync(README_PATH, "utf8");
  readmeContent = readmeContent.replace(
    /version-[0-9.]+-blue\.svg/g,
    `version-${newVersion}-blue.svg`
  ).replace(
    /orbit-lyrics-box-[0-9.]+\.vsix/g,
    `orbit-lyrics-box-${newVersion}.vsix`
  );
  fs.writeFileSync(README_PATH, readmeContent);
  console.log(`Updated package.json, extension.js, and README.md.`);

  // 4. Package VSIX
  console.log(`\n\x1b[34m[3/6] Packaging VSIX bundle...\x1b[0m`);
  run("npx vsce package");
  const vsixFile = `orbit-lyrics-box-${newVersion}.vsix`;

  // 5. Commit and Git Tag
  console.log(`\n\x1b[34m[4/6] Committing to Git and creating Tag v${newVersion}...\x1b[0m`);
  run(`git add -A`);
  run(`git commit -m "release: v${newVersion}"`);
  run(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
  run(`git push origin main`);
  run(`git push origin v${newVersion}`);
  console.log(`Pushed commit and tag v${newVersion} to GitHub!`);

  // 6. Optional Direct Registry Publish
  console.log(`\n\x1b[34m[5/6] Checking for Registry API Tokens...\x1b[0m`);

  // VS Code Marketplace publish
  const vscePat = process.env.VSCE_PAT;
  if (vscePat) {
    console.log(`Found VSCE_PAT! Publishing to Visual Studio Marketplace...`);
    try {
      run(`npx vsce publish -p ${vscePat}`);
      console.log(`\x1b[32mSuccessfully published to VS Code Marketplace!\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31mFailed to publish via vsce: ${e.message}\x1b[0m`);
    }
  } else {
    console.log(`\x1b[33mTip:\x1b[0m No VSCE_PAT set. You can upload \x1b[32m${vsixFile}\x1b[0m manually at https://marketplace.visualstudio.com/manage`);
  }

  // Open VSX publish
  const ovsxPat = process.env.OVSX_PAT;
  if (ovsxPat) {
    console.log(`Found OVSX_PAT! Publishing to Open VSX...`);
    try {
      run(`npx ovsx publish ${vsixFile} -p ${ovsxPat}`);
      console.log(`\x1b[32mSuccessfully published to Open VSX!\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31mFailed to publish via ovsx: ${e.message}\x1b[0m`);
    }
  } else {
    console.log(`\x1b[33mTip:\x1b[0m No OVSX_PAT set. You can upload \x1b[32m${vsixFile}\x1b[0m manually at https://open-vsx.org`);
  }

  console.log(`\n\x1b[32m=== 🎉 Release v${newVersion} Complete! ===\x1b[0m`);
  console.log(`Packaged file: \x1b[1m${vsixFile}\x1b[0m`);
  console.log(`GitHub Release: https://github.com/joel374/orbit-lyrics-box/releases/new?tag=v${newVersion}\n`);
}

main().catch(err => {
  console.error("\x1b[31mRelease failed:\x1b[0m", err.message);
  process.exit(1);
});
