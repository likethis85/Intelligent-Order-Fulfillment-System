// 模拟数据：商品卡（字段结构对应共创方案 v4 的商品卡四层架构）
// 真实环境来自 领猫(基础) / 聚水潭(实时) / 供应链系统(翻单) / BI(指标+放量+图片) 四层对接

export type RoleTag = '引流' | '利润' | '库存';
export type AiFlag = 'top' | 'extra' | 'avoid' | null;

export interface Product {
  id: string; // 款号（演示用小写，真实环境为 ME09FC016 这类编码）
  img: string;
  imgSource: 'BI' | '领猫' | '自传'; // 图片优先 BI，无则用领猫接口图；'自传' 用于主图位被用户自传图覆盖时显示徽标
  biOnly?: boolean; // BI 独有款（现有导出与选款界面使用）
  name: string;
  sub: string;
  colors: string[];
  price: string;
  priceNum: number;
  priceNote?: string; // 如"同价老款"
  mprice?: string;    // 马总直播价（仅马总场显示）
  stock: string[];
  stockMain: number;
  inTransit: number;
  restock?: string;
  fabric?: string;
  plannedQty: number; // 计划翻单放量（BI）
  orderedQty: number; // 已下单放量（BI）
  category: string;
  tempBand: string;
  priceBand: '低' | '中' | '高';
  costPrice?: number; // 领猫 SKU 成本（skcCostPrice / costPrice），优先于 BI bomCost
  skus?: Array<{
    skuCode: string;
    colorName: string;
    sizeName: string;
    isMainColor: boolean;
    costPrice: number;
  }>; // 领猫 SKU 维度信息，BI 无 SKC 时兜底用
  roles: RoleTag[];
  conversion: number;
  returnRate: number;
  newBuyer: number; // 新买家占比（款）
  netSales: number;
  ai: AiFlag;
  aiReason?: string;
  wave: string;
  sizeRange?: string; // 尺码范围，从 BI ETL 数据集的「尺码名称调整」聚合，按款号跨色汇总成 "S~XL"
  bomCost?: string; // BOM 成本，从 BI ETL 数据集的「bom商品成本」聚合（跨 SKC 取最大值），与 price 相除得到倍率
  // BI 商品全表数据(款式) a6169c0395f884ed6a3d64f2 的打标 / 分类字段
  tagValid?: string;       // 有效款打标：有效 / 无效
  tagReturnPostShip?: string; // 发货后退货率打标：高 / 其他
  tagReturn15d?: string;   // 15天退货率监控：监控 / 不监控
  tagSales30d?: string;    // 30天有无动销判定：30天有动销 / 30天无动销
  tagSoldOut?: string;     // 售罄率打标：高售罄 / 低销售 / 低售罄 / 高销售 / 其他
  tagGreenLight?: string;  // 是否绿灯款：是 / 否
  tagRedBlack?: string;    // 红黑榜：红榜 / 黑榜 / 其他
  season?: string;         // 季节(到款式)：夏/秋/冬/春/其他
  fit?: string;            // 版型：合体/宽松/廓形/修身/阔腿/小脚/直筒/紧身/喇叭/束脚口/直身/尺码数据缺失
  material?: string;       // 物料小类：羊毛/棉/醋酸/真丝/亚麻/涤纶/锦纶/粘纤/小香/羊绒/羊驼
  stockBand?: string;      // 款库存区间：100以下/100-200/200-500/500-1000/1000以上
  stockTurnover?: string;  // 款库存判定：无周转/周转>60天/周转30-60天/周转0-15天/周转15-30天
  launchDate?: string;     // 款上新时间（领猫侧无此字段，选款池筛选时回退到剩余库存 BI 卡片）
}

// 货值 = 售价 × 总放量（计划翻单放量 + 已下单放量）
// 找不到款号时返回空壳 product（id 用款号、其它字段默认值），避免调用方访问 .name/.img 时炸出白屏
const EMPTY_PRODUCT = (pid: string): Product => ({
  id: pid.toLowerCase(),
  img: '',
  imgSource: '领猫',
  name: pid.toUpperCase(),
  sub: '',
  colors: [],
  price: '',
  priceNum: 0,
  fabric: '',
  stock: [],
  stockMain: 0,
  inTransit: 0,
  plannedQty: 0,
  orderedQty: 0,
  category: '',
  tempBand: '',
  priceBand: '低',
  roles: [],
  conversion: 0,
  returnRate: 0,
  newBuyer: 0,
  netSales: 0,
  ai: null,
  wave: '',
});
export const byId = (pid: string): Product => PRODUCTS.find((p) => p.id === pid) ?? EMPTY_PRODUCT(pid);
export const totalQty = (p: Product) => p.plannedQty + p.orderedQty;
export const goodsValue = (p: Product) => p.priceNum * totalQty(p);

