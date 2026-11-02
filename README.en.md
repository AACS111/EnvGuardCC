# EnvGuardCC

A Claude runtime environment inspection and protection workspace with browser and client diagnostics, protection settings, and before-and-after comparisons.

[中文](README.md) · [GitHub](https://github.com/AACS111/EnvGuardCC) · [Issues](https://github.com/AACS111/EnvGuardCC/issues)

## Download

- [Apple Silicon Mac DMG](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.1/EnvGuardCC-0.1.1-arm64.dmg)
- [Apple Silicon Mac ZIP](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.1/EnvGuardCC-macOS-arm64.zip)
- [Windows x64 installer (.exe)](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.1/EnvGuardCC-Setup-0.1.1.exe)
- [Windows x64 portable package (.zip)](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.1/EnvGuardCC-Windows-x64.zip)
- [SHA-256 checksums](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.1/SHA256SUMS.txt) · [All releases](https://github.com/AACS111/EnvGuardCC/releases)

Run the installer directly, or extract the entire portable package and launch EnvGuardCC.exe with its accompanying files. Both packages include Node.js. Windows also needs system WebView2; the installer downloads it when missing, while portable users must install it first. The installer is not code-signed.


> The source now uses Tauri 2. Published downloads above predate this migration; no new release has been published. Build the Tauri client from source; macOS native validation is still required.

## Screenshots

The screenshots below show the current Chinese desktop interface.

### Overview

Review browser and client indicators, network exit details, protection settings, and anomalies.

![EnvGuardCC overview](docs/images/envguardcc-overview.png)

### Checks

Filter checks by status and inspect browser and client measurements.

![EnvGuardCC checks](docs/images/envguardcc-checks.png)

### Protection comparison

Compare the baseline with current measurements and distinguish passed, failed, and unverified results.

![EnvGuardCC protection comparison](docs/images/envguardcc-comparison.png)

## Features

- Browser and Claude client diagnostics covering timezone, language, fonts, device signals, and network exit.
- Exit IP, region, operator, and network type identification with explicit unknown states.
- Protection controls, scheduled checks, and per-check configuration details.
- Before-and-after comparisons that distinguish native passes, passes after protection, failures, and unknowns.
- Configuration backups and restoration during normal shutdown, with retained backups and errors when restoration fails.
- Windows desktop mode, macOS source-development mode, and local web mode.

Indicators describe the measured environment. They are not actual suspension probabilities and do not guarantee account or third-party service availability.

## Run locally

Requires Node.js 20+ and pnpm. Windows desktop and system-setting operations also require PowerShell 7.

### macOS (Apple Silicon, source development)

Run these commands in the local checkout that contains this Mac adaptation. Upstream b4d27d5 does not include these uncommitted changes; a checkout containing only upstream code will not provide this Mac functionality.

```bash
pnpm install --frozen-lockfile
pnpm dev:tauri
```

Desktop development requires Rust and native build tools; the first compilation downloads Rust dependencies. Desktop mode uses local port 3030 for its interface. Quitting from the tray or with `Cmd+Q` exits the app and attempts to restore configuration and release ports opened by that launch.

For the local web interface only:

```bash
pnpm dev
```

Open the local URL printed by the terminal.

### Windows

Apple Silicon Mac packages are available above. The commands below are for Windows; see the macOS source-development steps for local development.

```powershell
git clone https://github.com/AACS111/EnvGuardCC.git
cd EnvGuardCC
pnpm install
pnpm dev:tauri
```

For the local web interface only:

```powershell
pnpm dev
```

Open the local URL printed by the terminal. Desktop mode uses port 3030 for its interface. Desktop development requires Rust and native build tools; the first compilation downloads Rust dependencies.

## Supported scope

macOS automatically follows system HTTP/HTTPS proxy settings or system routing (including TUN), without manual in-app proxy configuration. The app does not read or rewrite third-party subscriptions, policy groups or routing configuration. Managed browsers and system-authorized timezone changes/restoration remain available; Claude desktop is opened normally.

An Apple Silicon local trial package is available (`.app`, ZIP, DMG; ad-hoc signed) under `node_modules/.checkcc-dist`. `pnpm desktop:package` builds the `.app` and ZIP; `pnpm desktop:installer` also builds the DMG. Developer ID signing and notarization are not part of the current local-trial scope; first launch on another Mac needs approval in System Settings > Privacy & Security. It is installed locally in `/Applications`; other-machine validation remains pending. Actual Mac validation used Apple Silicon and macOS 27.0; older macOS and Intel support are not claimed. See [stage 4 results](docs/MACOS-STAGE4-RESULTS.md).

## Build and verify

```powershell
pnpm lint
pnpm test:desktop
pnpm test:shutdown
pnpm test:protection
pnpm build
pnpm desktop:installer
```

`desktop:installer` builds a Windows installer on Windows or a DMG on macOS arm64. The Mac DMG includes EnvGuardCC, an Applications shortcut and bilingual instructions. Drag the app into Applications, then launch it there. The packaging command prints its output location.

## Stack

Next.js 16, React 19, TypeScript, Tailwind CSS 4, and Tauri 2.

## License

MIT. See [LICENSE](LICENSE).

### System timezone authorization

On macOS 13+, the first protection activation requests system approval to bind its restricted timezone service. Subsequent changes and restoration reuse that service automatically. Source/ad-hoc builds are supported without end-user developer certificates. There is no connection or service-management panel. See [timezone service details](docs/timezone-service.md).

### Desktop startup and background operation

Installed Windows and macOS apps offer launch-at-login and automatic protection switches in Protection configuration. Development previews do not register login items. Closing the window keeps protection running in the background; quitting from the tray or app menu restores configuration before exiting.

### Reset Claude Desktop

The Protection configuration action resets supported local Claude Desktop data locations after protection is stopped and Claude and its background tasks are closed. Review the native confirmation first: sign-in state, caches, preferences, MCP configuration and local Cowork/Desktop session data are moved to the system Trash/Recycle Bin and remain recoverable until it is emptied. Unknown locations, redirected paths, locks and permission errors are reported instead of claiming a complete reset. The app, browser profiles, Claude Code, projects, cloud records and unrelated credential-manager entries are preserved. This does not change device identity or guarantee removal of server-side account associations. Check onboarding and sign-in after reopening Claude; use Claude’s built-in Reset Application Data for unsupported storage layouts.

Monitoring and its interval are saved locally before a change is acknowledged and survive app restarts and protection stop/start cycles. Save failures are reported without changing the active settings. Launch-at-login and automatic protection preferences are also retained.

Tauri 2 desktop development requires Rust stable, Windows C++ Build Tools and Windows SDK, or Xcode Command Line Tools on macOS. See [desktop architecture and validation](docs/TAURI-DESKTOP.md).
