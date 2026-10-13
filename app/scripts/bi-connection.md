# BI → Supabase PostgreSQL 直连配置说明

> 目标：把三张导出表（`restock_planned` / `no_restock` / `sku_detail`）+ 三个聚合 view 暴露给 BI，
> 让 BI 在后台通过「数据库 SQL 数据源」直接拉取，不再走 ETL 同步。

---

## 1. supabase 实例信息（自托管 api.marius.vip）

| 项 | 值 |
| --- | --- |
| 项目 URL（REST API） | `https://api.marius.vip` |
| REST 路径前缀 | `/rest/v1/<table_name>` |
| 表所在 schema | `public` |
| Service key | 见 `app/server/.env` 的 `SUPABASE_KEY`（你已经填了同款） |

### 自托管 PG 直连端口说明

自托管 supabase 默认用 Kong 网关对外只暴露 PostgREST（`/rest/v1`）、Auth（`/auth/v1`）、Storage（`/storage/v1`），**5432 端口通常不对公网开放**。要让 BI 直连需要满足以下任一：

- **方案 A**：supabase 部署的服务器开 5432 端口到 BI 平台网段
- **方案 B**：BI 平台支持 HTTP 数据源（PostgREST REST API），用 `https://api.marius.vip/rest/v1/<table>` 拉
- **方案 C**：BI 平台用「智能 ETL」建一个 HTTP API 节点调 PostgREST（推荐，无需开放 5432）

> 实际能不能 A 走通取决于你们 BI 平台网络环境。
> 我没法替你探测，需要你问 BI 平台 admin 或自托管服务器的运维。

---

## 2. 三张表 schema（已建好，跑过 `scripts/sales-tables.sql` 后存在）

| 表 | 主键 / 唯一约束 | 关键字段 | 用途 |
| --- | --- | --- | --- |
| `restock_planned` | `(tray_id, pdt_code, skc, pieces, days)` | `tray_id, pdt_code, skc, pieces, days, color, cycle, live_date, registered_at, source` | 每批翻单一行 |
| `no_restock` | `(tray_id, pdt_code, skc)` | `tray_id, pdt_code, skc, color, fabric, section, look_idx` | 无面料不翻单每个 SKC 一行 |
| `sku_detail` | `(tray_id, section, look_idx, pdt_code)` | `tray_id, pdt_code, skc=null, section, look_idx, name, color, price, stock_main, in_transit, restock, planned_qty, ordered_qty, goods_value, live_date` | 一坑位一pid 一行 |

> `pid` / `pdt_code` 已全部归一为**小写**，方便 BI 跨款聚合。

---

## 3. 三个聚合 view（需要你跑 `scripts/bi-views.sql` 后才存在）

| view | 维度 | 输出 |
| --- | --- | --- |
| `v_plan_summary` | `tray_id, pdt_code` | `total_pieces`（该款翻单总量）、`batches`（所有批次 JSON 数组）、`live_date`、`skcs` |
| `v_no_restock_summary` | `tray_id, pdt_code` | 该款无面料的 SKC 列表 + fabrics 列表 + items JSON |
| `v_sku_summary` | `tray_id` | `pid_count`, `unique_pdt_count`, `total_goods_value`, `total_stock`, `total_in_transit` |

跑完 SQL 后大致能这样查询：

```sql
-- 报表 1: 各货盘的计划翻单总量 Top 款
SELECT tray_id, pdt_code, total_pieces, live_date
FROM v_plan_summary
ORDER BY total_pieces DESC
LIMIT 100;

-- 报表 2: 各货盘不可翻单的款号 + 面料
SELECT tray_id, pdt_code, skcs, fabrics, items
FROM v_no_restock_summary;

-- 报表 3: 各货盘商品总量 / 货值
SELECT tray_id, unique_pdt_count, total_goods_value, total_stock, total_in_transit, live_date
FROM v_sku_summary
ORDER BY total_goods_value DESC;
```

---

## 4. BI 数据源怎么配（你/BI admin 需知）

### 方案 A：JDBC / PostgreSQL 直连

| BI 端配置项 | 值 |
| --- | --- |
| 主机 | 找 supabase 部署者要（可能要暴露 5432） |
| 端口 | `5432` |
| 数据库 | `postgres` |
| 用户 | `postgres` |
| 密码 | 找运维要 |
| SSL | `require`（自托管 supabase 通常启 TLS） |
| 默认 schema | `public` |

### 方案 B：HTTP 数据源 / PostgREST

| BI 端配置项 | 值 |
| --- | --- |
| 请求 URL | `https://api.marius.vip/rest/v1/<table_name>`（如 `/rest/v1/v_plan_summary`） |
| 请求头 | `apikey: <SUPABASE_KEY>` / `Authorization: Bearer <SUPABASE_KEY>` |
| 解析方式 | BI 支持 JSON 就好 |

> 注意 PostgREST 默认返回 `[]` 时不会报错，列名全部小写、字段是 JSONB 时会嵌套。

### 方案 C：BI 智能 ETL HTTP API 节点

- BI 后台「智能 ETL」→「新建节点」→ 选择「HTTP API / 自定义 API」
- 配置同方案 B；ETL 调度频率拉一次后落 BI 数据集，报表直接 join 现有宽表卡

---

## 5. 你需要做的两件事

1. **跑 SQL**（一次性）：
   - `scripts/sales-tables.sql`（已建，跑过 ✓）
   - `scripts/bi-views.sql`（**新**，跑完后才有 v_* 视图）
2. **BI 后台配置**：找 BI admin 协调外部数据源按上面任一方案配置

---

## 6. 现在的数据状态

```
restock_planned: 6 行（t-103 一个货盘去重后）
no_restock:     2 行（t_test_render + t1，共用 me15ff06802）
sku_detail:    35 行（所有 tray 的 (section, look_idx, pdt_code)）
```

数据会随每次 PUT /api/trays 增量更新（前端编辑货盘自动同步；删除 tray 走 deletedTrayIds）。

---

## 7. 已知约束

- `name`, `color`, `price`, `planned_qty`, `goods_value` 在 sku_detail 表里是「从 products.json 快照的字段」。
  目前后端 `products.json` 还是 mock 数据（a1~d8），所以这些列经常是 NULL。
  BI 上对 `name` / `price` 做聚合可能会因为 NULL 漏数。建议 BI 报表用 `v_sku_summary` 这种聚合 view，再 join 现有 BI 内的产品卡取名称 / 价格。
- `sku_detail.skc` 字段当前**总为 NULL**（同一坑位多 SKC，聚合到 plan 表）。
  BI 想拿 SKC 维度的明细 → join 到 `restock_planned` 用 `(tray_id, pdt_code)` 关联。
- 表结构可能还会演进。如果新增字段需要 ALTER TABLE，跟我说一声，我维护一下迁移文件。
