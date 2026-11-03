# StoreFlow

Local-first inventory and point-of-sale desktop system for 64-bit Windows.

## Download and install

1. Open the GitHub Releases page: https://github.com/a7med7uss/shop_system/releases
2. Download `Install-StoreFlow.bat`.
3. Right-click the BAT file and choose **Run as administrator** only if Windows asks for it. The installer is per-user and normally does not need administrator rights.
4. The BAT downloads `StoreFlow-Setup.exe` and its SHA256 checksum, verifies the checksum, and launches the setup wizard.
5. Keep the default installation folder unless you have a reason to change it. The wizard creates a desktop shortcut and a Start Menu entry.
6. Launch StoreFlow. On first run, create the administrator account. Then sign in and create seller accounts from the Users area.

The installer bundles the app runtime. You do not need to install Node.js, Git, or SQLite separately.

> The BAT installer will work after the first Windows installer has been published under GitHub Releases. If Releases is empty, use the repository Actions page to check the first build.

## First-run setup

- Create the first administrator username, display name, and password (at least 8 characters).
- Open Settings and enter the store name, phone, address, logo, currency and preferred language.
- Configure both discount percentages globally. A product must be marked discount-eligible before a seller can choose one of the two preset tiers for that product.
- Add products and their stock. For serial-tracked products, provide one distinct serial number per unit.
- Create individual seller accounts. Sellers can sell but do not receive purchase-cost or profit fields.

## Features in this baseline

- Electron + React + TypeScript Windows desktop app.
- Local SQLite data stored in the Windows user profile; no cloud connection is used for sales or stock.
- First-run administrator setup, login, admin and seller roles.
- Product catalog with categories, brand/model, barcode/SKU, tags and optional serial tracking.
- Admin-only purchase cost and profit fields.
- Two admin-configured discount rates, calculated from positive product margin (sale price minus purchase cost). Seller selects a preset tier per eligible product line; no custom amount or invoice-wide discount.
- Barcode/serial scanning through scanners that act as a USB keyboard (HID).
- Stock adjustments and movement journal, low-stock list and threshold.
- Sales history, printable invoices, admin-only item returns and voids.
- Admin dashboard with sales, discounts, cost of goods, gross profit and expenses.
- Global store currency; Arabic RTL and English LTR; Light and Dark modes.
- A4 default invoice, with 58mm and 80mm thermal paper options.
- Up to three backup destinations; scheduled backup attempts run only while StoreFlow is open.

## Keyboard and scanner test

For a USB barcode/QR scanner configured as a keyboard:
1. Click the scan field on the POS page.
2. Scan a product barcode or an available serial number.
3. Confirm the product is added to the cart.
4. For a serial-tracked product, scan a different available serial for every unit.
5. Complete a test sale and verify the stock decreases by the sold quantity.

A scanner that sends Enter after each scan is recommended. No special driver is normally needed for USB HID keyboard mode.

## Printer test

1. Connect and install the official driver for your printer in Windows.
2. Open StoreFlow Settings and choose A4, 58mm or 80mm.
3. Complete a test sale and select the target printer in the Windows print dialog.
4. Check alignment and paper width. Thermal printer models differ, so physical adjustment may be needed.

The app opens the Windows print dialog; it does not silently choose or install a printer driver.

## Backup and restore test

1. Open Settings and choose up to three existing backup folders (for example, a folder on another drive and an external USB drive).
2. Set the interval and retention count, then save.
3. Use the manual backup action once and confirm a timestamped SQLite file appears in each selected folder.
4. Use Restore backup only with a StoreFlow backup file. Restore creates a safety copy of the current database before replacing it.

There is no Windows background service or scheduled task. Backups run while the app is open; a missed interval is checked again when the app launches.

## Suggested acceptance test

Before entering real inventory, create a few disposable products and accounts and verify:
- Admin can see cost, gross margin and analytics.
- Seller cannot see cost or gross profit and cannot edit products or stock.
- A non-eligible product does not offer discounts.
- Each preset discount matches the configured percentage of positive margin, not the selling price.
- Stock decreases after a sale and increases after a valid return/void.
- A duplicate or unavailable serial cannot be sold.
- A4 and thermal print layouts are readable on the actual printer.
- Backup and restore work using a test folder.

Use test data first. Do not rely on the system for business-critical records until you have completed this acceptance test on your own Windows PC and printer/scanner setup.

## Development

Requirements: Node.js 24 and npm. Windows is required to build the Windows NSIS installer.

```bash
npm install
npm run dev

npm run typecheck
npm run build
npm run test:database
npm run dist:win
```

## Local data and uninstall

The database is stored at Electron's `app.getPath('userData')/storeflow.sqlite` path. Uninstalling StoreFlow keeps user data by default. Back up the database before moving the app to another PC or deleting its Windows user profile.

## Current validation status

GitHub Actions checks the TypeScript project, production bundles and database initialization. That is not a substitute for testing a real Windows installation, USB scanner, printer paper size and backup folder on the target PC.
