import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {ProductInput,StoreSettings,DiscountLevel,PaperSize} from '../shared/types';
import {openDatabase,hashPassword,verifyPassword,getSettings,saveSettings,audit} from './database';

let db:Database.Database;
let databasePath='';
let win:BrowserWindow|null=null;
let session:any=null;
let backupTimer:NodeJS.Timeout|null=null;
let backupBusy=false;
const now=()=>new Date().toISOString();
const login=()=>{if(!session)throw new Error('سجّل الدخول أولاً.');return session;};
const admin=()=>{const u=login();if(u.role!=='admin')throw new Error('هذه العملية للأدمن فقط.');return u;};
const userDto=(r:any)=>({id:r.id,username:r.username,displayName:r.display_name,role:r.role});
function productDto(row:any){
  const dto:any={id:row.id,name:row.name,brand:row.brand,model:row.model,category:row.category,genericCategory:row.generic_category,barcode:row.barcode||'',sellingPrice:row.selling_price,stockQuantity:row.stock_quantity,allowDiscount:!!row.allow_discount,serialTracking:!!row.serial_tracking,lowStockThreshold:row.low_stock_threshold,tags:(db.prepare('SELECT tag FROM product_tags WHERE product_id=? ORDER BY tag').all(row.id) as any[]).map(x=>x.tag)};
  if(session?.role==='admin')dto.purchasePrice=row.purchase_price;
  return dto;
}
function tagsFor(id:number,tags:string[]){db.prepare('DELETE FROM product_tags WHERE product_id=?').run(id);const s=db.prepare('INSERT OR IGNORE INTO product_tags(product_id,tag) VALUES (?,?)');for(const item of tags||[]){const v=String(item).trim().replace(/^#+/,'');if(v)s.run(id,v.slice(0,50));}}
function addProduct(input:ProductInput,userId:number){
  if(!input.name?.trim())throw new Error('اسم المنتج مطلوب.');
  if(input.purchasePrice<0||input.sellingPrice<0)throw new Error('الأسعار يجب ألا تكون سالبة.');
  const qty=Number(input.stockQuantity||0);
  if(!Number.isInteger(qty)||qty<0)throw new Error('الكمية غير صحيحة.');
  const serials=(input.serials||[]).map(x=>x.trim()).filter(Boolean);
  if(input.serialTracking&&serials.length!==qty)throw new Error('أدخل Serial لكل قطعة في المخزون.');
  const stamp=now();
  const tx=db.transaction(()=>{
    const result=db.prepare('INSERT INTO products(name,brand,model,category,generic_category,barcode,purchase_price,selling_price,stock_quantity,allow_discount,serial_tracking,low_stock_threshold,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(input.name.trim(),input.brand||'',input.model||'',input.category||'',input.genericCategory||'',input.barcode?.trim()||null,input.purchasePrice,input.sellingPrice,qty,input.allowDiscount?1:0,input.serialTracking?1:0,input.lowStockThreshold||5,stamp,stamp);
    const id=Number(result.lastInsertRowid);tagsFor(id,input.tags||[]);
    const serialStmt=db.prepare("INSERT INTO product_serials(product_id,serial_number,status,created_at) VALUES (?,?,'available',?)");
    for(const serial of serials)serialStmt.run(id,serial,stamp);
    if(qty)db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(id,'opening',qty,'رصيد افتتاحي',userId,stamp);
    audit(db,userId,'product.created',{id,name:input.name});
    return id;
  });
  return tx();
}
function saleDto(row:any){return {id:row.id,invoiceNumber:row.invoice_number,cashierName:row.cashier_name,subtotal:row.subtotal,discountTotal:row.discount_total,total:row.total,currency:row.currency,currencySymbol:row.currency_symbol,paymentMethod:row.payment_method,customerName:row.customer_name||'',status:row.status,createdAt:row.created_at};}
async function backup(){
  if(backupBusy)throw new Error('النسخ الاحتياطي يعمل بالفعل.');
  const settings=getSettings(db);const dirs=(settings.backupPaths||[]).filter(Boolean).slice(0,3);
  if(!dirs.length)throw new Error('حدد مسارًا واحدًا على الأقل.');
  backupBusy=true;const output:any[]=[];const stamp=now().replace(/[:.]/g,'-');
  try{
    for(const dir of dirs){
      try{
        fs.mkdirSync(dir,{recursive:true});
        const file=path.join(dir,'StoreFlow_Backup_'+stamp+'.sqlite');
        await db.backup(file);
        const keep=Math.max(1,settings.backupRetention||14);
        const old=fs.readdirSync(dir).filter(x=>x.startsWith('StoreFlow_Backup_')&&x.endsWith('.sqlite')).map(name=>({name,mtime:fs.statSync(path.join(dir,name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
        for(const item of old.slice(keep)){try{fs.unlinkSync(path.join(dir,item.name));}catch{}}
        output.push({path:dir,success:true,message:'تم النسخ'});
      }catch(e:any){output.push({path:dir,success:false,message:e.message||'فشل النسخ'});}
    }
    const completed=now();
    db.prepare("INSERT INTO settings(key,value) VALUES ('lastBackupAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(completed));
    return {success:output.some(x=>x.success),completedAt:completed,results:output};
  }finally{backupBusy=false;}
}
function scheduleBackup(){
  if(backupTimer)clearInterval(backupTimer);
  backupTimer=setInterval(async()=>{
    if(backupBusy||!db||!app.isReady())return;
    const s=getSettings(db);if(!(s.backupPaths||[]).some(Boolean))return;
    const span=Math.max(1,s.backupIntervalHours||24)*3600000;
    const last=s.lastBackupAt?new Date(s.lastBackupAt).getTime():0;
    if(!last||Date.now()-last>=span){try{await backup();}catch(e){console.error(e);}}
  },60000);
}
function makeWindow(){
  win=new BrowserWindow({width:1480,height:920,minWidth:1100,minHeight:700,backgroundColor:'#f7f7f4',title:'StoreFlow',webPreferences:{preload:path.join(app.getAppPath(),'dist-electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const dev=process.env.VITE_DEV_SERVER_URL;
  if(dev)win.loadURL(dev);else win.loadFile(path.join(app.getAppPath(),'dist','index.html'));
  win.on('closed',()=>{win=null;});
}
function register(){
  ipcMain.handle('app:bootstrap',()=>({hasAdmin:Number((db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get() as any).n)>0,version:app.getVersion()}));
  ipcMain.handle('auth:setup',(_e,v)=>{
    if(Number((db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get() as any).n))throw new Error('حساب الأدمن موجود بالفعل.');
    if(!v.username?.trim()||!v.displayName?.trim()||String(v.password||'').length<8)throw new Error('أدخل البيانات وكلمة مرور من 8 أحرف على الأقل.');
    const name=v.username.trim().toLowerCase();
    const result=db.prepare('INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(name,v.displayName.trim(),hashPassword(v.password),'admin',now());
    session={id:Number(result.lastInsertRowid),username:name,displayName:v.displayName.trim(),role:'admin'};
    audit(db,session.id,'admin.initialized',{});return session;
  });
  ipcMain.handle('auth:login',(_e,v)=>{
    const row=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(v.username||'').trim().toLowerCase()) as any;
    if(!row||!verifyPassword(String(v.password||''),row.password_hash))throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
    session=userDto(row);audit(db,session.id,'auth.login',{});return session;
  });
  ipcMain.handle('auth:logout',()=>{if(session)audit(db,session.id,'auth.logout',{});session=null;});
  ipcMain.handle('auth:current',()=>session);
  ipcMain.handle('settings:get',()=>{login();return getSettings(db);});
  ipcMain.handle('settings:save',(_e,v:StoreSettings)=>{
    const u=admin();if(!Array.isArray(v.backupPaths)||v.backupPaths.length>3)throw new Error('ثلاثة مسارات نسخ احتياطي كحد أقصى.');
    const s={...getSettings(db),...v};
    s.highDiscountPercent=Math.max(0,Math.min(100,Number(s.highDiscountPercent)||0));
    s.monsterDiscountPercent=Math.max(0,Math.min(100,Number(s.monsterDiscountPercent)||0));
    s.backupIntervalHours=Math.max(1,Number(s.backupIntervalHours)||24);
    s.backupRetention=Math.max(1,Math.min(365,Number(s.backupRetention)||14));
    saveSettings(db,s);audit(db,u.id,'settings.updated',{currency:s.currency,paperSize:s.paperSize});scheduleBackup();return s;
  });
  ipcMain.handle('dialog:directory',async()=>{admin();const r=await dialog.showOpenDialog(win!,{properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('dialog:image',async()=>{admin();const r=await dialog.showOpenDialog(win!,{properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','svg']}]});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('backup:run',async()=>{admin();return backup();});
  ipcMain.handle('backup:restore',async()=>{
    const actor=admin();
    const selected=await dialog.showOpenDialog(win!,{
      properties:['openFile'],
      filters:[{name:'SQLite backups',extensions:['sqlite','sqlite3','db']}]
    });
    if(selected.canceled||!selected.filePaths[0])return {success:false,message:'تم إلغاء اختيار النسخة.'};
    const source=selected.filePaths[0];
    let candidate:Database.Database|null=null;
    try{
      candidate=new Database(source,{readonly:true,fileMustExist:true});
      const integrity=candidate.pragma('quick_check') as any[];
      const hasProducts=!!candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
      if(!integrity.length||String(integrity[0].quick_check).toLowerCase()!=='ok'||!hasProducts){
        throw new Error('ملف النسخة غير صالح أو لا يحتوي قاعدة StoreFlow.');
      }
    }finally{
      if(candidate?.open)candidate.close();
    }
    const safetyPath=path.join(path.dirname(databasePath),'StoreFlow_PreRestore_'+now().replace(/[:.]/g,'-')+'.sqlite');
    await db.backup(safetyPath);
    db.close();
    try{
      for(const suffix of ['-wal','-shm']){try{fs.unlinkSync(databasePath+suffix);}catch{}}
      fs.copyFileSync(source,databasePath);
      db=openDatabase(databasePath);
      session=null;
      audit(db,actor.id,'backup.restored',{file:path.basename(source)});
      if(win&&!win.isDestroyed())win.webContents.reload();
      return {success:true,message:'تمت استعادة النسخة بنجاح. تم الاحتفاظ بنسخة أمان قبل الاستعادة.'};
    }catch(error){
      try{if(db?.open)db.close();}catch{}
      for(const suffix of ['-wal','-shm']){try{fs.unlinkSync(databasePath+suffix);}catch{}}
      fs.copyFileSync(safetyPath,databasePath);
      db=openDatabase(databasePath);
      throw error;
    }
  });

  ipcMain.handle('backup:restore',async()=>{
    const actor=admin();
    const picked=await dialog.showOpenDialog(win!,{
      properties:['openFile'],
      filters:[{name:'StoreFlow SQLite backup',extensions:['sqlite','sqlite3','db']}]
    });
    if(picked.canceled||!picked.filePaths[0])return {success:false,message:'تم إلغاء اختيار النسخة.'};
    const source=picked.filePaths[0];
    let candidate:Database.Database|null=null;
    try{
      candidate=new Database(source,{readonly:true,fileMustExist:true});
      const check=candidate.pragma('quick_check') as any[];
      const hasProducts=!!candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
      if(!check.length||String(check[0].quick_check).toLowerCase()!=='ok'||!hasProducts){
        throw new Error('ملف النسخة غير صالح أو لا يحتوي قاعدة StoreFlow.');
      }
    }finally{
      if(candidate?.open)candidate.close();
    }
    const safetyPath=path.join(path.dirname(databasePath),'StoreFlow_PreRestore_'+now().replace(/[:.]/g,'-')+'.sqlite');
    await db.backup(safetyPath);
    db.close();
    try{
      for(const suffix of ['-wal','-shm']){try{fs.unlinkSync(databasePath+suffix);}catch{}}
      fs.copyFileSync(source,databasePath);
      db=openDatabase(databasePath);
      session=null;
      audit(db,actor.id,'backup.restored',{source:path.basename(source),safetyCopy:path.basename(safetyPath)});
      if(win&&!win.isDestroyed())win.webContents.reload();
      return {success:true,message:'تمت استعادة النسخة. أُنشئت نسخة أمان تلقائية قبل الاستعادة.'};
    }catch(error){
      try{if(db?.open)db.close();}catch{}
      fs.copyFileSync(safetyPath,databasePath);
      db=openDatabase(databasePath);
      throw error;
    }
  });
  ipcMain.handle('products:list',(_e,q='')=>{
    login();const term='%'+String(q).trim()+'%';
    const rows=db.prepare("SELECT DISTINCT p.* FROM products p LEFT JOIN product_tags t ON t.product_id=p.id WHERE p.active=1 AND (p.name LIKE ? OR p.model LIKE ? OR p.brand LIKE ? OR p.barcode LIKE ? OR t.tag LIKE ?) ORDER BY p.updated_at DESC LIMIT 500").all(term,term,term,term,term) as any[];
    return rows.map(productDto);
  });
  ipcMain.handle('products:scan',(_e,code)=>{
    login();const value=String(code||'').trim();if(!value)return null;
    const serial=db.prepare("SELECT product_id FROM product_serials WHERE serial_number=? AND status='available'").get(value) as any;
    const row=serial?db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(serial.product_id):db.prepare('SELECT * FROM products WHERE barcode=? AND active=1').get(value);
    return row?productDto(row):null;
  });
  ipcMain.handle('products:create',(_e,v:ProductInput)=>{const u=admin();return productDto(db.prepare('SELECT * FROM products WHERE id=?').get(addProduct(v,u.id)));});
  ipcMain.handle('products:update',(_e,id:number,v:ProductInput)=>{
    const u=admin();const p=db.prepare('SELECT * FROM products WHERE id=?').get(id) as any;if(!p)throw new Error('المنتج غير موجود.');
    if(!!p.serial_tracking!==!!v.serialTracking)throw new Error('لا يمكن تغيير طريقة تتبع الرقم التسلسلي بعد إنشاء المنتج.');
    const tx=db.transaction(()=>{
      db.prepare('UPDATE products SET name=?,brand=?,model=?,category=?,generic_category=?,barcode=?,purchase_price=?,selling_price=?,allow_discount=?,low_stock_threshold=?,updated_at=? WHERE id=?')
        .run(v.name.trim(),v.brand||'',v.model||'',v.category||'',v.genericCategory||'',v.barcode?.trim()||null,v.purchasePrice,v.sellingPrice,v.allowDiscount?1:0,v.lowStockThreshold||5,now(),id);
      tagsFor(id,v.tags||[]);audit(db,u.id,'product.updated',{id});
    });tx();return productDto(db.prepare('SELECT * FROM products WHERE id=?').get(id));
  });
  ipcMain.handle('stock:adjust',(_e,v)=>{
    const u=admin();const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(v.productId) as any;
    if(!p)throw new Error('المنتج غير موجود.');
    const delta=Number(v.delta);if(!Number.isInteger(delta)||delta===0)throw new Error('الكمية غير صحيحة.');
    if(p.stock_quantity+delta<0)throw new Error('لا يمكن أن يصبح المخزون سالبًا.');
    const serials=(v.serials||[]).map((x:string)=>x.trim()).filter(Boolean);
    if(p.serial_tracking&&delta<0)throw new Error('الخصم السالب للمنتج المتسلسل يتم من خلال بيع أو مرتجع القطعة.');
    if(p.serial_tracking&&serials.length!==delta)throw new Error('أدخل Serial لكل قطعة مضافة.');
    const tx=db.transaction(()=>{
      if(delta>0&&v.unitCost!==undefined&&Number(v.unitCost)>=0){
        const avg=(p.purchase_price*p.stock_quantity+Number(v.unitCost)*delta)/(p.stock_quantity+delta);
        db.prepare('UPDATE products SET purchase_price=? WHERE id=?').run(avg,p.id);
      }
      db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,updated_at=? WHERE id=?').run(delta,now(),p.id);
      db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(p.id,delta>0?'restock':'adjustment',delta,v.reason||'تسوية مخزون',u.id,now());
      const ins=db.prepare("INSERT INTO product_serials(product_id,serial_number,status,created_at) VALUES (?,?,'available',?)");
      for(const serial of serials)ins.run(p.id,serial,now());
      audit(db,u.id,'stock.adjusted',{productId:p.id,delta});
    });tx();
  });
  ipcMain.handle('dashboard:get',(_e,from:string,to:string)=>{
    const u=login();if(u.role!=='admin')throw new Error('التقارير للأدمن فقط.');
    const totals=db.prepare("SELECT COUNT(*) n,COALESCE(SUM(s.subtotal),0)-COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r JOIN sale_items ri ON ri.id=r.sale_item_id JOIN sales rs ON rs.id=ri.sale_id WHERE rs.status!='void' AND rs.created_at BETWEEN ? AND ?),0) gross,COALESCE(SUM(s.discount_total),0) discount,COALESCE(SUM(s.total),0)-COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r JOIN sale_items ri ON ri.id=r.sale_item_id JOIN sales rs ON rs.id=ri.sale_id WHERE rs.status!='void' AND rs.created_at BETWEEN ? AND ?),0) net FROM sales s WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to,from,to,from,to) as any;
    const cost=db.prepare("SELECT COALESCE(SUM(si.unit_purchase_cost*(si.quantity-COALESCE(si.returned_quantity,0))),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const expenses=db.prepare('SELECT COALESCE(SUM(amount),0) value FROM expenses WHERE created_at BETWEEN ? AND ?').get(from,to) as any;
    const items=db.prepare("SELECT COALESCE(SUM(si.quantity),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const low=Number((db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND stock_quantity<=low_stock_threshold').get() as any).n);
    const top=db.prepare("SELECT product_name name,SUM(quantity) quantity,SUM(unit_selling_price*quantity-discount_amount) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ? GROUP BY product_id,product_name ORDER BY quantity DESC LIMIT 5").all(from,to) as any[];
    const c=Number(cost.value||0),net=Number(totals.net||0),exp=Number(expenses.value||0);
    return {grossSales:Number(totals.gross),discounts:Number(totals.discount),netSales:net,costOfGoods:c,grossProfit:net-c,expenses:exp,netProfit:net-c-exp,salesCount:Number(totals.n),itemsSold:Number(items.value),lowStockCount:low,topProducts:top};
  });
  ipcMain.handle('sales:quote',(_e,v)=>{
    login();
    const settings=getSettings(db);
    let subtotal=0,discountTotal=0;
    for(const item of v.items||[]){
      const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.productId) as any;
      if(!product)throw new Error('منتج غير متاح.');
      if(!Number.isInteger(item.quantity)||item.quantity<1)throw new Error('الكمية غير صحيحة.');
      if(product.stock_quantity<item.quantity)throw new Error('الكمية غير متاحة للمنتج '+product.name);
      const level:DiscountLevel=settings.discountEnabled?(v.invoiceDiscountLevel||item.discountLevel||null):null;
      const rate=level==='high'?settings.highDiscountPercent:level==='monster'?settings.monsterDiscountPercent:0;
      const margin=Math.max(0,product.selling_price-product.purchase_price)*item.quantity;
      subtotal+=product.selling_price*item.quantity;
      if(product.allow_discount)discountTotal+=margin*rate/100;
    }
    return {subtotal,discountTotal,total:Math.max(0,subtotal-discountTotal)};
  });

  ipcMain.handle('sales:create',(_e,v)=>{
    const u=login();
    if(!v.items?.length)throw new Error('الفاتورة فارغة.');
    const settings=getSettings(db);
    const id=crypto.randomUUID();
    const seqRow=db.prepare("SELECT value FROM settings WHERE key='invoiceSequence'").get() as any;
    const sequence=seqRow?Number(JSON.parse(seqRow.value)):1;
    const invoice='SF-'+now().slice(0,10).replace(/-/g,'')+'-'+String(sequence).padStart(5,'0');
    const tx=db.transaction(()=>{
      let subtotal=0,discountTotal=0;
      const lines:any[]=[];
      for(const item of v.items){
        const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.productId) as any;
        if(!product)throw new Error('منتج غير متاح.');
        if(!Number.isInteger(item.quantity)||item.quantity<1||product.stock_quantity<item.quantity){
          throw new Error('الكمية غير متاحة للمنتج '+product.name);
        }
        const serialNumbers=Array.isArray(item.serialNumbers)?item.serialNumbers.map((x:string)=>String(x).trim()).filter(Boolean):[];
        if(product.serial_tracking){
          if(serialNumbers.length!==item.quantity||new Set(serialNumbers).size!==serialNumbers.length){
            throw new Error('حدد رقمًا تسلسليًا مختلفًا لكل قطعة من '+product.name);
          }
          const available=new Set((db.prepare("SELECT serial_number FROM product_serials WHERE product_id=? AND status='available'").all(product.id) as any[]).map(row=>row.serial_number));
          for(const serial of serialNumbers)if(!available.has(serial))throw new Error('الرقم التسلسلي غير متاح: '+serial);
        }else if(serialNumbers.length){
          throw new Error('هذا المنتج لا يستخدم تتبع الأرقام التسلسلية.');
        }
        const level:DiscountLevel=settings.discountEnabled?(v.invoiceDiscountLevel||item.discountLevel||null):null;
        const rate=level==='high'?settings.highDiscountPercent:level==='monster'?settings.monsterDiscountPercent:0;
        const margin=Math.max(0,product.selling_price-product.purchase_price)*item.quantity;
        const lineDiscount=product.allow_discount?margin*rate/100:0;
        subtotal+=product.selling_price*item.quantity;
        discountTotal+=lineDiscount;
        lines.push({item,product,level,lineDiscount,serialNumbers});
      }
      const total=Math.max(0,subtotal-discountTotal);
      db.prepare('INSERT INTO sales(id,invoice_number,cashier_user_id,subtotal,discount_total,total,currency,currency_symbol,payment_method,customer_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,invoice,u.id,subtotal,discountTotal,total,settings.currency,settings.currencySymbol,v.paymentMethod||'cash',v.customerName||'','completed',now());
      for(const line of lines){
        const {item,product,level,lineDiscount,serialNumbers}=line;
        db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,returned_quantity,unit_purchase_cost,unit_selling_price,discount_amount,discount_level,serial_numbers) VALUES (?,?,?,?,0,?,?,?,?,?)')
          .run(id,product.id,product.name,item.quantity,product.purchase_price,product.selling_price,lineDiscount,level,JSON.stringify(serialNumbers));
        db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,updated_at=? WHERE id=?').run(item.quantity,now(),product.id);
        db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(product.id,'sale',-item.quantity,'فاتورة '+invoice,u.id,now());
        if(product.serial_tracking){
          const change=db.prepare("UPDATE product_serials SET status='sold' WHERE product_id=? AND serial_number=? AND status='available'");
          for(const serial of serialNumbers){
            const result=change.run(product.id,serial);
            if(result.changes!==1)throw new Error('تعذر حجز الرقم التسلسلي: '+serial);
          }
        }
      }
      db.prepare("INSERT INTO settings(key,value) VALUES ('invoiceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(sequence+1));
      audit(db,u.id,'sale.completed',{id,invoice,total,discountTotal});
    });
    tx();
    const row=db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id WHERE s.id=?').get(id) as any;
    return saleDto(row);
  });

  ipcMain.handle('sales:list',()=>{
    login();
    return (db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id ORDER BY s.created_at DESC LIMIT 500').all() as any[]).map(saleDto);
  });

  ipcMain.handle('sales:get',(_e,id:string)=>{
    login();
    const row=db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id WHERE s.id=?').get(id) as any;
    if(!row)throw new Error('الفاتورة غير موجودة.');
    const items=db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(id) as any[];
    return {
      ...saleDto(row),
      items:items.map(item=>({
        id:item.id,
        productId:item.product_id,
        productName:item.product_name,
        quantity:item.quantity,
        returnedQuantity:item.returned_quantity||0,
        unitPrice:item.unit_selling_price,
        unitCost:session?.role==='admin'?item.unit_purchase_cost:undefined,
        discountAmount:item.discount_amount,
        discountLevel:item.discount_level,
        serialNumbers:JSON.parse(item.serial_numbers||'[]')
      }))
    };
  });

  ipcMain.handle('sales:return-item',(_e,input)=>{
    const u=admin();
    const item=db.prepare('SELECT si.*,s.status sale_status,s.id sale_id FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.id=?').get(input.saleItemId) as any;
    if(!item||item.sale_status==='void'||item.sale_status==='refunded')throw new Error('لا يمكن إرجاع هذا العنصر.');
    const quantity=Number(input.quantity);
    const remaining=item.quantity-(item.returned_quantity||0);
    if(!Number.isInteger(quantity)||quantity<1||quantity>remaining)throw new Error('كمية المرتجع غير صحيحة.');
    const originalSerials=JSON.parse(item.serial_numbers||'[]') as string[];
    const returnSerials=Array.isArray(input.serialNumbers)?input.serialNumbers.map((x:string)=>String(x).trim()).filter(Boolean):[];
    if(originalSerials.length){
      if(returnSerials.length!==quantity||new Set(returnSerials).size!==returnSerials.length)throw new Error('حدد الرقم التسلسلي لكل قطعة مرتجعة.');
      for(const serial of returnSerials){
        if(!originalSerials.includes(serial))throw new Error('هذا الرقم ليس ضمن الفاتورة.');
        const status=db.prepare("SELECT id FROM product_serials WHERE product_id=? AND serial_number=? AND status='sold'").get(item.product_id,serial);
        if(!status)throw new Error('الرقم التسلسلي غير موجود بحالة بيع: '+serial);
      }
    }else if(returnSerials.length)throw new Error('العنصر لا يتطلب رقمًا تسلسليًا.');
    const refundPerUnit=Math.max(0,item.unit_selling_price-(item.discount_amount/Math.max(1,item.quantity)));
    const refund=Math.round(refundPerUnit*quantity*100)/100;
    const transaction=db.transaction(()=>{
      db.prepare('UPDATE sale_items SET returned_quantity=returned_quantity+? WHERE id=?').run(quantity,item.id);
      db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,updated_at=? WHERE id=?').run(quantity,now(),item.product_id);
      db.prepare('INSERT INTO sale_returns(sale_item_id,quantity,refund_amount,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(item.id,quantity,refund,String(input.reason||'مرتجع'),u.id,now());
      db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(item.product_id,'return',quantity,'مرتجع فاتورة',u.id,now());
      if(returnSerials.length){
        const update=db.prepare("UPDATE product_serials SET status='available' WHERE product_id=? AND serial_number=? AND status='sold'");
        for(const serial of returnSerials){
          if(update.run(item.product_id,serial).changes!==1)throw new Error('تعذر إعادة الرقم التسلسلي للمخزون: '+serial);
        }
      }
      const counts=db.prepare('SELECT COALESCE(SUM(quantity),0) total,COALESCE(SUM(returned_quantity),0) returned FROM sale_items WHERE sale_id=?').get(item.sale_id) as any;
      const status=counts.returned>=counts.total?'refunded':'partially_refunded';
      db.prepare('UPDATE sales SET status=? WHERE id=?').run(status,item.sale_id);
      audit(db,u.id,'sale.item-returned',{saleId:item.sale_id,saleItemId:item.id,quantity,refund,returnSerials});
    });
    transaction();
    return {success:true,refund};
  });

  ipcMain.handle('sales:void',(_e,saleId:string,reason:string)=>{
    const u=admin();
    const sale=db.prepare('SELECT * FROM sales WHERE id=?').get(saleId) as any;
    if(!sale||sale.status==='void'||sale.status==='refunded')throw new Error('لا يمكن إلغاء هذه الفاتورة.');
    const items=db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId) as any[];
    const transaction=db.transaction(()=>{
      for(const item of items){
        const remaining=item.quantity-(item.returned_quantity||0);
        if(remaining>0){
          db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,updated_at=? WHERE id=?').run(remaining,now(),item.product_id);
          db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
            .run(item.product_id,'void',remaining,'إلغاء فاتورة '+sale.invoice_number,u.id,now());
        }
        const serials=JSON.parse(item.serial_numbers||'[]') as string[];
        if(serials.length){
          const update=db.prepare("UPDATE product_serials SET status='available' WHERE product_id=? AND serial_number=? AND status='sold'");
          for(const serial of serials)update.run(item.product_id,serial);
        }
      }
      db.prepare("UPDATE sales SET status='void' WHERE id=?").run(saleId);
      audit(db,u.id,'sale.voided',{saleId,reason});
    });
    transaction();
  });

  ipcMain.handle('stock:movements',()=>{login();return (db.prepare('SELECT m.*,p.name product_name,u.display_name user_name FROM inventory_movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC LIMIT 300').all() as any[]).map(r=>({id:r.id,productName:r.product_name,type:r.type,quantityDelta:r.quantity_delta,reason:r.reason,userName:r.user_name,createdAt:r.created_at}));});
  ipcMain.handle('expense:create',(_e,v)=>{const u=admin();if(!v.title?.trim()||!(Number(v.amount)>0))throw new Error('بيانات المصروف غير صحيحة.');db.prepare('INSERT INTO expenses(title,amount,user_id,created_at) VALUES (?,?,?,?)').run(v.title.trim(),Number(v.amount),u.id,now());audit(db,u.id,'expense.created',v);});
  ipcMain.handle('users:list',()=>{admin();return (db.prepare('SELECT id,username,display_name,role,active FROM users ORDER BY id').all() as any[]).map(r=>({...userDto(r),active:!!r.active}));});
  ipcMain.handle('users:create',(_e,v)=>{const u=admin();if(!v.username?.trim()||!v.displayName?.trim()||String(v.password||'').length<8)throw new Error('كلمة المرور 8 أحرف على الأقل.');const name=v.username.trim().toLowerCase();db.prepare('INSERT INTO users(username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(name,v.displayName.trim(),hashPassword(v.password),v.role==='admin'?'admin':'seller',now());audit(db,u.id,'user.created',{username:name,role:v.role});});
  ipcMain.handle('users:active',(_e,id:number,active:boolean)=>{const u=admin();if(id===u.id&&!active)throw new Error('لا يمكن إيقاف حسابك الحالي.');db.prepare('UPDATE users SET active=? WHERE id=?').run(active?1:0,id);audit(db,u.id,'user.active-changed',{id,active});});
  ipcMain.handle('print:invoice',async(_e,html:string,size:PaperSize)=>{
    login();const paper=size==='A4'?'A4':{width:size==='58mm'?58000:80000,height:250000};
    const p=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await p.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(String(html||'')));
    return new Promise(resolve=>p.webContents.print({silent:false,printBackground:true,pageSize:paper,margins:{marginType:size==='A4'?'default':'none'}},(ok,reason)=>{if(!p.isDestroyed())p.close();resolve({success:ok,message:reason|| (ok?'تم إرسال الفاتورة للطباعة.':'تعذرت الطباعة.')});}));
  });
}
app.whenReady().then(()=>{
  databasePath=path.join(app.getPath('userData'),'storeflow.sqlite');
  db=openDatabase(databasePath);
  register();makeWindow();scheduleBackup();
  const s=getSettings(db);if(s.backupPaths.some(Boolean)){
    const span=Math.max(1,s.backupIntervalHours||24)*3600000;
    if(!s.lastBackupAt||Date.now()-new Date(s.lastBackupAt).getTime()>=span)setTimeout(()=>backup().catch(console.error),7000);
  }
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)makeWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{if(backupTimer)clearInterval(backupTimer);if(db?.open)db.close();});
app.on('web-contents-created',(_e,contents)=>{contents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});});
