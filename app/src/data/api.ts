import type { Product } from './products';
import { API_BASE, authenticatedFetch } from '@/lib/api-client';

// 直连后端 3737（绕过 Vite 代理，Vite 代理对 12MB+ 大响应会缓冲卡住）
// 主机名跟随前端页面来源：本机打开 = localhost，局域网打开 = 192.168.x.x，都能通
const BASE = API_BASE;
const PRODUCTS_CACHE_KEY = 'marius:productsCache:v1';

// 默认 30s 超时（直连后端，不再走 Vite 代理，速度正常）
const DEFAULT_TIMEOUT_MS = 30000;

async function jsonFetch<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // cache: 'no-store' 强制绕过浏览器 HTTP 缓存拿到后端最新响应
    // （后端没设 Cache-Control，跨域 + 大响应会被浏览器启发式缓存成旧版，
    //  导致货盘里某些款号的 stock / bomCost 拿不到刚同步的新值）
    const res = await authenticatedFetch(BASE + path, { ...init, cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        if (body?.message) msg = body.message;
        else if (body?.error) msg = body.error;
      } catch {
        // ignore body parse errors
      }
      // 带上状态码，调用方据此区分 409 冲突这类可恢复的错误
      const err = new Error(msg) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`请求超时（${timeoutMs / 1000}s），请检查后端是否响应`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiFilters {
  categories: string[];
  waves: string[];
  tempBands: string[];
  priceBands: string[];
  roles: string[];
  launchYears?: number[];
}

export interface SyncResult {
  ok: boolean;
  kind?: string;
  source?: string;
  count?: number;
  message: string;
  syncedAt: string;
}

// 前端 localStorage 缓存：stale-while-revalidate — 立刻显示上次 + 后台拉新
export interface CachedProducts {
  updatedAt: string; // ISO
  source: string;
  items: Product[];
}

export function readProductsCache(): CachedProducts | null {
  try {
    const s = localStorage.getItem(PRODUCTS_CACHE_KEY);
    if (s) {
      const parsed = JSON.parse(s);
      if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
        return parsed as CachedProducts;
      }
    }
  } catch {
    // quota / parse / private mode 都按空处理
  }
  return null;
}

function writeProductsCache(payload: CachedProducts) {
  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // quota exceeded: 静默丢弃
  }
}

// GET /api/products → 返回 items 数组；同时写回 localStorage
// 后端挂掉/超时降级返回上次缓存
export async function fetchProducts({ force = false } = {}): Promise<Product[]> {
  const url = force ? '/products?fresh=true' : '/products';
  const ctrl = new AbortController();
  // 冷启动重拉领猫+BI 可能超过 30s，给 90s；命中缓存秒返不受影响
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await authenticatedFetch(BASE + url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      items: Product[];
      source?: string;
      updatedAt?: string;
    };
    const items = data.items ?? [];
    if (items.length > 0) {
      writeProductsCache({
        updatedAt: data.updatedAt || new Date().toISOString(),
        source: data.source || 'unknown',
        items,
      });
    }
    return items;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      const cached = readProductsCache();
      if (cached) return cached.items;
      throw new Error('请求超时（90s，后端冷启动重拉较慢），请重试或稍后再试');
    }
    const cached = readProductsCache();
    if (cached) return cached.items;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/products/:id → 单个 Product
export function fetchProduct(id: string): Promise<Product> {
  return jsonFetch<Product>(`/products/${encodeURIComponent(id)}`);
}

// GET /api/products/meta/filters → 筛选维度
export function fetchFilters(): Promise<ApiFilters> {
  return jsonFetch<ApiFilters>('/products/meta/filters');
}

// GET /api/samples/by-codes?codes=... → 样衣阶段精确查（兜底款号搜索）
// 返回 items 形状与 Product 兼容（后端 mapSample 投影过），items[].stage === 'sample'
export interface SampleByCodesResult {
  requested: number;
  count: number;
  items: Product[];
  missing: string[];
}
export function fetchSamplesByCodes(codes: string[]): Promise<SampleByCodesResult> {
  const q = encodeURIComponent(codes.join(','));
  return jsonFetch<SampleByCodesResult>(`/samples/by-codes?codes=${q}`);
}

