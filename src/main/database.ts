import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoreSettings } from '../shared/types';

export const defaults: StoreSettings = {
  storeName: 'متجري',
  storeDescription: '',
  storeAddress: '',
  storePhone: '',
  storeLogoPath: '',
  language: 'ar',
  currency: 'EGP',
  currencySymbol: 'ج.م',
  theme: 'system',
  fontScale: 1,
  paperSize: 'A4',
  discountEnabled: true,
  highDiscountPercent: 15,
  monsterDiscountPercent: 30,
  confirmSaleEnabled: false,
  backupPaths: ['', '', ''],
  backupIntervalHours: 24,
  lastBackupAt: ''
};

export function openDatabase(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec([
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','seller')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', generic_category TEXT NOT NULL DEFAULT '', barcode TEXT UNIQUE, purchase_price REAL NOT NULL DEFAULT 0, selling_price REAL NOT NULL DEFAULT 0, stock_quantity INTEGER NOT NULL DEFAULT 0, allow_discount INTEGER NOT NULL DEFAULT 1, serial_tracking INTEGER NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 5, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS product_tags (product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(product_id, tag))",
    "CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)",
    "CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)",
    "CREATE TABLE IF NOT EXISTS product_serials (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), serial_number TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'available', created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_serials_product_status ON product_serials(product_id,status)",
    "CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, cashier_user_id INTEGER NOT NULL REFERENCES users(id), subtotal REAL NOT NULL, discount_total REAL NOT NULL, total REAL NOT NULL, currency TEXT NOT NULL, currency_symbol TEXT NOT NULL, payment_method TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)",
    "CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, quantity INTEGER NOT NULL, returned_quantity INTEGER NOT NULL DEFAULT 0, unit_purchase_cost REAL NOT NULL, unit_selling_price REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0, discount_level TEXT, serial_numbers TEXT NOT NULL DEFAULT '[]')",
    "CREATE TABLE IF NOT EXISTS inventory_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), type TEXT NOT NULL, quantity_delta INTEGER NOT NULL, reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements(created_at)",
    "CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, amount REAL NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sale_returns (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), quantity INTEGER NOT NULL, refund_amount REAL NOT NULL, reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL)"
  ].join(';\n'));

  const productColumns = db.pragma('table_info(products)') as Array<{ name: string }>;
  const productColumnNames = new Set(productColumns.map(column => column.name));
  if (!productColumnNames.has('visual_type')) db.exec("ALTER TABLE products ADD COLUMN visual_type TEXT NOT NULL DEFAULT 'default'");
  if (!productColumnNames.has('icon_key')) db.exec("ALTER TABLE products ADD COLUMN icon_key TEXT NOT NULL DEFAULT ''");
  if (!productColumnNames.has('visual_color')) db.exec("ALTER TABLE products ADD COLUMN visual_color TEXT NOT NULL DEFAULT ''");
  if (!productColumnNames.has('image_data')) db.exec("ALTER TABLE products ADD COLUMN image_data TEXT NOT NULL DEFAULT ''");

  // Older products were recorded as an opening balance. Treat that starting stock
  // as a normal stock addition in the movement history, without changing quantities.
  db.prepare("UPDATE inventory_movements SET type='restock', reason='إضافة مخزون عند إنشاء المنتج' WHERE type='opening'").run();

  const saleItemColumns = db.pragma('table_info(sale_items)') as Array<{ name: string }>;
  if (!saleItemColumns.some(column => column.name === 'returned_quantity')) {
    db.exec('ALTER TABLE sale_items ADD COLUMN returned_quantity INTEGER NOT NULL DEFAULT 0');
  }

  const settingInsert = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  for (const [key, value] of Object.entries(defaults)) {
    settingInsert.run(key, JSON.stringify(value));
  }
  // Serial-number tracking was removed from the product workflow. Keep the legacy
  // tables/columns so existing databases remain readable, but disable the feature.
  const schemaVersion=Number(db.pragma('user_version',{simple:true})||0);
  if(schemaVersion<1){
    const savedTheme=db.prepare("SELECT value FROM settings WHERE key='theme'").get() as {value:string}|undefined;
    if(savedTheme&&JSON.parse(savedTheme.value)==='light'){
      db.prepare("UPDATE settings SET value=? WHERE key='theme'").run(JSON.stringify('system'));
    }
    db.pragma('user_version = 1');
  }
  db.exec('UPDATE products SET serial_tracking=0 WHERE serial_tracking<>0');
  return db;
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

export function verifyPassword(password: string, stored: string) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const actual = crypto.scryptSync(password, parts[0], 64);
  const expected = Buffer.from(parts[1], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function getSettings(db: Database.Database): StoreSettings {
  const result: Record<string, unknown> = {};
  const rows = db.prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return { ...defaults, ...result } as StoreSettings;
}

export function saveSettings(db: Database.Database, settings: StoreSettings) {
  const statement = db.prepare(
    'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      statement.run(key, JSON.stringify(value));
    }
  });
  transaction();
}

