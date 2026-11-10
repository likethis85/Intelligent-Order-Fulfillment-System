// 货盘「库存情况」行的解析：把 BI 的一行文本拆成 颜色 + 现货 + 在途 + 交期 + 占单
// 兼容 BI 新格式 "深灰千鸟：现货40 在途179 占单320" / BI 旧 "深灰千鸟：40米·在途179"
// / mock "白占单180在途100"
export type StockEntry = {
  color: string;
  qty: number;
  eta: string | null;
  stock: number;
  inTransit: number;
  orderBook: number;
};

function headColor(line: string): string {
  // BI 行是「颜色：现货…」，冒号前那段就是颜色名
  const head = line.split(/[：:]/)[0].trim();
  if (!head || head.length > 20) return '';
  // 没有冒号的 mock 行整行都是内容（"白占单180在途100"），别把描述当颜色
  if (/[0-9]/.test(head) || /现货|在途|占单/.test(head)) return '';
  return head;
}

// 货盘「库存情况」的用词：整款只有现货、没有在途/交期/占单时，数量本身就能看懂，
// 省掉「现货」两字；一旦同款还出现其它信息，保留标签才不会把 37 和 121 混成一组数字。
// 判定对象是「整个款」（单元格）而不是某个颜色行：一个款里只要有任一颜色带在途，
// 该款所有颜色的现货都带标签。页面和 Excel 共用这个函数。
export function stockCellPartsList(
  rows: { stock: number; inTransit: number; eta: string | null; orderBook: number }[],
  { orderBookMinDisplay = 0 }: { orderBookMinDisplay?: number } = {},
): string[][] {
  const visibleOrderBook = (v: number) => v > 0 && v >= orderBookMinDisplay;
  const hasOther = rows.some((v) => v.inTransit > 0 || Boolean(v.eta) || visibleOrderBook(v.orderBook));
  return rows.map((v) => {
    const parts: string[] = [];
    if (v.stock > 0) parts.push(hasOther ? `现货${v.stock}` : `${v.stock}`);
    if (v.inTransit > 0) parts.push(`在途${v.inTransit}`);
    if (v.eta) parts.push(`${v.eta}交`);
    if (visibleOrderBook(v.orderBook)) parts.push(`占单${v.orderBook}`);
    return parts;
  });
}

// 没有按色拆分的 BI 独有款（只有款级 stockMain/inTransit）走同一个口径
export function stockFallbackParts(stockMain: number, inTransit: number): string[] {
  return stockCellPartsList([{ stock: stockMain, inTransit, eta: null, orderBook: 0 }])[0];
}

// 货盘库存取数优先级：聚水潭实时库存（全仓）优先，BI SKC 卡（主仓）兜底。
// 聚水潭没返回这个款（undefined/null）才保留 BI；只要返回了（哪怕库存为 0 / 空行），
// 就以聚水潭为准——否则 ERP 已经清零、页面还挂着 BI 的旧库存更危险。
export type JstStock = {
  stock: string[];
  stockMain: number;
  inTransit: number;
  // 真正从 ERP 取到数据的时刻（ISO）；失败后沿用的旧缓存会标 stale
  updatedAt?: string;
  stale?: boolean;
};

export function applyJushuitanPriority<T extends {
  stock: string[];
  stockMain: number;
  inTransit: number;
  stockSource?: 'jushuitan';
  stockUpdatedAt?: string;
  stockStale?: boolean;
}>(product: T, jst: JstStock | undefined | null): T {
  if (!jst) return product;
  return {
    ...product,
    stock: jst.stock ?? [],
    stockMain: jst.stockMain ?? 0,
    inTransit: jst.inTransit ?? 0,
    stockSource: 'jushuitan',
    stockUpdatedAt: jst.updatedAt,
    stockStale: Boolean(jst.stale),
  };
}

// 库存更新时间：当天只显示 HH:mm，跨天带上 MM-DD，避免把前一天的数看成今天的
export function formatStockUpdatedAt(iso?: string, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function parseStockLine(line: string, productColors: string[] = []): StockEntry {
  const sorted = [...productColors].sort((a, b) => b.length - a.length);
  // 领猫的颜色列表里没有这个色（比如后来补加的色号）时，退回用 BI 行头部的颜色名，
  // 这样它也能单独成行、跟着颜色行的勾选显示/隐藏
  const color = sorted.find((c) => line.includes(c)) || headColor(line);
  // 现货 X（关键字「现货」或 X米）
  const stockKwd = line.match(/现货\s*(\d+(?:\.\d+)?)/);
  const stockMi = line.match(/(\d+(?:\.\d+)?)\s*米/);
  const stock = stockKwd ? Number(stockKwd[1]) : stockMi ? Number(stockMi[1]) : 0;
  // 在途 X
  const inTransitMatch = line.match(/在途\s*(\d+(?:\.\d+)?)/);
  const inTransit = inTransitMatch ? Number(inTransitMatch[1]) : 0;
  // 占单 X
  const orderMatch = line.match(/占单\s*(\d+(?:\.\d+)?)/);
  const orderBook = orderMatch ? Number(orderMatch[1]) : 0;
  // 交期日期
  const etaMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  const eta = etaMatch ? etaMatch[1] : null;
  // 兼容字段：第一数字（旧渲染兜底用）
  const numMatch = line.match(/(\d+(?:\.\d+)?)/);
  const qty = numMatch ? Number(numMatch[1]) : 0;
  return { color, qty, eta, stock, inTransit, orderBook };
}