// ── 货盘结构：坑位 = Look（1~N 个款号，封面由人选） ──
export interface Look {
  id: string;
  pids: string[];
  cover: string | null; // 封面款号（null = 多图待确认主图）
  userImg?: string | null; // 用户自传的主图 URL（'/uploads/<uuid>.<ext>'），优先级高于 cover pid 的 Product.img；为空回退到 cover pid 的 Product.img
  restockShortNames?: Record<string, string>; // 翻单行前缀手动覆盖（pid → 短名，如 针织裤/开衫）；缺省时按产品名自动推导
}
export interface TraySection {
  id: string;
  label: string;
  visible: boolean;
  looks: Look[];
  isBackup?: boolean; // 备用区域：用于暂存已选但暂不播的坑位，渲染样式区分（灰色横条），面料/翻单覆盖随 pid 保留
}
export type TrayType = '马总直播货盘' | '店播直播货盘' | 'IP直播货盘' | '达人货盘' | '渠道货盘';
export type TrayTemplate = 'mazong' | 'normal' | 'talent';

export const TRAY_TYPES: TrayType[] = ['马总直播货盘', '店播直播货盘', 'IP直播货盘', '达人货盘', '渠道货盘'];

export interface NoRestockItem {
  skc: string; // SKC 编码（维度键）
  pid: string; // 款号
  color?: string; // 颜色（如 咖色）
  fabric?: string; // 面料名称（如 羊毛）
}

export interface Tray {
  restockShortNames?: Record<string, string>; // 兼容已有货盘级翻单简称
  id: string;
  name: string;
  date: string; // 货盘日期（创建时必填）
  type: TrayType;
  template: TrayTemplate;
  sections: TraySection[];
  viewPerm: string[]; // 查看权限
  editPerm: string[]; // 编辑权限
  createdAt: string;
  updatedAt?: string; // 最后修改时间（用于本地/云端合并时判断新旧）
  fabricOverrides?: Record<string, string>; // 面料信息覆盖（pid → fabric 文字），per-tray 优先于 product.fabric；未设置时不展示 BI 默认面料
  fabricNotes?: Record<string, string>; // 面料注脚（pid → 备注文字），追加在 BI / fabricOverrides 文本末尾；为空则不显示
  restockOverrides?: Record<string, string>; // 翻单周期覆盖（pid → restock 文字），per-tray 优先于 product.restock；从 sales.html 同步回来
  plannedRestockItems?: Array<{ pdt: string; skc: string; color?: string; pieces: number; days: number }>; // 计划翻单量明细（每批次一项），从 sales.html「确认翻单信息」同步回来；导出 Excel 「计划翻单量」列按此输出（对齐钉钉表结构）
  sampleRestockItems?: Array<{ pdt: string; skc: string; color?: string; pieces: number; days: number; _source: 'sample' }>; // 样衣阶段翻单（驼色等未转大货色），数据源 = 主仓 /api/samples/materials；与 plannedRestockItems 分桶存储，UI 加「样衣」角标
  plannedRestockAllSkcs?: Record<string, string[]>; // 计划翻单量涉及的 SKC 列表（pid → [skc, ...]），含已清零的；导出时区分「已填」「未填」
  noRestockSkcs?: string[]; // 兼容旧数据：标记为「无面料不翻单」的 SKC 编码
  noRestockItems?: NoRestockItem[]; // SKC 维度无面料不翻单标记（含颜色/面料信息）
  priceOverrides?: Record<string, string>; // 售价手动编辑（pid → 文案，如 "999" / "999/1199"），per-tray 优先于 BI / 领猫价；清空 = 清除 override
  priceSuffixOverrides?: Record<string, string>; // 售价注脚手动编辑（pid → 后缀文案，如 "券后" / "秒杀" / "套装价"），渲染在售价后面；清空 = 清除 override
  mpriceOverrides?: Record<string, string>; // 马总直播价手动编辑（仅马总场显示），per-tray 优先于 BI mprice；清空 = 清除 override
  codeSuffixOverrides?: Record<string, string>; // 款号注脚手动编辑（pid → 后缀文案，如 "黑色" / "黑色/咖色"），渲染在款号后面；清空 = 清除 override
  colorOverrideByLook?: Record<string, string>; // 颜色文案手动覆盖（lookId → 文案，如 "棕色 / 灰"），per-tray 优先于 pid.colors union；清空 = 清除 override
  costOverrides?: Record<string, string>; // BOM 成本手动编辑（pid → "123.45"），per-tray 优先于 BI bom商品成本；清空 = 清除 override
  mcostOverrides?: Record<string, string>; // 马总 BOM 成本手动编辑（仅马总场显示），per-tray 优先；清空 = 清除 override
  sizeRangeOverrides?: Record<string, string>; // 尺码范围手动编辑（pid → "S~XL" / "均码"），per-tray 优先于 BI ETL 聚合的 sizeRange；清空 = 清除 override
  // 直播排品（SequencePage）专用
  startTime?: string; // 'HH:MM' 直播开始时间，默认 '19:00'
  seqDisplayMode?: 'list' | 'timeline'; // 排品页显示模式，默认 'list'
  seqOrders?: Record<string, SeqEntry[]>; // 按 tray.id 索引的排品顺序
}

