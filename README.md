# StoreFlow

Local-first inventory and point-of-sale desktop system for Windows.

Current baseline: v0.1.0 development. This branch is the first implementation pass; it has not yet been validated on a physical Windows PC, barcode scanner, or receipt printer.

## Features in this baseline

- Electron + React + TypeScript desktop shell.
- Local SQLite database stored in the Windows user profile.
- First-run administrator creation, login and Admin/Seller roles.
- Product catalog with model, categories, barcode/SKU and tags.
- Purchase cost and profit are returned only to administrator sessions.
- Two globally configured discount tiers.
- Discounts are calculated from positive profit margin, not selling price.
- Seller chooses only the enabled preset tier; no custom percentage entry.
- Cart-wide preset discount for discount-eligible products.
- Stock adjustments, movement history and low-stock alerts.
- Sales records, invoice printing dialog and selected paper size.
- Store identity, one global currency, Arabic RTL / English, Light / Dark.
- A4 default, 58mm and 80mm thermal receipt options.
- Up to three backup directories and scheduled backups while the application is open.

## Discount calculation

For an eligible product line:

    discount = max(0, selling price - purchase cost) * quantity * configured rate

The administrator configures both rates once in settings. A cart-wide tier overrides per-line selections for eligible products. Ineligible products receive no discount.

## Inventory and historical costs

The first release does not include supplier accounts or purchase invoices. The administrator adds stock manually. An optional unit cost on stock additions updates the weighted average product cost. Sales store a cost snapshot so later product-cost changes do not rewrite previous sales.

## Backups

- Up to three destinations can be configured.
- No Windows background service or scheduled task is installed.
- Scheduled copies run only while StoreFlow is open.
- If an interval expires while the app is closed, a due backup is attempted after the next launch.
- Timestamped SQLite snapshots are written to each configured folder.

## Windows installer

Install-StoreFlow.bat downloads the latest StoreFlow-Setup.exe and its SHA256 checksum from GitHub Releases, verifies the downloaded installer, then launches the NSIS setup wizard. The setup wizard creates desktop and Start Menu shortcuts.

The BAT cannot install the app until the first Windows release is published from a v-prefixed Git tag.

## Development

Requirements: Node.js 24 and npm. Windows is required to produce the Windows NSIS installer.

    npm install
    npm run dev

    npm run typecheck
    npm run build

    npm run dist:win

## Local database

Database file: app.getPath('userData')/storeflow.sqlite

Uninstalling StoreFlow keeps user data by default.

## Security notes

- Renderer has no direct Node.js access.
- Context isolation is enabled and the preload API is limited to app operations.
- Passwords are salted and hashed using scrypt.
- Seller-facing API responses omit purchase costs.
- Sales and inventory are not sent to a cloud service.

## Next validation tasks

1. Run GitHub Actions and resolve build issues.
2. Test 2D HID scanner input on a Windows machine.
3. Test A4 and thermal printing with actual printer models.
4. Add full serial-number checkout selection and return workflow.
5. Add automated tests for discount math, returns, voids and stock invariants.
6. Verify backup restore and Windows installer behavior.
