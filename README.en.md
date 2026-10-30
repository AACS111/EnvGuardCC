# EnvGuardCC

A Claude runtime environment inspection and protection workspace with browser and client diagnostics, protection settings, and before-and-after comparisons.

[中文](README.md) · [GitHub](https://github.com/AACS111/EnvGuardCC) · [Issues](https://github.com/AACS111/EnvGuardCC/issues)

## Download

- [Windows x64 installer (.exe)](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/EnvGuardCC-Setup-0.1.0.exe)
- [Windows x64 portable package (.zip)](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/EnvGuardCC-Windows-x64.zip)
- [SHA-256 checksums](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/SHA256SUMS.txt) · [All releases](https://github.com/AACS111/EnvGuardCC/releases)

Run the installer directly, or extract the entire portable package and launch EnvGuardCC.exe with its accompanying files. Both packages include the runtime; Node.js is not required. The installer is not code-signed.

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
- Windows desktop and local web modes.

Indicators describe the measured environment. They are not actual suspension probabilities and do not guarantee account or third-party service availability.

## Run locally

Requires Node.js 20+ and pnpm. Windows desktop and system-setting operations use PowerShell 7.

```powershell
git clone https://github.com/AACS111/EnvGuardCC.git
cd EnvGuardCC
pnpm install
pnpm dev:electron
```

For the local web interface:

```powershell
pnpm dev
```

Open the local URL printed by the terminal. Desktop mode uses port 3030 for its interface. The first desktop launch may download Electron.

## Build and verify

```powershell
pnpm lint
pnpm test:desktop
pnpm test:shutdown
pnpm test:protection
pnpm build
pnpm desktop:installer
```

The Windows release archive is named `EnvGuardCC-Windows-x64.zip`. The packaging command prints its output location.

## Stack

Next.js 16, React 19, TypeScript, Tailwind CSS 4, and Electron.

## License

MIT. See [LICENSE](LICENSE).