// 排品页（SequencePage）单个上场坑位
export interface SeqEntry {
  key: string;
  lookId: string;
  sectionLabel: string;
  seg?: string;   // 节奏段：开场引流 / 承接 / 利润峰值 / 库存释放 / 返场
  rerun?: boolean;
}

export const PERM_ROLES = ['马总', '商品', '运营', '主播团队', '达人商务', '渠道运营'];

const P = (
  id: string, name: string, sub: string, colors: string[], price: string, priceNum: number,
  stock: string[], stockMain: number, inTransit: number,
  plannedQty: number, orderedQty: number,
  category: string, tempBand: string, priceBand: '低' | '中' | '高', roles: RoleTag[],
  conversion: number, returnRate: number, newBuyer: number, netSales: number,
  wave: string,
  extra?: Partial<Product>,
): Product => ({
  id, img: `products/${id}.png`, imgSource: (id.charCodeAt(1) % 3 === 0 ? '领猫' : 'BI') as 'BI' | '领猫',
  name, sub, colors, price, priceNum, stock, stockMain, inTransit,
  plannedQty, orderedQty, category, tempBand, priceBand, roles,
  conversion, returnRate, newBuyer, netSales, wave,
  ai: extra?.ai ?? null, aiReason: extra?.aiReason,
  restock: extra?.restock, fabric: extra?.fabric,
  priceNote: extra?.priceNote, mprice: extra?.mprice,
});

