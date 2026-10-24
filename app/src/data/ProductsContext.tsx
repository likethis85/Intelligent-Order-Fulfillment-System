import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Product } from './products';
import { fetchSamplesByCodes } from './api';

export const ProductsContext = createContext<Product[]>([]);

export function useProducts(): Product[] {
  return useContext(ProductsContext);
}

// 返回 (id) => Product 的查找函数，使用法兼容旧的 byId(pid)
// 找不到时返回空壳 product，避免调用方访问 .name/.img 时炸出白屏
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

export function useProductsById(): (id: string) => Product {
  const products = useProducts();
  // 货盘里的款号可能是大写（ME15FF039）也可能是小写（me15ff039），
  // 但 PRODUCTS 上下文里的 id 统一是小写 —— 用 Map + lowercase 做大小写不敏感查表，
  // 否则大写款号会查不到产品，返回 EMPTY_PRODUCT（stock=[] / bomCost=undefined），
  // 导致库存行显示「面料数据未抓到」+ 成本丢失。
  const lowerMap = useMemo(
    () => new Map(products.map((p) => [p.id.toLowerCase(), p])),
    [products],
  );
  return (id: string) => lowerMap.get(id.toLowerCase()) ?? EMPTY_PRODUCT(id);
}

// 在 useProductsById 基础上再做一层兜底：pids 里不在 /api/products 的款号
// （如老羽绒服 me13fw006，领猫 30 天窗口已查不到）从 /api/samples 拉一次补齐；
// 若在 customMap 中定义，未入库款展示用户自填的商品名称。
// 后期同步商品库后，若款号一致自动优先使用商品库官方真实数据（自动更新无需重写货盘）。
export function useProductResolver(
  pids: string[],
  customMap?: Record<string, { id?: string; name: string } | string>,
): (id: string) => Product {
  const products = useProducts();
  const base = useProductsById();
  const [extras, setExtras] = useState<Product[]>([]);
  const key = useMemo(
    () => [...new Set(pids.map((p) => p.toLowerCase()))].sort().join(','),
    [pids],
  );
  useEffect(() => {
    const list = key ? key.split(',') : [];
    const known = new Set(products.map((p) => p.id.toLowerCase()));
    const missing = list.filter((id) => !known.has(id));
    if (missing.length === 0) {
      setExtras([]);
      return;
    }
    let cancelled = false;
    fetchSamplesByCodes(missing)
      .then((res) => { if (!cancelled) setExtras(res.items ?? []); })
      .catch(() => { if (!cancelled) setExtras([]); });
    return () => { cancelled = true; };
  }, [key, products]);
  return useMemo(() => {
    const productMap = new Map(products.map((p) => [p.id.toLowerCase(), p]));
    const sampleMap = new Map(extras.map((p) => [p.id.toLowerCase(), p]));

    return (id: string) => {
      const lower = id.toLowerCase();
      // 1. 优先查商品库（后期同步商品库后，款号一致自动更新为官方真实数据）
      const real = productMap.get(lower);
      if (real) return real;

      // 2. 其次查样衣库（样衣阶段款）
      const sample = sampleMap.get(lower);
      if (sample) return sample;

      // 3. 再次查自定义未入库款（展示用户自填名称与自定义颜色）
      if (customMap) {
        const custom = customMap[lower];
        if (custom) {
          const customName = typeof custom === 'string' ? custom : custom.name;
          const customId = typeof custom === 'object' && custom.id ? custom.id : id;
          const customColors = typeof custom === 'object' && Array.isArray((custom as any).colors) ? (custom as any).colors : [];
          return {
            ...EMPTY_PRODUCT(id),
            id: customId || id,
            name: customName || id.toUpperCase(),
            colors: customColors,
            isCustom: true,
          };
        }
      }

      // 4. 兜底空壳
      return base(id);
    };
  }, [products, extras, customMap, base]);
}

export function ProductsProvider({ products, children }: { products: Product[]; children: ReactNode }) {
  return <ProductsContext.Provider value={products}>{children}</ProductsContext.Provider>;
}