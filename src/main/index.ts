import {app,BrowserWindow,ipcMain,dialog,shell,safeStorage} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {ProductInput,StoreSettings,DiscountLevel,PaperSize} from '../shared/types';
import {openDatabase,hashPassword,verifyPassword,getSettings,saveSettings,audit,validateBackupDatabase} from './database';

let db:Database.Database;
let databasePath='';
const rememberFile=()=>path.join(app.getPath('userData'),'remembered-login.bin');
app.setName('storeflow');
app.setAppUserModelId('com.ahmedhusseinemara.storeflow');

/**
 * Keep user data from older Kasho/StoreFlow package identities.
 * A changed Electron app name changes app.getPath('userData') on Windows;
 * without this migration an upgrade can silently look like a brand-new install.
 * Never overwrite an existing canonical database or choose between multiple
 * legacy databases automatically.
 */
async function migrateLegacyDatabase(targetPath:string) {
  if(fs.existsSync(targetPath)) return false;
  const appData=app.getPath('appData');
  const candidates=[
    path.join(appData,'Kasho','storeflow.sqlite'),
    path.join(appData,'Kasho','kasho.sqlite'),
    path.join(appData,'StoreFlow','storeflow.sqlite'),
    path.join(appData,'StoreFlow','kasho.sqlite')
  ].filter(file=>fs.existsSync(file));
  if(candidates.length===0) return false;
  if(candidates.length>1) {
    throw new Error('تم العثور على أكثر من قاعدة بيانات قديمة. لم يتم إنشاء قاعدة جديدة أو استبدال أي بيانات. انقل قاعدة البيانات الصحيحة إلى مجلد بيانات Kasho ثم أعد التشغيل.');
  }
  const source=candidates[0];
  try {
    const legacy=new Database(source,{readonly:true,fileMustExist:true});
    try {
      const integrity=legacy.pragma('integrity_check',{simple:true});
      const hasUsers=!!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
      if(integrity!=='ok'||!hasUsers) {
        throw new Error('قاعدة البيانات القديمة موجودة لكنها غير سليمة أو لا تحتوي على بيانات Kasho المتوقعة. لم يتم استبدالها.');
      }
      await legacy.backup(targetPath);
    } finally {
      legacy.close();
    }
    const migrated=new Database(targetPath,{readonly:true,fileMustExist:true});
    try {
      const integrity=migrated.pragma('integrity_check',{simple:true});
      const hasUsers=!!migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
      if(integrity!=='ok'||!hasUsers) throw new Error('تعذر التحقق من نسخة قاعدة البيانات بعد ترحيلها. قاعدة البيانات الأصلية ما زالت محفوظة.');
    } finally {
      migrated.close();
    }
  } catch(error) {
    for(const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(targetPath+suffix); } catch {}
    }
    throw error;
  }
  const legacyLanguage=path.join(path.dirname(source),'install-language.txt');
  const targetLanguage=path.join(path.dirname(targetPath),'install-language.txt');
  if(!fs.existsSync(targetLanguage)&&fs.existsSync(legacyLanguage)) {
    fs.copyFileSync(legacyLanguage,targetLanguage);
  }
  return true;
}
let win:BrowserWindow|null=null;
let session:any=null;
let backupTimer:NodeJS.Timeout|null=null;
let backupBusy=false;
const now=()=>new Date().toISOString();
const login=()=>{if(!session)throw new Error('سجّل الدخول أولاً.');return session;};
const admin=()=>{const u=login();if(u.role!=='admin')throw new Error('هذه العملية للأدمن فقط.');return u;};
const userDto=(r:any)=>({id:r.id,username:r.username,displayName:r.display_name,role:r.role});
function productDto(row:any){
  const dto:any={id:row.id,name:row.name,brand:row.brand,model:row.model,category:row.category,genericCategory:row.generic_category,barcode:row.barcode||'',sellingPrice:row.selling_price,stockQuantity:row.stock_quantity,allowDiscount:!!row.allow_discount,lowStockThreshold:row.low_stock_threshold,visualType:row.visual_type||'default',iconKey:row.icon_key||'',visualColor:row.visual_color||'',imageData:row.image_data||'',tags:(db.prepare('SELECT tag FROM product_tags WHERE product_id=? ORDER BY tag').all(row.id) as any[]).map(x=>x.tag)};
  if(session?.role==='admin')dto.purchasePrice=row.purchase_price;
  return dto;
}
function tagsFor(id:number,tags:string[]){db.prepare('DELETE FROM product_tags WHERE product_id=?').run(id);const s=db.prepare('INSERT OR IGNORE INTO product_tags(product_id,tag) VALUES (?,?)');for(const item of tags||[]){const v=String(item).trim().replace(/^#+/,'');if(v)s.run(id,v.slice(0,50));}}
function addProduct(input:ProductInput,userId:number){
  if(!input.name?.trim())throw new Error('اسم المنتج مطلوب.');
  const visualType=input.visualType||'default';
  if(!['default','icon','color','image'].includes(visualType))throw new Error('نوع مظهر المنتج غير صالح.');
  if(input.visualColor&&!/^#[0-9a-fA-F]{6}$/.test(input.visualColor))throw new Error('لون المنتج غير صالح.');
  if(input.imageData&&(!/^data:image\/(png|jpeg|webp);base64,/.test(input.imageData)||input.imageData.length>2.1*1024*1024))throw new Error('صورة المنتج غير صالحة أو أكبر من الحد المسموح.');
  if(visualType==='image'&&!input.imageData)throw new Error('اختر صورة المنتج أولاً.');
  if(visualType==='icon'&&!input.iconKey)throw new Error('اختر أيقونة المنتج أولاً.');
  if(input.purchasePrice<0||input.sellingPrice<0)throw new Error('الأسعار يجب ألا تكون سالبة.');
  const qty=Number(input.stockQuantity||0);
  if(!Number.isInteger(qty)||qty<0)throw new Error('الكمية غير صحيحة.');
  const stamp=now();
  const tx=db.transaction(()=>{
    const result=db.prepare('INSERT INTO products(name,brand,model,category,generic_category,barcode,purchase_price,selling_price,stock_quantity,allow_discount,serial_tracking,low_stock_threshold,visual_type,icon_key,visual_color,image_data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(input.name.trim(),input.brand||'',input.model||'',input.category||'',input.genericCategory||'',input.barcode?.trim()||null,input.purchasePrice,input.sellingPrice,qty,input.allowDiscount?1:0,0,input.lowStockThreshold||5,input.visualType||'default',input.iconKey||'',input.visualColor||'',input.imageData||'',stamp,stamp);
    const id=Number(result.lastInsertRowid);tagsFor(id,input.tags||[]);
    if(qty)db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(id,'restock',qty,'إضافة مخزون عند إنشاء المنتج',userId,stamp);
    audit(db,userId,'product.created',{id,name:input.name});
    return id;
  });
  return tx();
}
function saleDto(row:any){return {id:row.id,invoiceNumber:row.invoice_number,cashierName:row.cashier_name,subtotal:row.subtotal,discountTotal:row.discount_total,total:row.total,totalRefunded:Number(row.total_refunded||0),currency:row.currency,currencySymbol:row.currency_symbol,paymentMethod:row.payment_method,customerName:row.customer_name||'',status:row.status,createdAt:row.created_at};}
async function readRememberedLogin(){
  try{
    if(!fs.existsSync(rememberFile())||!(await safeStorage.isAsyncEncryptionAvailable()))return null;
    const decrypted=await safeStorage.decryptStringAsync(fs.readFileSync(rememberFile()));
    const raw=typeof decrypted==='string'?decrypted:decrypted.result;
    const parsed=JSON.parse(raw);
    return typeof parsed.username==='string'&&typeof parsed.password==='string'?parsed:null;
  }catch{return null;}
}
async function writeRememberedLogin(value:any){
  const file=rememberFile();
  if(!value?.remember){try{fs.unlinkSync(file);}catch{}return {saved:false};}
  const username=String(value.username||'').trim(),password=String(value.password||'');
  if(!username||!password)throw new Error('بيانات الدخول غير مكتملة.');
  if(!(await safeStorage.isAsyncEncryptionAvailable()))throw new Error('ميزة حفظ كلمة المرور المشفّرة غير متاحة على هذا الجهاز.');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,await safeStorage.encryptStringAsync(JSON.stringify({username,password})),{mode:0o600});
  return {saved:true};
}

async function backup(){
  if(backupBusy)throw new Error('النسخ الاحتياطي يعمل بالفعل.');
  const settings=getSettings(db);const configured=(settings.backupPaths||[]).filter(Boolean).slice(0,3);
  const dirs=configured.length?configured:[path.join(app.getPath('documents'),'Kasho','Backups')];
  backupBusy=true;const output:any[]=[];const stamp=now().replace(/[:.]/g,'-');
  try{
    for(const dir of dirs){
      try{
        fs.mkdirSync(dir,{recursive:true});
        const file=path.join(dir,'Kasho_Backup_'+stamp+'.sqlite');
        await db.backup(file);
        const keep=30;
        const old=fs.readdirSync(dir).filter(x=>(x.startsWith('Kasho_Backup_')||x.startsWith('StoreFlow_Backup_'))&&x.endsWith('.sqlite')).map(name=>({name,mtime:fs.statSync(path.join(dir,name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
        for(const item of old.slice(keep)){try{fs.unlinkSync(path.join(dir,item.name));}catch{}}
        output.push({path:dir,success:true,message:'تم النسخ'});
      }catch(e:any){output.push({path:dir,success:false,message:e.message||'فشل النسخ'});}
    }
    const success=output.some(x=>x.success);
    const completed=success?now():'';
    if(success)db.prepare("INSERT INTO settings(key,value) VALUES ('lastBackupAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(completed));
    return {success,completedAt:completed,results:output};
  }finally{backupBusy=false;}
}
function scheduleBackup(){
  if(backupTimer)clearInterval(backupTimer);
  backupTimer=setInterval(async()=>{
    if(backupBusy||!db||!app.isReady())return;
    const s=getSettings(db);
    const span=Math.max(1,s.backupIntervalHours||24)*3600000;
    const last=s.lastBackupAt?new Date(s.lastBackupAt).getTime():0;
    if(!last||Date.now()-last>=span){try{await backup();}catch(e){console.error(e);}}
  },60000);
}
function makeWindow(){
  win=new BrowserWindow({width:1480,height:920,minWidth:760,minHeight:560,backgroundColor:'#121110',title:'Kasho',icon:app.isPackaged?path.join(process.resourcesPath,'icon.ico'):path.join(process.cwd(),'build','icon.ico'),frame:false,autoHideMenuBar:true,webPreferences:{preload:path.join(app.getAppPath(),'dist-electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const dev=process.env.VITE_DEV_SERVER_URL;
  if(dev)win.loadURL(dev);else win.loadFile(path.join(app.getAppPath(),'dist','index.html'));
  win.on('closed',()=>{win=null;});
}
function register(){
  ipcMain.handle('window:minimize',()=>{if(win&&!win.isDestroyed())win.minimize();});
  ipcMain.handle('window:toggle-maximize',()=>{if(!win||win.isDestroyed())return false;if(win.isMaximized())win.unmaximize();else win.maximize();return win.isMaximized();});
  ipcMain.handle('window:close',()=>{if(win&&!win.isDestroyed())win.close();});
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
  ipcMain.handle('auth:remember:get',async()=>readRememberedLogin());
  ipcMain.handle('auth:remember:set',async(_e,value)=>writeRememberedLogin(value));
  ipcMain.handle('window:toggle-fullscreen',()=>{if(!win||win.isDestroyed())return false;const next=!win.isFullScreen();win.setFullScreen(next);return next;});
  ipcMain.handle('settings:get',()=>{login();return getSettings(db);});
  ipcMain.handle('settings:theme',(_e,theme)=>{const u=login();if(!['system','light','dark'].includes(theme))throw new Error('الثيم غير صالح.');db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('theme',JSON.stringify(theme));audit(db,u.id,'settings.theme-changed',{theme});return theme;});
  ipcMain.handle('settings:save',(_e,v:StoreSettings)=>{
    const u=admin();if(!Array.isArray(v.backupPaths)||v.backupPaths.length>3)throw new Error('ثلاثة مسارات نسخ احتياطي كحد أقصى.');
    const s={...getSettings(db),...v};
    s.highDiscountPercent=Math.max(0,Math.min(100,Number(s.highDiscountPercent)||0));
    s.monsterDiscountPercent=Math.max(0,Math.min(100,Number(s.monsterDiscountPercent)||0));
    s.backupIntervalHours=Math.max(1,Number(s.backupIntervalHours)||24);
    s.fontScale=Math.max(0.9,Math.min(1.2,Number(s.fontScale)||1));
    saveSettings(db,s);audit(db,u.id,'settings.updated',{currency:s.currency,paperSize:s.paperSize});scheduleBackup();return s;
  });
  ipcMain.handle('dialog:directory',async()=>{admin();const r=await dialog.showOpenDialog(win!,{properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('dialog:image',async()=>{admin();const r=await dialog.showOpenDialog(win!,{properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','svg']}]});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle('products:choose-image',async()=>{
    admin();
    const picked=await dialog.showOpenDialog(win!,{properties:['openFile'],filters:[{name:'Product images',extensions:['png','jpg','jpeg','webp']}]});
    if(picked.canceled||!picked.filePaths[0])return null;
    const file=picked.filePaths[0],stat=fs.statSync(file);
    if(stat.size>1.5*1024*1024)throw new Error('حجم صورة المنتج يجب ألا يتجاوز 1.5 ميجابايت.');
    const ext=path.extname(file).toLowerCase(),mime=ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg';
    return 'data:'+mime+';base64,'+fs.readFileSync(file).toString('base64');
  });
  ipcMain.handle('backup:run',async()=>{admin();return backup();});
  ipcMain.handle('backup:restore',async()=>{
    const actor=admin();
    const picked=await dialog.showOpenDialog(win!,{
      properties:['openFile'],
      filters:[{name:'Kasho SQLite backup',extensions:['sqlite','sqlite3','db']}]
    });
    if(picked.canceled||!picked.filePaths[0])return {success:false,message:'تم إلغاء اختيار النسخة.'};
    const source=picked.filePaths[0];
    if(path.resolve(source)===path.resolve(databasePath)){
      throw new Error('لا يمكن استعادة قاعدة البيانات النشطة فوق نفسها. اختر ملف نسخة احتياطية آخر.');
    }
    const validation=validateBackupDatabase(source);
    if(!validation.valid)throw new Error(validation.message);
    const safetyPath=path.join(path.dirname(databasePath),'Kasho_PreRestore_'+now().replace(/[:.]/g,'-')+'.sqlite');
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
    const row=db.prepare('SELECT * FROM products WHERE barcode=? AND active=1').get(value) as any;
    return row?productDto(row):null;
  });
  ipcMain.handle('products:create',(_e,v:ProductInput)=>{const u=admin();return productDto(db.prepare('SELECT * FROM products WHERE id=?').get(addProduct(v,u.id)));});
  ipcMain.handle('products:update',(_e,id:number,v:ProductInput)=>{
    const u=admin();
    if(!['default','icon','color','image'].includes(v.visualType||'default'))throw new Error('نوع مظهر المنتج غير صالح.');
    if(v.visualColor&&!/^#[0-9a-fA-F]{6}$/.test(v.visualColor))throw new Error('لون المنتج غير صالح.');
    if(v.imageData&&(!/^data:image\/(png|jpeg|webp);base64,/.test(v.imageData)||v.imageData.length>2.1*1024*1024))throw new Error('صورة المنتج غير صالحة أو أكبر من الحد المسموح.');
    if(v.visualType==='image'&&!v.imageData)throw new Error('اختر صورة المنتج أولاً.');
    if(v.visualType==='icon'&&!v.iconKey)throw new Error('اختر أيقونة المنتج أولاً.');
    const p=db.prepare('SELECT * FROM products WHERE id=?').get(id) as any;if(!p)throw new Error('المنتج غير موجود.');
    const tx=db.transaction(()=>{
      db.prepare('UPDATE products SET name=?,brand=?,model=?,category=?,generic_category=?,barcode=?,purchase_price=?,selling_price=?,allow_discount=?,low_stock_threshold=?,visual_type=?,icon_key=?,visual_color=?,image_data=?,updated_at=? WHERE id=?')
        .run(v.name.trim(),v.brand||'',v.model||'',v.category||'',v.genericCategory||'',v.barcode?.trim()||null,v.purchasePrice,v.sellingPrice,v.allowDiscount?1:0,v.lowStockThreshold||5,v.visualType||'default',v.iconKey||'',v.visualColor||'',v.imageData||'',now(),id);
      tagsFor(id,v.tags||[]);audit(db,u.id,'product.updated',{id});
    });tx();return productDto(db.prepare('SELECT * FROM products WHERE id=?').get(id));
  });
  ipcMain.handle('products:delete',(_e,id:number)=>{
    const u=admin();
    const product=db.prepare('SELECT id,name,active FROM products WHERE id=?').get(id) as any;
    if(!product||!product.active)throw new Error('المنتج غير موجود أو تم حذفه بالفعل.');
    const tx=db.transaction(()=>{
      db.prepare('UPDATE products SET active=0,updated_at=? WHERE id=?').run(now(),id);
      audit(db,u.id,'product.archived',{id,name:product.name});
    });
    tx();
    return {success:true};
  });
  ipcMain.handle('stock:adjust',(_e,v)=>{
    const u=admin();const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(v.productId) as any;
    if(!p)throw new Error('المنتج غير موجود.');
    const delta=Number(v.delta);if(!Number.isInteger(delta)||delta===0)throw new Error('الكمية غير صحيحة.');
    if(p.stock_quantity+delta<0)throw new Error('لا يمكن أن يصبح المخزون سالبًا.');
    const tx=db.transaction(()=>{
      db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,updated_at=? WHERE id=?').run(delta,now(),p.id);
      db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)').run(p.id,delta>0?'restock':'adjustment',delta,v.reason||'تسوية مخزون',u.id,now());
      audit(db,u.id,'stock.adjusted',{productId:p.id,delta});
    });tx();
  });
  ipcMain.handle('dashboard:get',(_e,from:string,to:string)=>{
    const u=login();if(u.role!=='admin')throw new Error('التقارير للأدمن فقط.');
    const totals=db.prepare("SELECT COUNT(*) n,COALESCE(SUM(s.subtotal),0)-COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r JOIN sale_items ri ON ri.id=r.sale_item_id JOIN sales rs ON rs.id=ri.sale_id WHERE rs.status!='void' AND rs.created_at BETWEEN ? AND ?),0) gross,COALESCE(SUM(s.discount_total),0)-COALESCE((SELECT SUM(ri.discount_amount*r.quantity/MAX(1,ri.quantity)) FROM sale_returns r JOIN sale_items ri ON ri.id=r.sale_item_id JOIN sales rs ON rs.id=ri.sale_id WHERE rs.status!='void' AND rs.created_at BETWEEN ? AND ?),0) discount,COALESCE(SUM(s.total),0) net FROM sales s WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to,from,to,from,to) as any;
    const cost=db.prepare("SELECT COALESCE(SUM(si.unit_purchase_cost*(si.quantity-COALESCE(si.returned_quantity,0))),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const expenses=db.prepare('SELECT COALESCE(SUM(amount),0) value FROM expenses WHERE created_at BETWEEN ? AND ?').get(from,to) as any;
    const items=db.prepare("SELECT COALESCE(SUM(si.quantity-COALESCE(si.returned_quantity,0)),0) value FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ?").get(from,to) as any;
    const low=Number((db.prepare('SELECT COUNT(*) n FROM products WHERE active=1 AND stock_quantity<=low_stock_threshold').get() as any).n);
    const top=db.prepare("SELECT product_name name,SUM(quantity-COALESCE(returned_quantity,0)) quantity,SUM(unit_selling_price*(quantity-COALESCE(returned_quantity,0))-discount_amount*(quantity-COALESCE(returned_quantity,0))/MAX(1,quantity)) revenue FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status!='void' AND s.created_at BETWEEN ? AND ? GROUP BY product_id,product_name ORDER BY quantity DESC LIMIT 5").all(from,to) as any[];
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
      const level:DiscountLevel=settings.discountEnabled?(item.discountLevel||null):null;
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
    const invoice='KH-'+now().slice(0,10).replace(/-/g,'')+'-'+String(sequence).padStart(5,'0');
    const tx=db.transaction(()=>{
      let subtotal=0,discountTotal=0;
      const lines:any[]=[];
      for(const item of v.items){
        const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.productId) as any;
        if(!product)throw new Error('منتج غير متاح.');
        if(!Number.isInteger(item.quantity)||item.quantity<1||product.stock_quantity<item.quantity){
          throw new Error('الكمية غير متاحة للمنتج '+product.name);
        }
        const level:DiscountLevel=settings.discountEnabled?(item.discountLevel||null):null;
        const rate=level==='high'?settings.highDiscountPercent:level==='monster'?settings.monsterDiscountPercent:0;
        const margin=Math.max(0,product.selling_price-product.purchase_price)*item.quantity;
        const lineDiscount=product.allow_discount?margin*rate/100:0;
        subtotal+=product.selling_price*item.quantity;
        discountTotal+=lineDiscount;
        lines.push({item,product,level,lineDiscount});
      }
      const total=Math.max(0,subtotal-discountTotal);
      db.prepare('INSERT INTO sales(id,invoice_number,cashier_user_id,subtotal,discount_total,total,currency,currency_symbol,payment_method,customer_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,invoice,u.id,subtotal,discountTotal,total,settings.currency,settings.currencySymbol,v.paymentMethod||'cash',v.customerName||'','completed',now());
      for(const line of lines){
        const {item,product,level,lineDiscount}=line;
        db.prepare('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,returned_quantity,unit_purchase_cost,unit_selling_price,discount_amount,discount_level,serial_numbers) VALUES (?,?,?,?,0,?,?,?,?,?)')
          .run(id,product.id,product.name,item.quantity,product.purchase_price,product.selling_price,lineDiscount,level,JSON.stringify([]));
        db.prepare('UPDATE products SET stock_quantity=stock_quantity-?,updated_at=? WHERE id=?').run(item.quantity,now(),product.id);
        db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(product.id,'sale',-item.quantity,'فاتورة '+invoice,u.id,now());
      }
      db.prepare("INSERT INTO settings(key,value) VALUES ('invoiceSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(sequence+1));
      audit(db,u.id,'sale.completed',{id,invoice,total,discountTotal});
    });
    tx();
    const row=db.prepare('SELECT s.*,u.display_name cashier_name,COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r JOIN sale_items si ON si.id=r.sale_item_id WHERE si.sale_id=s.id),0) total_refunded FROM sales s JOIN users u ON u.id=s.cashier_user_id WHERE s.id=?').get(id) as any;
    return saleDto(row);
  });

  ipcMain.handle('sales:list',()=>{
    const u=login();
    const saleQuery=`SELECT s.*,u.display_name cashier_name,
      COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r JOIN sale_items si ON si.id=r.sale_item_id WHERE si.sale_id=s.id),0) total_refunded
      FROM sales s JOIN users u ON u.id=s.cashier_user_id`;
    const rows=(u.role==='admin'
      ? db.prepare(saleQuery+' ORDER BY s.created_at DESC LIMIT 500').all()
      : db.prepare(saleQuery+' WHERE s.cashier_user_id=? ORDER BY s.created_at DESC LIMIT 500').all(u.id)) as any[];
    return rows.map(saleDto);
  });

  ipcMain.handle('sales:get',(_e,id:string)=>{
    const actor=login();
    const row=db.prepare('SELECT s.*,u.display_name cashier_name FROM sales s JOIN users u ON u.id=s.cashier_user_id WHERE s.id=?').get(id) as any;
    if(!row||(actor.role!=='admin'&&row.cashier_user_id!==actor.id))throw new Error('الفاتورة غير موجودة أو لا تملك صلاحية عرضها.');
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
      }))
    };
  });

  ipcMain.handle('sales:return-item',(_e,input)=>{
    const u=login();
    const item=db.prepare('SELECT si.*,s.status sale_status,s.id sale_id,s.cashier_user_id,s.subtotal sale_subtotal,s.discount_total sale_discount_total FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.id=?').get(input.saleItemId) as any;
    if(!item||(u.role!=='admin'&&item.cashier_user_id!==u.id))throw new Error('لا تملك صلاحية إرجاع هذا العنصر.');
    if(item.sale_status==='void'||item.sale_status==='refunded')throw new Error('لا يمكن إرجاع هذا العنصر.');
    const quantity=Number(input.quantity);
    const remaining=item.quantity-(item.returned_quantity||0);
    if(!Number.isInteger(quantity)||quantity<1||quantity>remaining)throw new Error('كمية المرتجع غير صحيحة.');
    const refundPerUnit=Math.max(0,item.unit_selling_price-(item.discount_amount/Math.max(1,item.quantity)));
    const refund=Math.round(refundPerUnit*quantity*100)/100;
    const transaction=db.transaction(()=>{
      db.prepare('UPDATE sale_items SET returned_quantity=returned_quantity+? WHERE id=?').run(quantity,item.id);
      db.prepare('UPDATE products SET stock_quantity=stock_quantity+?,updated_at=? WHERE id=?').run(quantity,now(),item.product_id);
      db.prepare('INSERT INTO sale_returns(sale_item_id,quantity,refund_amount,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(item.id,quantity,refund,String(input.reason||'مرتجع'),u.id,now());
      db.prepare('INSERT INTO inventory_movements(product_id,type,quantity_delta,reason,user_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(item.product_id,'return',quantity,'مرتجع فاتورة',u.id,now());
      const counts=db.prepare('SELECT COALESCE(SUM(quantity),0) total,COALESCE(SUM(returned_quantity),0) returned FROM sale_items WHERE sale_id=?').get(item.sale_id) as any;
      const refunded=Number((db.prepare('SELECT COALESCE(SUM(r.refund_amount),0) amount FROM sale_returns r JOIN sale_items si ON si.id=r.sale_item_id WHERE si.sale_id=?').get(item.sale_id) as any).amount||0);
      const originalTotal=Math.max(0,Number(item.sale_subtotal)-Number(item.sale_discount_total));
      const netTotal=Math.max(0,Math.round((originalTotal-refunded)*100)/100);
      const status=counts.returned>=counts.total?'refunded':'partially_refunded';
      db.prepare('UPDATE sales SET status=?,total=? WHERE id=?').run(status,netTotal,item.sale_id);
      audit(db,u.id,'sale.item-returned',{saleId:item.sale_id,saleItemId:item.id,quantity,refund});
    });
    transaction();
    const totalRefunded=Number((db.prepare('SELECT COALESCE(SUM(r.refund_amount),0) amount FROM sale_returns r JOIN sale_items si ON si.id=r.sale_item_id WHERE si.sale_id=?').get(item.sale_id) as any).amount||0);
    return {success:true,refund,totalRefunded,netTotal:Math.max(0,Math.round((Number(item.sale_subtotal)-Number(item.sale_discount_total)-totalRefunded)*100)/100)};
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
      }
      db.prepare("UPDATE sales SET status='void' WHERE id=?").run(saleId);
      audit(db,u.id,'sale.voided',{saleId,reason});
    });
    transaction();
  });

  ipcMain.handle('stock:movements',()=>{
    const actor=login();
    const rows=(actor.role==='admin'
      ? db.prepare('SELECT m.*,p.name product_name,u.display_name user_name FROM inventory_movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC LIMIT 300').all()
      : db.prepare('SELECT m.*,p.name product_name,u.display_name user_name FROM inventory_movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id WHERE m.user_id=? ORDER BY m.created_at DESC LIMIT 300').all(actor.id)) as any[];
    return rows.map(r=>({id:r.id,productName:r.product_name,type:r.type,quantityDelta:r.quantity_delta,reason:r.reason,userName:r.user_name,createdAt:r.created_at}));
  });
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
app.whenReady().then(async()=>{
  databasePath=path.join(app.getPath('userData'),'storeflow.sqlite');
  await migrateLegacyDatabase(databasePath);
  db=openDatabase(databasePath);
  const adminCount=Number((db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get() as any).n);
  if(!adminCount){
    const langFile=path.join(app.getPath('userData'),'install-language.txt');
    try{const installedLanguage=fs.readFileSync(langFile,'utf8').trim();if(installedLanguage==='ar'||installedLanguage==='en')saveSettings(db,{...getSettings(db),language:installedLanguage});}catch{}
  }
  register();makeWindow();scheduleBackup();
  const s=getSettings(db);
  const span=Math.max(1,s.backupIntervalHours||24)*3600000;
  if(!s.lastBackupAt||Date.now()-new Date(s.lastBackupAt).getTime()>=span)setTimeout(()=>backup().catch(console.error),7000);
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)makeWindow();});
}).catch(error=>{
  console.error('Kasho startup failed:',error);
  dialog.showErrorBox('تعذر تشغيل Kasho',error?.message||String(error));
  app.quit();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{if(backupTimer)clearInterval(backupTimer);if(db?.open)db.close();});
app.on('web-contents-created',(_e,contents)=>{contents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});});