// 样衣 BOM 物料：每个 SKC 聚合面料/里料/供应商简称
// 来自 /api/samples/materials?codes=...，后端带 1h 缓存
export interface SampleMaterialRow {
  smCode: string;        // 款号
  skc: string;           // SKC（SKU 去尾位）
  colorName: string;     // 成衣颜色
  spColorName: string;   // 物料规格名（sp 段，如 "9064#"）
  fabricMt: string;      // 面料（多个用 " / " 拼接）
  liningMt: string;      // 里料（多个用 " / " 拼接）
  supplierShort: string; // 供应商简称（主数据 supplierName）
  mtSpecName: string;    // 完整规格名 `[色号]颜色-sp色号;`
  useAmt: number;        // 单件用量累计
}
export interface SampleMaterialsResult {
  updatedAt: string;
  count: number;
  items: SampleMaterialRow[];
  source?: string;
}
export function fetchSampleMaterials(codes: string[]): Promise<SampleMaterialsResult> {
  const q = encodeURIComponent(codes.join(','));
  // 领猫样衣 BOM 按 7 天窗口分页拉；货盘页一次带全部款号，冷启动可能 2-3 分钟；后续命中缓存秒回
  return jsonFetch<SampleMaterialsResult>(`/samples/materials?codes=${q}`, undefined, 240_000);
}

// 翻单最大单量计算：每卷面料米数（面料仓+在途+工厂现货+可订货 全加）÷ 单件用量 ÷ 1.05
// 来自 /api/samples/calc-restock-stock?skcs=...，后端转发 fabric_Q 面料表
export interface RestockStockSku {
  skc: string;
  useAmt: number;
  maxPcs: number;
  stockAt: number;       // 面料仓米数
  factorySpot: number;   // 工厂现货米数
  inTransit: number;     // 在途米数
  orderable: number;     // 可订货米数
}
export interface RestockStockFabric {
  mtCode: string;
  mtName: string | null;
  mtSpecName: string | null;
  supplierName: string | null;
  M: number;             // 该卷面料总米数（4 来源全加）
  skcs: RestockStockSku[];
}
export interface RestockStockResult {
  updatedAt: string;
  count: number;
  items: RestockStockFabric[];
  source?: string;
}
export function fetchRestockStock(params: { pids?: string[]; skcs?: string[] } = {}): Promise<RestockStockResult> {
  const q = new URLSearchParams();
  if (params.pids?.length) q.set('pids', params.pids.join(','));
  if (params.skcs?.length) q.set('skcs', params.skcs.join(','));
  return jsonFetch<RestockStockResult>(`/samples/calc-restock-stock?${q.toString()}`, undefined, 30_000);
}

export interface SalesSummary {
  date: string;
  daily: Record<string, number>;
  cumulative: Record<string, number>;
  updatedAt?: string;
}
// GET /api/sales/summary?date=YYYY-MM-DD&pids=a,b,c
// 一次拿当日 + 累计销量
export function fetchSalesSummary(date: string, pids: string[]): Promise<SalesSummary> {
  if (pids.length === 0) return Promise.resolve({ date, daily: {}, cumulative: {} });
  const q = new URLSearchParams({ date, pids: pids.join(',') });
  return jsonFetch<SalesSummary>(`/sales/summary?${q.toString()}`);
}

// POST /api/sync → 重新拉数据（首次冷启可能 >30s，给 180s 超时）
export function syncProducts(kind: '商品' | '库存' = '商品'): Promise<SyncResult> {
  return jsonFetch<SyncResult>('/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
  }, 180_000);
}

// POST /api/sync/hengji → 运行 scripts/dingtalk-sync-cost.mjs，同步钉钉核价表（成本 + 销售价）
// 同步过程：非 headless Chrome 打开核价表 + 读剪贴板，约 30-60s，给 180s 超时
export function syncHengjiCost(): Promise<SyncResult> {
  return jsonFetch<SyncResult>('/sync/hengji', { method: 'POST' }, 180_000);
}

