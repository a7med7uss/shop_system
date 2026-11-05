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
    if (settings.confirmSaleEnabled !== false) throw new Error('Sale confirmation must be disabled by default.');

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

    const saleId='smoke-sale-'+stamp;
    db.prepare(
      'INSERT INTO sales(id,invoice_number,cashier_user_id,subtotal,discount_total,total,currency,currency_symbol,payment_method,customer_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(saleId,'SMOKE-'+stamp,userId,90,9,81,'EGP','ج.م','cash','','completed',createdAt);
    const itemId=Number(db.prepare(
      'INSERT INTO sale_items(sale_id,product_id,product_name,quantity,returned_quantity,unit_purchase_cost,unit_selling_price,discount_amount,discount_level,serial_numbers) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(saleId,productId,'Kasho smoke product',3,0,5,30,9,null,'[]').lastInsertRowid);
    const refundAmount=27;
    db.prepare('UPDATE sale_items SET returned_quantity=returned_quantity+1 WHERE id=?').run(itemId);
    db.prepare('INSERT INTO sale_returns(sale_item_id,quantity,refund_amount,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(itemId,1,refundAmount,'Smoke return',userId,createdAt);
    const refunded=Number((db.prepare('SELECT COALESCE(SUM(refund_amount),0) amount FROM sale_returns r JOIN sale_items si ON si.id=r.sale_item_id WHERE si.sale_id=?').get(saleId) as {amount:number}).amount);
    const netTotal=Math.max(0,81-refunded);
    db.prepare('UPDATE sales SET total=? WHERE id=?').run(netTotal,saleId);
    const netSale=db.prepare('SELECT total FROM sales WHERE id=?').get(saleId) as {total:number};
    if(netSale.total!==54)throw new Error('A partial return did not reduce the invoice total.');
    db.prepare('UPDATE products SET active=0 WHERE id=?').run(productId);
    db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(productId,'deleted',0,'حذف المنتج من المخزون',userId,createdAt);
    const deletionMovement=db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE product_id=? AND type='deleted'").get(productId) as {n:number};
    if(deletionMovement.n!==1)throw new Error('Product archive was not recorded in the inventory activity log.');
    const historicalItem=db.prepare('SELECT COUNT(*) n FROM sale_items WHERE sale_id=? AND product_id=?').get(saleId,productId) as {n:number};
    if(historicalItem.n!==1)throw new Error('Archiving a product removed its historical invoice line.');

    await db.backup(backupFile);
    const backupCheck = validateBackupDatabase(backupFile);
    if (!backupCheck.valid) throw new Error('Valid backup was rejected: ' + backupCheck.message);

    fs.copyFileSync(backupFile, restoredFile);
    restored = openDatabase(restoredFile);
    const restoredProduct = restored.prepare('SELECT name,stock_quantity FROM products WHERE id=?').get(productId) as {name:string;stock_quantity:number}|undefined;
    if (!restoredProduct || restoredProduct.name !== 'Kasho smoke product' || restoredProduct.stock_quantity !== 7) {
      throw new Error('Backup restore did not preserve product and inventory data.');
    }
    const restoredMovements = restored.prepare('SELECT type,quantity_delta,reason,user_id FROM inventory_movements WHERE product_id=? ORDER BY id').all(productId) as Array<{type:string;quantity_delta:number;reason:string;user_id:number}>;
    const restoredOpening = restoredMovements.find(m => m.type === 'opening' && m.quantity_delta === 7);
    const restoredDeletion = restoredMovements.find(m => m.type === 'deleted' && m.quantity_delta === 0 && m.reason === 'حذف المنتج من المخزون' && m.user_id === userId);
    if (restoredMovements.length !== 2 || !restoredOpening || !restoredDeletion) {
      throw new Error('Backup restore did not preserve both stock opening and product deletion history.');
    }

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