export function audit(db: Database.Database, userId: number, action: string, details: unknown) {
  db.prepare('INSERT INTO audit_logs(user_id,action,details,created_at) VALUES (?,?,?,?)')
    .run(userId, action, JSON.stringify(details), new Date().toISOString());
}

const backupRequiredColumns: Record<string, string[]> = {
  users: ['id', 'username', 'display_name', 'password_hash', 'role', 'active', 'created_at'],
  settings: ['key', 'value'],
  products: ['id', 'name', 'brand', 'model', 'category', 'generic_category', 'barcode', 'purchase_price', 'selling_price', 'stock_quantity', 'allow_discount', 'serial_tracking', 'low_stock_threshold', 'active', 'created_at', 'updated_at'],
  product_tags: ['product_id', 'tag'],
  sales: ['id', 'invoice_number', 'cashier_user_id', 'subtotal', 'discount_total', 'total', 'currency', 'currency_symbol', 'payment_method', 'customer_name', 'status', 'created_at'],
  sale_items: ['id', 'sale_id', 'product_id', 'product_name', 'quantity', 'unit_purchase_cost', 'unit_selling_price', 'discount_amount', 'discount_level', 'serial_numbers'],
  inventory_movements: ['id', 'product_id', 'type', 'quantity_delta', 'reason', 'user_id', 'created_at'],
  expenses: ['id', 'title', 'amount', 'user_id', 'created_at'],
  sale_returns: ['id', 'sale_item_id', 'quantity', 'refund_amount', 'reason', 'user_id', 'created_at'],
  audit_logs: ['id', 'user_id', 'action', 'details', 'created_at']
};

/**
 * Validate a SQLite backup before it is allowed to replace the live store database.
 * returned_quantity is intentionally not required here: openDatabase adds it to
 * older StoreFlow/Kasho databases during the normal schema migration.
 */
export function validateBackupDatabase(filePath: string): { valid: boolean; message: string } {
  let candidate: Database.Database | null = null;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });

    const integrity = candidate.pragma('quick_check') as Array<{ quick_check?: string }>;
    if (!integrity.length || integrity.some(row => String(row.quick_check || '').toLowerCase() !== 'ok')) {
      return { valid: false, message: 'ملف النسخة تالف أو فشل اختبار سلامة SQLite.' };
    }

    const tables = new Set(
      (candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(row => row.name)
    );

    for (const [table, requiredColumns] of Object.entries(backupRequiredColumns)) {
      if (!tables.has(table)) {
        return { valid: false, message: 'النسخة لا تحتوي جدولاً أساسياً في كاشو: ' + table };
      }
      const columns = new Set(
        (candidate.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name)
      );
      const missing = requiredColumns.filter(column => !columns.has(column));
      if (missing.length) {
        return { valid: false, message: 'بنية جدول ' + table + ' غير مكتملة: ' + missing.join(', ') };
      }
    }

    const foreignKeyErrors = candidate.pragma('foreign_key_check') as any[];
    if (foreignKeyErrors.length) {
      return { valid: false, message: 'النسخة تحتوي على سجلات مرتبطة بشكل غير سليم.' };
    }

    return { valid: true, message: '' };
  } catch {
    return { valid: false, message: 'تعذر فتح ملف النسخة. تأكد أنه ملف SQLite صالح وغير تالف.' };
  } finally {
    if (candidate?.open) candidate.close();
  }
}
