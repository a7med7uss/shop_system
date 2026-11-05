import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, getSettings, hashPassword, verifyPassword, validateBackupDatabase } from '../src/main/database';

const root = path.resolve('.ci');
fs.mkdirSync(root, { recursive: true });
const stamp = String(process.pid);
const file = path.join(root, 'storeflow-smoke-' + stamp + '.sqlite');
const backupFile = path.join(root, 'kasho-backup-smoke-' + stamp + '.sqlite');
const restoredFile = path.join(root, 'kasho-restored-smoke-' + stamp + '.sqlite');
const partialFile = path.join(root, 'kasho-partial-smoke-' + stamp + '.sqlite');
const corruptFile = path.join(root, 'kasho-corrupt-smoke-' + stamp + '.sqlite');

async function run() {
  let db: ReturnType<typeof openDatabase> | null = null;
  let restored: ReturnType<typeof openDatabase> | null = null;
  let partial: Database.Database | null = null;

  try {
    db = openDatabase(file);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>)
        .map(row => row.name)
    );
    const required = [
      'users', 'settings', 'products', 'product_tags', 'product_serials',
      'sales', 'sale_items', 'sale_returns', 'inventory_movements',
      'expenses', 'audit_logs'
    ];
    const missing = required.filter(table => !tables.has(table));
    if (missing.length) throw new Error('Missing database tables: ' + missing.join(', '));

    const settings = getSettings(db);
    if (settings.currency !== 'EGP' || settings.paperSize !== 'A4' || settings.theme !== 'system' || settings.fontScale !== 1) {
      throw new Error('Unexpected first-run defaults.');
    }
    if (settings.backupPaths.length !== 3) throw new Error('Expected exactly three backup destinations.');

    const password = 'KashoSmoke#2026';
    const stored = hashPassword(password);
    if (!verifyPassword(password, stored) || verifyPassword('wrong-password', stored)) {
      throw new Error('Password hashing/verification check failed.');
    }

    const createdAt = new Date().toISOString();
    const userId = Number(db.prepare(
      'INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?)'
    ).run('smoke-admin', 'Smoke Admin', stored, 'admin', createdAt).lastInsertRowid);

    const productId = Number(db.prepare(
      'INSERT INTO products(name,brand,model,category,generic_category,barcode,purchase_price,selling_price,stock_quantity,allow_discount,serial_tracking,low_stock_threshold,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run('Kasho smoke product', '', '', '', '', 'KASHO-SMOKE-' + stamp, 10, 15, 7, 1, 0, 5, 1, createdAt, createdAt).lastInsertRowid);

    db.prepare(
      'INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)'
    ).run(productId, 'opening', 7, 'Smoke test', userId, createdAt);

    await db.backup(backupFile);
    const backupCheck = validateBackupDatabase(backupFile);
    if (!backupCheck.valid) throw new Error('Valid backup was rejected: ' + backupCheck.message);

    fs.copyFileSync(backupFile, restoredFile);
    restored = openDatabase(restoredFile);
    const restoredProduct = restored.prepare('SELECT name,stock_quantity FROM products WHERE id=?').get(productId) as {name:string;stock_quantity:number}|undefined;
    if (!restoredProduct || restoredProduct.name !== 'Kasho smoke product' || restoredProduct.stock_quantity !== 7) {
      throw new Error('Backup restore did not preserve product and inventory data.');
    }
    const restoredMovement = restored.prepare('SELECT COUNT(*) n FROM inventory_movements WHERE product_id=?').get(productId) as {n:number};
    if (restoredMovement.n !== 1) throw new Error('Backup restore did not preserve inventory history.');

    partial = new Database(partialFile);
    partial.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    partial.close();
    partial = null;
    if (validateBackupDatabase(partialFile).valid) {
      throw new Error('A partial SQLite file was incorrectly accepted as a Kasho backup.');
    }

    fs.writeFileSync(corruptFile, 'This is not a SQLite database.');
    if (validateBackupDatabase(corruptFile).valid) {
      throw new Error('A corrupt file was incorrectly accepted as a Kasho backup.');
    }

    const integrity = db.pragma('quick_check') as Array<{quick_check:string}>;
    if (!integrity.length || integrity[0].quick_check !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }

    console.log('Kasho database and backup smoke tests passed.');
  } finally {
    if (partial?.open) partial.close();
    if (restored?.open) restored.close();
    if (db?.open) db.close();
    for (const target of [file, backupFile, restoredFile, partialFile, corruptFile]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(target + suffix); } catch { /* GitHub Actions discards the CI workspace. */ }
      }
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
