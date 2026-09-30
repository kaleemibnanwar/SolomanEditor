# Build, Release & Auto-Update

How Octo Cut ships. This repo uses **electron-builder** + **electron-updater** (not
Electron Forge) — the pipeline below is derived from this repo's actual config.

---

## 1. The big picture

Three subsystems cooperate to ship a release:

| Subsystem | Tool / file | Job |
|---|---|---|
| Bundler | Vite (`vite.config.ts`) | Compile the React renderer to `dist/` |
| Packager | **electron-builder** (`electron-builder.yml`) | Produce per-platform installers + the update feed |
| Updater | **electron-updater** (`electron/main.cjs`) | Check, download, and install updates from GitHub Releases |
| Distributor | GitHub Actions (`.github/workflows/release.yml`) | Build on 3 OSes, publish artifacts, host the feed |

The renderer is a plain Vite bundle; electron-builder only decides what travels
inside the app and how each platform wraps it. Native dependencies (`onnxruntime-node`,
`sharp`) are auto-detected and unpacked from the ASAR — `npmRebuild: false` in
`electron-builder.yml` is fine because none of them need rebuilding for Electron.

## 2. The two-repository system

Distribution uses two repos — one private (source), one public (releases). This is
the single most important architectural decision, because **the auto-updater's feed
must live on a public repo**.

| Repo | Purpose | Contents |
|---|---|---|
| `kaleemibnanwar/octocut-source` (private) | Development | Full source, history, CI |
| `kaleemibnanwar/octocut` (public) | Distribution | Download-page README + GitHub Releases with binaries |

The `publish` block in `electron-builder.yml` points `owner: kaleemibnanwar, repo:
octocut` — the **public** repo — so `latest*.yml` and the installers are uploaded
there, and `electron-updater` reads them from there. The private repo never hosts the
update feed.

Create the two repos and add both remotes (the public one only needs the download
page from `docs/public-repo/`, not the source):

```bash
# private — the source repo you are already in
git remote add origin git@github.com:kaleemibnanwar/octocut-source.git
git push -u origin main

# public — releases only
mkdir -p /tmp/octocut-public && cp -r docs/public-repo/. /tmp/octocut-public/
cd /tmp/octocut-public
git init && git add . && git commit -m "first commit"
git branch -M main
git remote add origin git@github.com:kaleemibnanwar/octocut.git
git push -u origin main
```

## 3. Auto-update

- **Client:** `electron-updater` — electron-builder's native updater.
- **Feed:** the `latest.yml` (Windows), `latest-mac.yml` (macOS) and
  `latest-linux.yml` files electron-builder uploads to the public repo's GitHub
  Releases. Generated because `publish` is configured in `electron-builder.yml`
  (`publishAutoUpdate: true`, `generateUpdatesFilesForAllChannels: true`).
- **Cadence:** at startup and every 60 minutes (`UPDATE_CHECK_INTERVAL_MS` in
  `electron/main.cjs`); downloads in the background, then shows an "Update ready —
  restart" button in the top bar.

The updater only exists in a **packaged** build (`app.isPackaged`), so `pnpm dev` and
`pnpm electron:start` never attempt an update.

### Per-platform support

| Platform | Artifacts in the release | Auto-update? |
|---|---|---|
| macOS | `*.zip` (required for auto-update) + `.dmg` + `.pkg` | ✅ |
| Windows | `*Setup.exe` + `*.blockmap` + `latest.yml` | ✅ |
| Linux | `.deb`, `AppImage` | ❌ manual install |

> **Linux has no auto-update** — `electron-updater` does not ship an updater for
> AppImage/deb. Linux users install manually from the release page.

## 4. Releasing

1. Bump the version **and** tag it together:
   ```bash
   pnpm version 0.1.0   # edits package.json + package-lock, commits, tags v0.1.0
   git push --tags
   ```
   Pushing the `v*` tag triggers `.github/workflows/release.yml` (or click
   "Run workflow").
2. **Matrix build** — `ubuntu-latest`, `windows-latest`, `macos-latest` build in
   parallel (`fail-fast: false`), each running `electron-builder --publish always`.
3. **Publish** — electron-builder creates the release on the **public** repo and
   uploads the installers + `latest*.yml` (using `PUBLIC_REPO_TOKEN`).
4. **Mirror** — a final job downloads those assets and re-uploads them to the
   **source** repo with `GITHUB_TOKEN`, so both repos carry the binaries.
5. **Users update** — the next 60-minute check (or app relaunch) fetches the feed from
   the public repo, sees the newer version, downloads it, and offers a restart.

> **Don't rename artifacts after build.** `latest.yml` embeds the exact filenames and
> sha512 of the installers; renaming them silently disables auto-update.

## 5. Secrets reference

### GitHub Actions secrets