// GET /api/sync/hengji/status → 检查钉钉文档登录态是否还有效（headless，约 6-10s）
export interface HengjiStatus {
  ok: boolean;
  loggedIn?: boolean;
  reason?: 'no_credentials' | 'redirected_to_login' | 'sheets_not_found' | string;
  finalUrl?: string;
  sheets?: number;
  error?: string;
}
export function fetchHengjiStatus(): Promise<HengjiStatus> {
  return jsonFetch<HengjiStatus>('/sync/hengji/status', undefined, 30_000);
}

// ── 排品角色判定规则（配置后台；服务端持久化在 server/data/role-rules.json） ──
export interface RoleRules {
  // 引流 = 价格带 ∈ priceBands，或转化率 ≥ minConversion（%）
  traffic: { minConversion: number; priceBands: string[] };
  // 利润 = 价格带 ∈ priceBands；excludeSlow = true 时滞销款不标利润（归库存）
  profit: { priceBands: string[]; excludeSlow: boolean };
  // 库存 = 滞销：requireBoth 控制「周转慢」与「售罄率低」是同时满足还是任一满足；noSales30d = 「30天无动销」直接判滞销
  stock: { slowTurnover: string[]; lowSellTags: string[]; requireBoth: boolean; noSales30d: boolean };
}

export function fetchRoleRules(): Promise<{ rules: RoleRules; source: string }> {
  return jsonFetch<{ rules: RoleRules; source: string }>('/config/role-rules');
}

