# Kasho · كاشو

**Scan. Sell. Done. — امسح.. بيع.. خلاص.**

Kasho is a local-first Windows retail inventory and point-of-sale application. Sales and stock records stay in a local SQLite database on the Windows user profile.

## Download and install

1. Open the [GitHub Releases](https://github.com/a7med7uss/shop_system/releases) page.
2. Download `Install-Kasho.bat` and run it. It normally does not need administrator rights.
3. The script downloads the latest `Kasho-Setup.exe` and its SHA-256 file, verifies the hash, then launches the installer.
4. Choose Arabic or English in the installer. The desktop and Start Menu shortcut use the selected name: **كاشو** or **Kasho**.
5. Launch Kasho and create the first administrator account.

The installer includes the runtime. Node.js, Git, and SQLite do not need to be installed separately.

## First-time setup

- Create the first administrator username, display name, and password (at least 8 characters).
- Create seller accounts from **Users**.
- Add products from **المخزون والإضافة / Stock & Add**.
- Configure currency, discount tiers, invoice size, backups, language, theme, and font size in Settings.
- Use disposable test records before entering real inventory.

## Current feature set

- Local SQLite database; the app's sales and stock workflow does not depend on a cloud service.
- Administrator and seller roles. Sellers can sell but cannot see purchase cost or gross profit and cannot edit products or stock.
- Product catalog with category, tags, brand/model, barcode/SKU, cost, sale price, stock, and discount eligibility.
- Two administrator-configured discount tiers, calculated from product margin and selected per eligible cart line.
- USB barcode scanners in keyboard/HID mode. The app focuses the barcode field when adding a product and can receive the scan as keyboard input.
- Inventory activity journal with 7-day, 30-day, and all-time filters.
- Sales history, returns, voids, printable invoices, expenses, low-stock alerts, and dashboard reports.
- Arabic RTL and English LTR; IBM Plex Sans Arabic and Plus Jakarta Sans; OS-following Light/Dark theme with manual override and adjustable font scale.
- A4, 58mm, and 80mm invoice layouts.
- Up to three optional backup locations. When none is configured, Kasho uses **Documents/Kasho/Backups**.
- Backup intervals are selected from presets. Scheduled backups only run while Kasho is open; a missed interval is checked at the next launch.
- The first-run installer language controls the UI language and shortcut name.

## Barcode scanner notes

A common USB scanner in keyboard-wedge/HID mode behaves like a keyboard. When the barcode field is focused, the scanner types the code and usually sends Enter. This mode does not expose a reliable device identity to the app, so it cannot be shown as a separate selectable scanner device.

The product search's QR icon focuses the search field for a scanner input. It does not yet turn the PC into a camera-based QR reader.

## Backup and restore

1. Optionally choose up to three backup folders (for example, a second drive or external drive).
2. Select an interval preset and save Settings.
3. Run a manual backup and confirm that a timestamped SQLite file appears in the selected folder, or in Documents/Kasho/Backups when no location is selected.
4. Test restoring only with a disposable test database first.

There is no background Windows service or scheduled task. Backups run while Kasho is open and missed intervals are checked again at startup.

**Security status:** remembered login credentials are encrypted using Windows' OS-backed storage. The application database and current SQLite backup files are not yet encrypted at rest in this first Kasho rebrand build. Do not treat a copied backup as protected against someone who can read the file. Portable, password-protected backup encryption and database-at-rest protection are a separate security phase.

## Windows support

The current build uses Electron 45 and targets **64-bit Windows 10 and Windows 11**. Windows 7, 8, and 8.1 are not supported by this Electron generation. Supporting those systems would require a separate legacy runtime that is no longer receiving current Electron security fixes, so it is not included in this release.

## Local data and uninstall

The historical app-data location is intentionally retained to preserve existing StoreFlow records during the Kasho upgrade. On Windows, data is stored in the app's user profile under the existing `storeflow` application-data folder. Uninstalling Kasho keeps this data by default. Make a separate backup before reinstalling Windows, changing Windows users, or moving to another PC.

## Validation

GitHub Actions checks TypeScript, production bundles, and SQLite initialization. The installer still needs to be installed and tested on a real target PC. Physical USB scanner and printer models also need acceptance testing on the actual hardware before business use.

## Development

Requirements: Node.js 24 and npm. Build the Windows installer on Windows.

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run test:database
npm run dist:win
```