export const PRODUCTS: Product[] = [
  // ── 主推A ──
  P('a1', '橡果套2.0', '西装+西裤套装', ['黑色', '灰色', '焦糖色'], '1599/999', 1599, ['焦糖西装60，10/18', '裤常规60 加长20，10/6'], 120, 0, 350, 260, '套装', '10~20°C', '高', [], 0.062, 0.31, 0.28, 860, '9月2波段', { priceNote: '同价老款', restock: '黑色257套/35天，其他色无面料', fabric: '黑色700米现货面料厂；卡其棕500米10/30；深灰定制定染60天；里料定染10天' }),
  P('a2', '鳄鱼嘴皮鞋', '经典黑', ['经典黑'], '780', 780, ['经典黑现货120'], 120, 0, 500, 250, '鞋靴', '全季', '中', ['引流'], 0.081, 0.18, 0.41, 2100, '常青款', { restock: '500双/25天', ai: 'top', aiReason: '鞋靴类转化率 TOP1，现货充足，适合开场引流' }),
  P('a3', '泡芙蕾 单排扣双面呢/A字短半裙', '套装', ['黑色', '灰绿色'], '1499/799', 1499, ['外套10/14：黑占单350在途190 灰占单320在途140', '半裙10/14：黑占单310在途145 灰占单160在途60'], 0, 1085, 400, 367, '套装', '5~15°C', '高', [], 0.048, 0.36, 0.22, 1420, '9月2波段', { restock: '各色200套/25天；各色300套/35天', fabric: '黑色1105米面料仓；灰色1345米面料仓', ai: 'top', aiReason: '与你3月卖爆的「学院套装」画像相似度 87%，占单数据强劲' }),
  P('a4', '拉链高筒皮靴', '黑色', ['黑色'], '1480', 1480, ['在途110，9/30'], 0, 110, 300, 200, '鞋靴', '0~15°C', '高', ['利润'], 0.055, 0.22, 0.19, 640, '9月2波段', { restock: '300双/25天' }),
  P('a5', '短款双面呢翻领外套', '马总 1580', ['白色', '咖色', '黑色'], '1680', 1680, ['白占单180在途100', '咖占单210在途70', '黑占单150无在途 9/30'], 0, 320, 1200, 916, '大衣', '0~12°C', '高', [], 0.057, 0.29, 0.31, 1880, '9月2波段', { restock: '米白121件/25天；黑色200件/25天、300件/35天；棕色290件/25天', fabric: '米白151米面料仓；黑色1105米面料仓；棕色367米面料仓' }),
  P('a6', '小领大衣2.0 欧德三粒扣短大衣', '', ['棕色', '灰色'], '1999', 1999, ['棕色占单110，在途120', '灰色占单320，在途230，10/10'], 0, 350, 700, 550, '大衣', '0~12°C', '高', ['利润'], 0.051, 0.27, 0.24, 1150, '9月2波段', { restock: '棕色368件/25天；灰色280件/25天', fabric: '褐花色670米面料仓；高级灰510米面料仓' }),
  P('a7', '蘑菇大衣2.0 连帽拉链短款大衣', '1.0：藏青/米/灰/棕 2.0：灰/米', ['藏青', '米', '灰', '棕'], '灰/米1880 棕1580', 1880, ['米占单450在途300', '灰占单340在途170，9/30 10/7', '1.0棕色100，9/30'], 100, 470, 400, 350, '大衣', '0~12°C', '高', [], 0.049, 0.33, 0.26, 1320, '9月2波段', { mprice: '1580', restock: '2.0各色200件/30天；1.0各色100件/30天；1.0藏青无面料', fabric: 'ME15FF037流沙色1036米面料仓；深灰夹花354米面料仓；ME58BF001米白562米面料仓；经典兰157米；深烟灰162米；棕色现货524米面料厂' }),
  P('a8', '高铁夹克 羊驼短毛夹克', '马总 1999', ['藏青', '灰色'], '2680', 2680, ['藏青在途100，9/30', '灰色在途70，10/13'], 0, 170, 300, 259, '夹克', '5~15°C', '高', ['利润'], 0.044, 0.25, 0.18, 520, '9月2波段', { mprice: '1999', restock: '各色100套/25天；各色200套/35天', fabric: '藏青731米面料仓；中灰793米面料仓；藏青里料现货；灰色里料定染10天' }),
  // ── 主推B ──
  P('b1', '口袋大衣', '', ['米灰色', '黑色'], '3999', 3999, ['黑占单360在途160', '米灰占单200在途120，9/30 10/5'], 0, 280, 700, 500, '大衣', '0~10°C', '高', ['利润'], 0.042, 0.24, 0.15, 980, '9月2波段', { restock: '黑色200件/35天；灰色200件/35天', fabric: '黑色661米面料仓；米灰780米面料仓；里料等翻单定染10天', ai: 'top', aiReason: '零售/成本比 3.1，全场毛利最高款，建议峰值时段释放' }),
  P('b2', '羊绒插肩袖衫', '同价老款', ['米驼色', '深灰色', '深藏青', '浅粉色'], '1380', 1380, ['浅粉50，10/13', '米驼现货41 深灰现货44 藏青现货44'], 129, 50, 1400, 1100, '针织', '5~18°C', '高', [], 0.058, 0.21, 0.2, 1560, '9月1波段', { priceNote: '同价老款', restock: '各色300件/25天；粉色无' }),
  P('b3', '小绞花 绞花圆领针织套衫', '', ['糖浆驼', '柏林蓝', '夹花灰'], '599', 599, ['驼占单1100在途700', '蓝占单750在途560', '灰占单620在途430，10/7 10/10'], 0, 1690, 1300, 1100, '针织', '10~20°C', '中', ['引流'], 0.072, 0.26, 0.38, 3200, '9月1波段', { restock: '25天/各色400件', ai: 'top', aiReason: '净销量 3200 件 + 转化率 7.2%，引流款标杆' }),
  P('b4', '珠片丝羊绒深V领套衫/开衫', '', ['柔雾灰', '琉光白', '午夜蓝'], '799/799', 799, ['开衫10/6：白在途100 灰现货30在途100 蓝占单130在途110', '套衫9/30：白占单300在途110 灰占单100在途20 蓝占单400在途180'], 30, 950, 800, 702, '针织', '10~20°C', '中', [], 0.053, 0.28, 0.25, 1740, '9月1波段', { restock: '各色300套/25天' }),
  P('b5', '菱格针织套衫/背心', '', ['可可棕', '雾霾灰'], '399/699', 699, ['背心10/2：棕占单550在途50 灰占单640在途320', '开衫10/2：棕占单600在途400 灰占单1000在途550'], 0, 1320, 600, 492, '针织', '10~20°C', '中', [], 0.061, 0.3, 0.29, 2280, '9月1波段', { restock: '各色300套/20天' }),
  P('b6', '圆领条纹T恤', '', ['黑白灰条', '咖色条', '藏青条'], '399', 399, ['咖现货30', '藏青现货20在途100，10/15', '黑白占单135在途100，10/15'], 50, 200, 1100, 900, 'T恤', '15~25°C', '低', ['引流'], 0.068, 0.24, 0.45, 2600, '9月1波段', { restock: '黑白灰540件/20天；藏青条210件/20天；咖色条430件/20天', fabric: '面料现货：黑白灰条400米/藏青条160米/咖色条320米；翻单30天' }),
  P('b7', '佰搭伴侣 勺领/圆领', '', ['奶白色', '浅银灰', '深岩灰', '经典黑', '卡其色'], '399', 399, ['圆领全现货：白40 黑30 浅银灰120 深岩灰59 卡其70', '勺领：浅银灰现货24 深岩灰现货40'], 383, 0, 1100, 900, 'T恤', '15~25°C', '低', ['引流', '库存'], 0.066, 0.22, 0.43, 2900, '常青款', { restock: '20天不限量', ai: 'top', aiReason: '现货 383 件全码全色、翻单不限量，承接流量最稳' }),
  P('b8', '遛弯套 羊绒连帽开衫/裤', '套装', ['碳墨黑', '大象灰', '沙丘驼'], '1680/1880', 1880, ['各色20套，9/25'], 60, 0, 800, 620, '套装', '5~15°C', '高', ['利润'], 0.047, 0.23, 0.21, 890, '9月2波段', { restock: '25天/各300套' }),
  // ── 现货 ──
  P('c1', '坑条拉链背心', '', ['藏青', '白色'], '259', 259, ['现货：白色106 藏青250'], 356, 0, 400, 314, '背心', '15~25°C', '低', ['库存', '引流'], 0.074, 0.2, 0.4, 1800, '常青款', { ai: 'top', aiReason: '主仓 356 件无在途、低价高转化，清仓与引流两用' }),
  P('c2', '休闲八分卫裤', '', ['白色', '花灰色', '黑色'], '399', 399, ['现货：白色127 黑色27 花灰61'], 215, 0, 300, 200, '裤装', '15~25°C', '低', ['库存'], 0.059, 0.25, 0.33, 1250, '常青款'),
  P('c3', '001折脚边牛仔裤', '', ['蓝色'], '699', 699, ['现货76'], 76, 0, 100, 80, '裤装', '全季', '中', [], 0.052, 0.27, 0.3, 940, '常青款'),
  P('c4', '立领菱形格羽绒服', '', ['白色', '黑色'], '2580', 2580, ['5天内发货：白色50 黑120'], 170, 0, 280, 215, '羽绒', '<5°C', '高', ['利润'], 0.039, 0.26, 0.16, 430, '10月1波段', { ai: 'avoid', aiReason: '适穿温度 <5°C，目标城市未来 7 天均温 14°C，天气不匹配' }),
  P('c5', '绞花门襟扣针织衫', '', ['岩绿点彩'], '3980', 3980, ['现货：岩绿53'], 53, 0, 90, 69, '针织', '5~15°C', '高', ['利润'], 0.036, 0.19, 0.12, 310, '9月1波段', { ai: 'avoid', aiReason: '现货仅 53 件且无翻单，深度撑不起场次，建议不进大场' }),
  P('c6', '自由女神多穿大衣', '', ['黑色', '米色', '深灰', '咖色'], '2580', 2580, ['现货：咖20 深灰15 黑65 米72'], 172, 0, 300, 240, '大衣', '0~12°C', '高', [], 0.045, 0.28, 0.2, 720, '9月2波段', { ai: 'extra', aiReason: '不在本次筛选品类内，但与已选「口袋大衣」人群重合度仅 31%，可互补拉新' }),
  P('c7', '钟型小香', '', ['黑底蓝紫条'], '1580', 1580, ['现货122'], 122, 0, 200, 166, '外套', '10~18°C', '高', [], 0.041, 0.32, 0.17, 480, '9月1波段'),
  P('c8', 'Marisa戗驳领直身西装/手工腰头阔腿裤', '', ['蓝色'], '2980/1580', 2980, ['现货：西装100 西裤60'], 160, 0, 150, 114, '西装', '10~20°C', '高', ['利润'], 0.038, 0.29, 0.14, 390, '9月2波段'),
  // ── 搭配款 ──
  P('d1', '油墨感档案T恤', '', ['白色', '黑色'], '299', 299, ['白色210 黑色62'], 272, 0, 300, 268, 'T恤', '18~28°C', '低', ['引流', '库存'], 0.071, 0.19, 0.47, 2400, '常青款'),
  P('d2', '肩部拼接短袖/长袖', '', ['棕色', '米色', '藏青'], '399/399', 399, ['T棕81 米25 藏青122', '长袖棕37 米47 藏青219'], 531, 0, 650, 550, 'T恤', '15~25°C', '低', ['库存'], 0.063, 0.23, 0.36, 1950, '9月1波段'),
  P('d3', '折纸衬衫', '', ['粉色', '白色'], '599', 599, ['各色500/25天'], 0, 500, 500, 500, '衬衫', '15~25°C', '中', [], 0.054, 0.25, 0.27, 1100, '9月1波段'),
  P('d4', '针刺假两件视错针织衫', '', ['雾黑咖', '浅花灰'], '880', 880, ['雾黑咖100 浅花灰50，10/10'], 150, 0, 160, 140, '针织', '10~20°C', '中', [], 0.05, 0.27, 0.24, 680, '9月2波段'),
  P('d5', '暗纹合体衬衫/直筒裤', '马总 999 通价', ['咖色', '深灰色'], '1280/980', 1280, ['深灰92套/25天', '咖色无面料不翻单'], 92, 0, 180, 132, '套装', '10~20°C', '高', [], 0.043, 0.3, 0.18, 450, '9月2波段'),
  P('d6', '松紧腰分割阔腿皮裤', '', ['黑色', '咖色'], '580', 580, ['咖色现货80', '黑色预售25天'], 80, 0, 120, 80, '裤装', '10~20°C', '中', [], 0.056, 0.31, 0.28, 760, '9月2波段'),
  P('d7', '千鸟格八分西裤', '', ['灰棕千鸟', '深灰千鸟'], '880', 880, ['灰棕100 深灰50，10/5'], 150, 0, 160, 140, '裤装', '10~20°C', '中', [], 0.049, 0.28, 0.23, 590, '9月2波段'),
  P('d8', '纤纤裤', '', ['质感黑', '银灰', '西梅紫'], '180', 180, ['质感黑101 银灰45 西梅紫46'], 192, 0, 220, 180, '裤装', '15~28°C', '低', ['引流'], 0.077, 0.17, 0.52, 2750, '常青款', { ai: 'top', aiReason: '拉新率 52% 全场最高，新客首选引流款' }),
];

