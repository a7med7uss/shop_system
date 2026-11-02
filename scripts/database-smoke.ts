import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, getSettings, hashPassword, verifyPassword } from '../src/main/database';

const root = path.resolve('.ci');
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'storeflow-smoke-' + process.pid + '.sqlite');
let db: ReturnType<typeof openDatabase> | null = null;

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
  if (settings.currency !== 'EGP' || settings.paperSize !== 'A4' || settings.theme !== 'light') {
    throw new Error('Unexpected first-run defaults.');
  }
  if (settings.backupPaths.length !== 3) throw new Error('Expected exactly three backup destinations.');

  const password = 'StoreFlowSmoke#2026';
  const stored = hashPassword(password);
  if (!verifyPassword(password, stored) || verifyPassword('wrong-password', stored)) {
    throw new Error('Password hashing/verification check failed.');
  }

  const integrity = db.pragma('quick_check') as Array<{quick_check:string}>;
  if (!integrity.length || integrity[0].quick_check !== 'ok') {
    throw new Error('SQLite integrity check failed.');
  }

  console.log('StoreFlow database smoke test passed.');
} finally {
  if (db?.open) db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch { /* GitHub Actions discards the CI workspace. */ }
  }
}