export function saveRoleRules(rules: RoleRules): Promise<{ rules: RoleRules }> {
  return jsonFetch<{ rules: RoleRules }>('/config/role-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

// ── 场景规则库（配置后台；服务端持久化在 server/data/scene-rules.json） ──
export interface SceneRule {
  key: string; // 稳定标识，编辑名称不影响匹配
  name: string;
  params: { label: string; value: string }[];
  action: string; // 命中后的动作文案
  enabled: boolean;
}

export function fetchSceneRules(): Promise<{ rules: SceneRule[]; source: string }> {
  return jsonFetch<{ rules: SceneRule[]; source: string }>('/config/scene-rules');
}

export function saveSceneRules(rules: SceneRule[]): Promise<{ rules: SceneRule[] }> {
  return jsonFetch<{ rules: SceneRule[] }>('/config/scene-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

// ── AI 选款策略口径（默认 + 持久化覆盖） ──
export interface StrategyRules {
  defaults: { minStock: number; minConv: number; maxReturn: number; minNewBuyer: number };
  hints: Record<string, { roles?: string[]; bands?: string[]; temps?: string[]; noTransit?: boolean; minStock?: number; minConv?: number; maxReturn?: number; minNewBuyer?: number; scenes?: string[]; cats?: string[] }>;
  weatherThresholds: { humidityHigh: number; windStrong: number };
  extraSystemPrompt: string;
}
export function fetchStrategyRules(): Promise<{ rules: StrategyRules; source: string }> {
  return jsonFetch<{ rules: StrategyRules; source: string }>('/config/strategy-rules');
}
export function saveStrategyRules(rules: StrategyRules): Promise<{ rules: StrategyRules }> {
  return jsonFetch<{ rules: StrategyRules }>('/config/strategy-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

// ── 剩余库存推荐（BI 卡片 j93dcdbbe10994fc1a708939） ──
export interface RemainingSku {
  skc: string;
  color: string;
  img: string;
  season: string;
  orderQty: number;
  totalStock: number;
  mainStock: number;
  returnStock: number;
  ontheway: number;
  returnOnway: number;
  virtualStock: number;
  orderBook: number;
  estimate: number;
}
export interface RemainingGroup {
  styleCode: string;
  productName: string;
  alias: string;
  category: string;
  launchDate: string;
  retailPrice: number;
  mainImg: string;
  skus: RemainingSku[];
  totals: {
    orderQty: number;
    totalStock: number;
    mainStock: number;
    returnStock: number;
    ontheway: number;
    returnOnway: number;
    virtualStock: number;
    orderBook: number;
    estimate: number;
  };
  tags: ('尽快推' | '补单到仓后推' | '退货到仓后推')[];
  remark: string;
  purchaseEtaDate?: string;
  purchaseEtaLeadDays?: number;
  netSalesQty?: number;
  netSalesAmount?: number;
  salesQty?: number;
  salesAmount?: number;
  returnQty?: number;
  last30dNetSales?: number;
  last7dNetSales?: number;
}
export function fetchRemainingInventory(params: { tag?: string; search?: string; sort?: string; limit?: number } = {}): Promise<{ items: RemainingGroup[]; count: number }> {
  const q = new URLSearchParams();
  if (params.tag) q.set('tag', params.tag);
  if (params.search) q.set('search', params.search);
  if (params.sort) q.set('sort', params.sort);
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  // 冷启动（磁盘缓存过期）要按年份分区重拉 58895 行，约 2 分钟；给 240s
  return jsonFetch(`/remaining-inventory${qs ? `?${qs}` : ''}`, undefined, 240_000);
}
export function fetchLaunchYears(): Promise<{ years: number[] }> {
  return jsonFetch('/remaining-inventory/launch-years');
}
export interface WeatherTempRule { temp_range: string; categories: string[] }
export interface WeatherSolarRule { terms: string[]; categories: string[]; description: string }
export interface WeatherRules {
  temperature_rules: WeatherTempRule[];
  rain_overlay_categories: string[];
  solar_term_overlays: WeatherSolarRule[];
}
export function fetchWeatherRules(): Promise<{ rules: WeatherRules; source: string }> {
  return jsonFetch<{ rules: WeatherRules; source: string }>('/config/weather-rules');
}
export function saveWeatherRules(rules: WeatherRules): Promise<{ rules: WeatherRules }> {
  return jsonFetch<{ rules: WeatherRules }>('/config/weather-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
}

// ── AI 选款策略 LLM 端点 ──
export interface AiStrategyPatch {
  cats?: string[];
  bands?: string[];
  temps?: string[];
  roles?: string[];
  scenes?: string[];
  minStock?: number;
  minConv?: number;
  maxReturn?: number;
  minNewBuyer?: number;
  noTransit?: boolean;
}
export function postAiStrategy(query: string, currentFilters: unknown, candidates: Product[]): Promise<{ text: string; patch: AiStrategyPatch | null; model?: string }> {
  return jsonFetch('/ai/strategy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, currentFilters, candidates }),
  });
}

// ── 通用 localStorage 缓存（stale-while-revalidate）：先显上次结果，后台拉新后回写 ──
// 画像卡片等「打开一次拉一次」的页面统一走这个
export function readJsonCache<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    if (s) return JSON.parse(s) as T;
  } catch {
    // quota / parse / private mode 都按空处理
  }
  return null;
}

export function writeJsonCache(key: string, payload: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // quota exceeded: 静默丢弃
  }
}

// ── 人群画像 + 主播热卖榜（真实 BI 数据；后端 /api/profiles） ──
export interface AudienceProfile {
  ages: number[] | null; // 六桶：18-24 / 25-30 / 31-35 / 36-40 / 41-50 / 50+（淘宝 25-29 等分箱已归并）
  female: number | null; // 女性占比 %
  crowds: number[] | null; // 8大人群，顺序同 CROWD_LABELS（仅抖音有）
  stages: number[] | null; // 孕期/单身/恋爱/已育（仅抖音有）
  provinces: { name: string; value: number }[] | null; // 常驻省份 Top10（仅抖音有）
  interests: { name: string; value: number }[] | null; // 兴趣爱好 Top10（仅淘宝有）
  customerType: { name: string; value: number }[] | null; // 新/老客户（仅淘宝有）
  payers: number;
  store: string;
  platform: string;
  month?: string; // 店铺画像：数据所属月份
}

export type Platform = '淘宝' | '抖音';

export function fetchSkuProfile(code: string, platform: Platform): Promise<{ profile: AudienceProfile | null; availablePlatforms: Platform[] }> {
  return jsonFetch(`/profiles/sku/${encodeURIComponent(code)}?platform=${encodeURIComponent(platform)}`);
}

// 有单款画像数据的款号清单（空搜索默认选项用）
export function fetchSkuProfileCodes(): Promise<{ codes: string[] }> {
  return jsonFetch('/profiles/sku-codes');
}

export function fetchStoreProfiles(): Promise<{ stores: { store: string; month: string; months: number[] }[] }> {
  return jsonFetch('/profiles/stores');
}

export function fetchStoreProfile(
  store: string,
  { scope = 'month', month = '' }: { scope?: 'month' | 'all'; month?: string } = {},
): Promise<{ profile: AudienceProfile | null }> {
  const q = new URLSearchParams();
  if (scope === 'all') q.set('scope', 'all');
  else if (month) q.set('month', month);
  const qs = q.toString();
  return jsonFetch(`/profiles/store/${encodeURIComponent(store)}${qs ? `?${qs}` : ''}`);
}

export interface AnchorInfo {
  name: string;
  totalQty: number;
}

export function fetchAnchors(): Promise<{ anchors: AnchorInfo[] }> {
  return jsonFetch('/profiles/anchors');
}

export function fetchAnchorHot(name: string, topN = 20): Promise<{ hot: { pdtCode: string; qty: number; ratio: number }[] }> {
  return jsonFetch(`/profiles/anchors/hot?name=${encodeURIComponent(name)}&topN=${topN}`);
}

// 主播 TopN 热卖款的受众画像加权聚合（淘宝 + 抖音合并）
export function fetchAnchorAudience(
  name: string,
  topN = 20,
): Promise<{ name: string; topN: number; profile: AudienceProfile | null; used: { pdtCode: string; qty: number }[]; missing: string[]; updatedAt: string }> {
  return jsonFetch(`/profiles/anchors/audience?name=${encodeURIComponent(name)}&topN=${topN}`);
}

// ── 天气（Open-Meteo 免费 API；服务端 1h 缓存；?fresh 强制重拉） ──
export interface WeatherDay {
  date: string;
  week: string;
  tempMax: number;
  tempMin: number;
  weather: string;
  precip: number;
  humidity: number;
  windScale: string;
  uvIndex: string;
  sunrise: string;
  sunset: string;
}

export interface WeatherTrends {
  avgTempMax: number;
  avgTempMin: number;
  avgTemp: number;
  tempTrend: 'rising' | 'falling' | 'stable';
  tempTrendDesc: string;
  rainDays: number;
  weatherTypes: Record<string, number>;
  avgHumidity: number;
  hottestDay: WeatherDay;
  coldestDay: WeatherDay;
}

export interface CityWeather {
  name: string;
  forecast: WeatherDay[];
  trends: WeatherTrends | null;
}

export interface WeatherResult {
  updateTime: string;
  cachedSecondsAgo: number;
  cities: CityWeather[];
  failed: { city: string; error: string }[];
}

export function fetchWeather({ fresh = false } = {}): Promise<WeatherResult> {
  return jsonFetch<WeatherResult>(`/weather${fresh ? '?fresh=true' : ''}`);
}

// 天气前端缓存：stale-while-revalidate — 切 tab 重新挂载时先展示上次数据，后台拉新
const WEATHER_CACHE_KEY = 'marius:weatherCache:v1';

export function readWeatherCache(): WeatherResult | null {
  try {
    const s = localStorage.getItem(WEATHER_CACHE_KEY);
    if (s) {
      const parsed = JSON.parse(s) as WeatherResult;
      if (parsed && Array.isArray(parsed.cities) && parsed.cities.length > 0) return parsed;
    }
  } catch {
    // quota / parse 都按空处理
  }
  return null;
}

export function writeWeatherCache(payload: WeatherResult) {
  try {
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // quota exceeded: 静默丢弃
  }
}

// POST /api/upload → 上传用户自传图（货盘主图覆盖），返回可访问的 /uploads/... 路径
export async function uploadImage(file: File): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 上传最长 60s（大图）
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await authenticatedFetch(BASE + '/upload', { method: 'POST', body: fd, signal: ctrl.signal });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        if (body?.message) msg = body.message;
        else if (body?.error) msg = body.error;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const j = (await res.json()) as { ok?: boolean; url?: string };
    if (!j.url) throw new Error('上传失败：服务端未返回 url');
    return j.url;
  } finally {
    clearTimeout(timer);
  }
}

// ── 权限中心（部门 / 账号 / 管理员组）────────────────────────────────────────
export type AccessRole = 'admin' | 'edit' | 'view';

export interface AccessMe {
  role: AccessRole;
  reason: 'admin_group' | 'env_admin' | 'account_override' | 'department' | 'default' | 'anonymous';
  deptNames: string[];
  canEditTray: boolean;
  canManageAccess: boolean;
  canSyncData: boolean;
  canEditRules: boolean;
  departments: string[];
  defaultRole: AccessRole;
  bootstrapped: boolean;
  user: { id: string; displayName: string; email: string | null } | null;
}

export interface AccessDepartment {
  id: string;
  name: string;
  // null 表示跟随父部门的角色，一直往上找，找不到就用全局默认
  role: AccessRole | null;
  source: 'manual' | 'dingtalk';
  parentId?: string | null;
  note?: string;
}

export interface AccessMember {
  userId: string;
  unionId?: string | null;
  name: string;
  email: string | null;
  deptIds: string[];
  source: 'manual' | 'dingtalk';
}

export interface AccessOverride {
  userId: string;
  /** 对方还没登录过时只有钉钉 unionId，登录后自动生效 */
  unionId?: string | null;
  name: string;
  role: AccessRole;
  note?: string;
}

export interface AccessAdmin { userId: string; unionId?: string | null; name: string }

export interface AccessConfig {
  version: number;
  updatedAt: string | null;
  settings: { defaultRole: AccessRole };
  departments: AccessDepartment[];
  members: AccessMember[];
  overrides: AccessOverride[];
  admins: AccessAdmin[];
}

export interface KnownUser {
  id: string;
  name: string;
  email: string | null;
  provider: string;
  /** 钉钉 unionId，用来关联通讯录成员 */
  externalId?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

// GET /api/access/me → 当前登录人的角色与权限位
export function fetchAccessMe() {
  return jsonFetch<AccessMe>('/access/me', undefined, 15000);
}

// GET /api/access/config → 权限配置 + 登录过的用户目录（仅管理员）
export function fetchAccessConfig() {
  return jsonFetch<{ ok: boolean; config: AccessConfig; users: KnownUser[] }>('/access/config', undefined, 20000);
}

// PUT /api/access/config → 覆盖式保存权限配置（仅管理员）
// expectedUpdatedAt 用于乐观锁：与服务器当前版本不一致时返回 409，避免互相覆盖
export function saveAccessConfig(
  patch: Pick<AccessConfig, 'departments' | 'members' | 'overrides' | 'admins' | 'settings'>,
  expectedUpdatedAt?: string | null,
) {
  return jsonFetch<{ ok: boolean; config: AccessConfig }>('/access/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, expectedUpdatedAt }),
  }, 20000);
}

// GET /api/access/audit → 权限变更记录（仅管理员）
export interface AccessAuditEntry {
  at: string;
  actor: string;
  changes: string[];
  total: number;
}

export function fetchAccessAudit(limit = 30) {
  return jsonFetch<{ ok: boolean; entries: AccessAuditEntry[] }>(`/access/audit?limit=${limit}`);
}

// GET /api/access/org/status → 组织架构来源（统一登录服务）是否可用
export function fetchAccessOrgStatus() {
  return jsonFetch<{
    ok: boolean;
    configured: boolean;
    baseUrl: string | null;
    clientId: string | null;
    lastSyncedAt: string | null;
    departments: number;
    members: number;
    hint: string | null;
    error: string | null;
  }>('/access/org/status');
}

// POST /api/access/sync-org → 从统一登录服务同步部门与成员（仅管理员）
export function syncAccessOrg() {
  return jsonFetch<{ ok: boolean; departments: number; members: number; migrated: number }>('/access/sync-org', { method: 'POST' }, 120000);
}