| Secret | Used by | Required? |
|---|---|---|
| `PUBLIC_REPO_TOKEN` | publish to `kaleemibnanwar/octocut` | **yes** (a PAT with `contents: write` on the public repo) |
| `GITHUB_TOKEN` | mirror to the source repo | auto-provided |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS code signing (base64 `.p12` + password) | optional — unsigned without them |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code signing (base64 `.pfx` + password) | optional — unsigned without them |
| `APPLE_API_KEY_BASE64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | macOS notarization (App Store Connect API key, `.p8` stored base64) | optional — Gatekeeper will warn without them |
| `APPLE_TEAM_ID` | team id, used by signing + notarization | optional |

Without the optional signing secrets the workflow still produces working installers;
they're just unsigned (the OS warns on first launch).

### Local build flags

| Command | What it does |
|---|---|
| `pnpm release` | build + `electron-builder --publish always` (publishes to the public repo) |
| `pnpm electron:build` | build installers locally into `release/` (no publish) |
| `pnpm electron:build:dir` | unpacked app only, quick iteration |
| `pnpm electron:build:linux` | just the Linux `.deb` |

## 6. Analytics (Microsoft Clarity)

Usage tracking uses **`@microsoft/clarity`**, project id `yq5drd7m8z`, wired in
`src/lib/telemetry.ts`. It is **on by default (opt-out)**; Settings → Privacy has a
"Share anonymous usage data" switch that revokes consent and persists the
`telemetryEnabled` preference. `trackTelemetry(name)` and `identifyTelemetry(id)` are
the only first-party hooks exposed; no project or media content is ever sent.

## 7. Signing (production)

macOS and Windows each need their own certificate, so they use **separate** secrets
(a `.p12` for macOS, a `.pfx` for Windows). Both are uploaded as **single-line
base64**, because CI has no access to your keychain.

### macOS (Developer ID + notarization)

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs) ($99/yr).
2. In **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority**, then in the Apple Developer portal create a
   **Developer ID Application** certificate and install it.
3. Export that cert **and its private key** as a `.p12` (right-click → Export,
   choose `.p12`, set a password).
4. Base64 it (single line) and add the secrets:
   ```bash
   base64 -w0 DeveloperIDApplication.p12 | tr -d '\n'   # on Linux/GNU coreutils
   # macOS ships BSD base64 which wraps at 76 chars — strip the newlines:
   base64 -i DeveloperIDApplication.p12 | tr -d '\n'

   gh secret set MAC_CSC_LINK --repo kaleemibnanwar/octocut-source --body "$(base64 -w0 DeveloperIDApplication.p12)"
   gh secret set MAC_CSC_KEY_PASSWORD --repo kaleemibnanwar/octocut-source --body "<p12 password>"
   ```
5. Notarization credentials — an **App Store Connect API key** (team-scoped, no
   expiry, the automation-friendly path). Create it under **App Store Connect →
   Users and Access → Integrations → API Keys** (Developer access) and download the
   `.p8`. The workflow reads it base64 so the multiline key survives `GITHUB_ENV`:
   ```bash
   gh secret set APPLE_API_KEY_BASE64 --repo kaleemibnanwar/octocut-source --body "$(base64 -w0 AuthKey_XXXX.p8)"
   gh secret set APPLE_API_KEY_ID --repo kaleemibnanwar/octocut-source --body "KEYID"       # e.g. CRPZB6A7XX
   gh secret set APPLE_API_ISSUER --repo kaleemibnanwar/octocut-source --body "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   gh secret set APPLE_TEAM_ID --repo kaleemibnanwar/octocut-source --body "BR8AR3UC53"
   ```
   The workflow decodes `APPLE_API_KEY_BASE64` to a file and points `APPLE_API_KEY`
   at it, so `notarytool` gets a path. (An Apple ID + app-specific password works
   too — `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` — but the API key is what's wired
   here.)

### Windows (code-signing cert)

1. Buy an **OV or EV code-signing certificate** (e.g. Sectigo, DigiCert, SSL.com), or
   use **Azure Trusted Signing** (cheaper, no hardware/HSM).
2. Export it as a `.pfx` (with password) from the CA's portal or `certmgr.msc`.
3. Add the secrets:
   ```bash
   gh secret set WIN_CSC_LINK --repo kaleemibnanwar/octocut-source --body "$(base64 -w0 cert.pfx)"
   gh secret set WIN_CSC_KEY_PASSWORD --repo kaleemibnanwar/octocut-source --body "<pfx password>"
   ```

Notarization is detected automatically: if the `APPLE_*` secrets are present,
`electron-builder` notarizes; hardened runtime is on by default. No `electron-builder.yml`
changes are needed — the workflow's per-OS steps feed the env vars in.

### The macOS release flow, end to end

```
Ubuntu development machine (tag a release)
        │  git push --tags
        ▼
GitHub (kaleemibnanwar/octocut-source)
        │  release.yml matrix picks the macOS runner
        ▼
GitHub Actions macOS runner
        │  MAC_CSC_LINK (base64 .p12) → CSC_LINK env
        ▼
electron-builder builds + signs the .app
        │  APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
        ▼
notarytool notarization + staple
        ▼
Release .zip (auto-update) + .dmg + .pkg on kaleemibnanwar/octocut
```

The `.pkg` is signed with the same Developer ID Application identity; if you want a
separate **Developer ID Installer** identity for the `.pkg`, set `mac.identity` in
`electron-builder.yml` — otherwise the default is used and Apple still accepts it for
notarization.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Updater never finds an update | Feed repo is wrong or private | `publish.owner/repo` must be `kaleemibnanwar/octocut` (public); verify `app-update.yml` inside `release/*-unpacked/resources` |
| Windows/mac auto-update silently broken | Artifacts renamed after build | Upload the exact filenames from `release/`, `latest.yml` references them |
| `.deb` build fails on CI | `fpm`/native deps missing | use `ubuntu-latest`; the workflow already does |
| `pnpm install --frozen-lockfile` fails in CI | lockfile out of date | run `pnpm install` locally and commit the lockfile |
| Renderer build OOMs | Vite heap too small | `NODE_OPTIONS=--max-old-space-size=8192` (set in the workflow) |
