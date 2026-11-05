export type Role = 'admin' | 'seller';
export type DiscountLevel = 'high' | 'monster' | null;
export type Language = 'ar' | 'en';
export type Theme = 'system' | 'light' | 'dark';
export type PaperSize = 'A4' | '58mm' | '80mm';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export interface Product {
  id: number;
  name: string;
  brand: string;
  model: string;
  category: string;
  genericCategory: string;
  barcode: string;
  purchasePrice?: number;
  sellingPrice: number;
  stockQuantity: number;
  allowDiscount: boolean;
  lowStockThreshold: number;
  visualType: 'default' | 'icon' | 'color' | 'image';
  iconKey: string;
  visualColor: string;
  imageData: string;
  tags: string[];
}

export interface ProductInput {
  name: string;
  brand?: string;
  model?: string;
  category?: string;
  genericCategory?: string;
  barcode?: string;
  purchasePrice: number;
  sellingPrice: number;
  stockQuantity?: number;
  allowDiscount: boolean;
  lowStockThreshold: number;
  visualType?: 'default' | 'icon' | 'color' | 'image';
  iconKey?: string;
  visualColor?: string;
  imageData?: string;
  tags: string[];
}

export interface CartLine {
  productId: number;
  quantity: number;
  discountLevel: DiscountLevel;
}

export interface StoreSettings {
  storeName: string;
  storeDescription: string;
  storeAddress: string;
  storePhone: string;
  storeLogoPath: string;
  language: Language;
  currency: string;
  currencySymbol: string;
  theme: Theme;
  fontScale: number;
  paperSize: PaperSize;
  discountEnabled: boolean;
  highDiscountPercent: number;
  monsterDiscountPercent: number;
  confirmSaleEnabled: boolean;
  backupPaths: string[];
  backupIntervalHours: number;
  lastBackupAt: string;
}

export interface Sale {
  id: string;
  invoiceNumber: string;
  cashierName: string;
  subtotal: number;
  discountTotal: number;
  total: number;
  totalRefunded?: number;
  currency: string;
  currencySymbol: string;
  paymentMethod: string;
  customerName: string;
  status: string;
  createdAt: string;
}


export interface SaleLine {
  id: number;
  productId: number;
  productName: string;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  discountAmount: number;
  discountLevel: DiscountLevel;
}

export interface SaleDetails extends Sale {
  items: SaleLine[];
}

export interface Movement {
  id: number;
  productName: string;
  type: string;
  quantityDelta: number;
  reason: string;
  userName: string;
  createdAt: string;
}

export interface Dashboard {
  grossSales: number;
  discounts: number;
  netSales: number;
  costOfGoods: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  salesCount: number;
  itemsSold: number;
  lowStockCount: number;
  topProducts: Array<{name:string; quantity:number; revenue:number}>;
}

export interface StoreFlowAPI {
  bootstrap: () => Promise<{hasAdmin:boolean;version:string}>;
  setupAdmin: (input:{username:string;displayName:string;password:string}) => Promise<User>;
  login: (input:{username:string;password:string}) => Promise<User>;
  logout: () => Promise<void>;
  getCurrentUser: () => Promise<User|null>;
  getRememberedCredentials: () => Promise<{username:string;password:string}|null>;
  saveRememberedCredentials: (input:{username:string;password:string;remember:boolean}) => Promise<{saved:boolean}>;
  toggleFullscreen: () => Promise<boolean>;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  getSettings: () => Promise<StoreSettings>;
  setTheme: (theme:Theme) => Promise<Theme>;
  saveSettings: (settings:StoreSettings) => Promise<StoreSettings>;
  chooseDirectory: () => Promise<string|null>;
  chooseImage: () => Promise<string|null>;
  chooseProductImage: () => Promise<string|null>;
  runBackup: () => Promise<any>;
  restoreBackup: () => Promise<{success:boolean;message:string}>;
  listProducts: (query?:string) => Promise<Product[]>;
  scanProduct: (code:string) => Promise<Product|null>;
  createProduct: (input:ProductInput) => Promise<Product>;
  updateProduct: (id:number,input:ProductInput) => Promise<Product>;
  deleteProduct: (id:number) => Promise<void>;
  adjustStock: (input:{productId:number;delta:number;reason:string}) => Promise<void>;
  dashboard: (from:string,to:string) => Promise<Dashboard>;
  quoteSale: (input:{items:CartLine[]}) => Promise<{subtotal:number;discountTotal:number;total:number}>;
  createSale: (input:{items:CartLine[];paymentMethod:string;customerName?:string}) => Promise<Sale>;
  getSale: (id:string) => Promise<SaleDetails>;
  returnSaleItem: (input:{saleItemId:number;quantity:number;reason:string;}) => Promise<{success:boolean;refund:number;totalRefunded:number;netTotal:number}>;
  voidSale: (saleId:string,reason:string) => Promise<void>;
  listSales: () => Promise<Sale[]>;
  getMovements: () => Promise<Movement[]>;
  createExpense: (input:{title:string;amount:number}) => Promise<void>;
  listUsers: () => Promise<Array<User & {active:boolean}>>;
  createUser: (input:{username:string;displayName:string;password:string;role:Role}) => Promise<void>;
  setUserActive: (id:number,active:boolean) => Promise<void>;
  printInvoice: (html:string,paperSize:PaperSize) => Promise<{success:boolean;message:string}>;
}

declare global {
  interface Window { storeflow: StoreFlowAPI }
}
