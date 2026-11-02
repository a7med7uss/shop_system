import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {ProductInput,StoreSettings,DiscountLevel,PaperSize} from '../shared/types';
import {openDatabase,hashPassword,verifyPassword,getSettings,saveSettings,audit} from './database';

let db:Database.Database;
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
    const totals=db.prepare("SELECT COUNT(*) n,COALESCE(SUM(subtotal),0) gross,COALESCE(SUM(discount_total),0) discount,COALESCE(SUM(total),0) net FROM sales WHERE status!='void' AND created_at BETWEEN ? AND ?").get(from,to) as any;
    const cost=db.prepare("SELECT COALESCE(SUM(si.unit_purchase_cost*(si.quantity-COALESCE(si.returned_quantity,0))),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const expenses=db.prepare('SELECT COALESCE(SUM(amount),0) value FROM expenses WHERE created_at BETWEEN ? AND ?').get(from,to) as any;
    const items=db.prepare("SELECT COALESCE(SUM(si.quantity),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const low=Number((db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND stock_quantity<=low_stock_threshold').get() as any).n);
    const top=db.prepare("SELECT product_name name,SUM(quantity) quantity,SUM(unit_selling_price*quantity-discount_amount) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ? GROUP BY product_id,product_name ORDER BY quantity DESC LIMIT 5").all(from,to) as any[];
    const c=Number(cost.value||0),net=Number(totals.net||0),exp=Number(expenses.value||0);
    return {grossSales:Number(totals.gross),discounts:Number(totals.discount),netSales:net,costOfGoods:c,grossProfit:net-c,expenses:exp,netProfit:net-c-exp,salesCount:Number(totals.n),itemsSold:Number(items.value),lowStockCount:low,topProducts:top};
  });
  ipcMain.handle('sales:create',(_e,v)=>{
    const u=login();if(!v.items?.length)throw new Error('الفاتورة فارغة.');
    const s=getSettings(db);const id=crypto.randomUUID();
    const seqRow=db.prepare("SELECT value FROM settings WHERE key='invoiceSequence'").get() as any;
    const seq=seqRow?Number(JSON.parse(seqRow.value)):1;
    const invoice='SF-'+now().slice(0,10).replace(/-/g,'')+'-'+String(seq).padStart(5,'0');
    const tx=db.transaction(()=>{
      let subtotal=0,discount=0;const lines:any[]=[];
      for(const item of v.items){
        const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.productId) as any;
        if(!p)throw new Error('منتج غير متاح.');
        if(!Number.isInteger(item.quantity)||item.quantity<1||p.stock_quantity<item.quantity)throw new Error('الكمية غير متاحة للمنتج '+p.name);
        const level:DiscountLevel=s.discountEnabled?(v.invoiceDiscountLevel||item.discountLevel||null):null;
        const rate=level==='high'?s.highDiscountPercent:level==='monster'?s.monsterDiscountPercent:0;
        const margin=Math.max(0,p.selling_price-p.purchase_price)*item.quantity;
        const off=p.allow_discount?margin*rate/100:0;
        subtotal+=p.selling_price*item.quantity;discount+=off;
        lines.push({item,p,level,off});
      }
      const total=Math.max(0,subtotal-discount);
      db.prepare('INSERT INTO sales(id,invoice_number,cashier_user_id,subtotal,discount_total,total,currency,currency_symbol,payment_method,customer_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,invoice,u.id,subtotal,discount,total,s.currency,s.currencySymbol,v.paymentMethod||'cash',v.customerName||'','completed',now());
      for(const line of lines){
        const {item,p,level,off}=line;
        db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_purchase_cost,unit_selling_price,discount_amount,discount_level,serial_numbers) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id,p.id,p.name,item.quantity,p.purchase_price,p.selling_price,off,level,JSON.stringify(item.serialNumbers||[]));
        db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,updated_at=? WHERE id=?').run(item.quantity,now(),p.id);
        db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(p.id,'sale',-item.quantity,'فاتورة '+invoice,u.id,now());
      }
      db.prepare("INSERT INTO settings(key,value) VALUES ('invoiceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(seq+1));
      audit(db,u.id,'sale.completed',{id,invoice,total,discount});
    });
    tx();
    const row=db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id WHERE s.id=?').get(id) as any;
    return saleDto(row);
  });
  ipcMain.handle('sales:list',()=>{login();return (db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id ORDER BY s.created_at DESC LIMIT 500').all() as any[]).map(saleDto);});
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
  db=openDatabase(path.join(app.getPath('userData'),'storeflow.sqlite'));
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
