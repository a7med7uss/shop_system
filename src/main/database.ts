import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoreSettings } from '../shared/types';

export const defaults: StoreSettings = {
  storeName: 'متجري', storeDescription: '', storeAddress: '', storePhone: '', storeLogoPath: '',
  language: 'ar', currency: 'EGP', currencySymbol: 'ج.م', theme: 'light', paperSize: 'A4',
  discountEnabled: true, highDiscountPercent: 15, monsterDiscountPercent: 30,
  backupPaths: ['', '', ''], backupIntervalHours: 24, backupRetention: 14, lastBackupAt: ''
};

export function openDatabase(filePath:string) {
  fs.mkdirSync(path.dirname(filePath), {recursive:true});
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec([
    'CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN (\\'admin\\',\\'seller\\')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,brand TEXT DEFAULT \\'\\',model TEXT DEFAULT \\'\\',category TEXT DEFAULT \\'\\',generic_category TEXT DEFAULT \\'\\',barcode TEXT UNIQUE,purchase_price REAL NOT NULL DEFAULT 0,selling_price REAL NOT NULL DEFAULT 0,stock_quantity INTEGER NOT NULL DEFAULT 0,allow_discount INTEGER NOT NULL DEFAULT 1,serial_tracking INTEGER NOT NULL DEFAULT 0,low_stock_threshold INTEGER NOT NULL DEFAULT 5,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS product_tags(product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(product_id,tag))',
    'CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)',
    'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)',
    'CREATE TABLE IF NOT EXISTS product_serials(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL REFERENCES products(id),serial_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT \\'available\\',created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY,invoice_number TEXT NOT NULL UNIQUE,cashier_user_id INTEGER NOT NULL REFERENCES users(id),subtotal REAL NOT NULL,discount_total REAL NOT NULL,total REAL NOT NULL,currency TEXT NOT NULL,currency_symbol TEXT NOT NULL,payment_method TEXT NOT NULL,customer_name TEXT DEFAULT \\'\\',status TEXT NOT NULL DEFAULT \\'completed\\',created_at TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)',
    'CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id TEXT NOT NULL REFERENCES sales(id),product_id INTEGER NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_purchase_cost REAL NOT NULL,unit_selling_price REAL NOT NULL,discount_amount REAL NOT NULL,discount_level TEXT,serial_numbers TEXT NOT NULL DEFAULT \\'[]\\')',
    'CREATE TABLE IF NOT EXISTS inventory_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL REFERENCES products(id),type TEXT NOT NULL,quantity_delta INTEGER NOT NULL,reason TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,amount REAL NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL)'
  ].join('\\n'));
  for (const [key,value] of Object.entries(defaults)) {
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(key,JSON.stringify(value));
  }
  return db;
}

export function hashPassword(password:string) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password,salt,64).toString('hex');
}
export function verifyPassword(password:string,stored:string) {
  const p = stored.split(':');
  if(p.length!==2) return false;
  const actual = crypto.scryptSync(password,p[0],64);
  const expected = Buffer.from(p[1],'hex');
  return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
}
export function getSettings(db:Database.Database):StoreSettings {
  const values:Record<string,any> = {};
  const rows = db.prepare('SELECT key,value FROM settings').all() as any[];
  for(const row of rows){try{values[row.key]=JSON.parse(row.value);}catch{values[row.key]=row.value;}}
  return {...defaults,...values};
}
export function saveSettings(db:Database.Database,settings:StoreSettings) {
  const stmt = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(()=>{for(const [key,value] of Object.entries(settings)) stmt.run(key,JSON.stringify(value));});
  tx();
}
export function audit(db:Database.Database,userId:number,action:string,details:unknown) {
  db.prepare('INSERT INTO audit_logs(user_id,action,details,created_at) VALUES (?,?,?,?)').run(userId,action,JSON.stringify(details),new Date().toISOString());
}