// ── 画像标签（数据来自后端 /api/profiles，真实 BI；维度按平台可得性动态渲染） ──
export const AGE_LABELS = ['18-24岁', '25-30岁', '31-35岁', '36-40岁', '41-50岁', '50岁及以上'];
export const CROWD_LABELS = ['精致妈妈', '小镇青年', '小镇中老年', '资深中产', '都市银发', '都市蓝领', '新锐白领', 'GenZ'];
export const STAGE_LABELS = ['孕期', '单身', '恋爱', '已育'];

// ── 套装/搭配关系：一个 Look 对应多个款号时，推荐可组合的款 ──
export const MATCH_MAP: Record<string, string[]> = {
  a1: ['d3', 'a2'],
  a3: ['b5', 'd3'],
  a5: ['d4', 'd6'],
  a6: ['b3', 'd7'],
  a8: ['d8', 'b6'],
  b1: ['b7', 'c3'],
  b2: ['c2', 'd8'],
  b4: ['c3', 'd1'],
  b6: ['c3', 'd6'],
  b8: ['d2', 'a2'],
  c8: ['d1', 'd7'],
  c6: ['b7', 'd6'],
  d5: ['a2', 'b6'],
};
export function matchCandidates(pid: string): string[] {
  if (MATCH_MAP[pid]) return MATCH_MAP[pid];
  const p = PRODUCTS.find((x) => x.id === pid);
  if (!p) return []; // BI 独有款号不在本地 PRODUCTS，避免访问 undefined.tempBand 抛错
  return PRODUCTS.filter((x) => x.id !== pid && x.tempBand === p.tempBand).slice(0, 3).map((x) => x.id);
}
