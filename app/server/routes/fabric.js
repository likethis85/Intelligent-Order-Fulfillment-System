import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase, isSupabaseReady } from '../supabase-client.js';
import {
  getProductSkus,
  getSampleSkus,
  queryFabricInfoMulti,
} from '../fabric-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'fabric-history.json');

const router = Router();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(content) || [];
    }
  } catch {}
  return [];
}

function saveHistory(records) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(records.slice(0, 100), null, 2), 'utf-8');
  } catch (err) {
    console.error('[fabric-history] 保存失败:', err.message);
  }
}

/**
 * 直接读取 Supabase 的 fabric_data 记录（供内部其它模块如 samples.js 复用）
 */
export async function getFabricDataRows() {
  if (!isSupabaseReady() || !supabase) return [];
  const { data, error } = await supabase
    .from('fabric_data')
    .select('*')
    .order('submitted_at', { ascending: false });

  if (error) {
    console.error('[getFabricDataRows] 读取失败:', error.message);
    throw error;
  }
  return (data || []).filter((r) => {
    const w = String(r.warehouse || '');
    return !(w.includes('恒隆') || w.includes('工厂物料'));
  });
}

// ── GET /api/fabric-data ──
router.get('/fabric-data', async (_req, res) => {
  try {
    if (!isSupabaseReady() || !supabase) {
      return res.status(503).json({ error: 'Supabase 未配置：请在 server/.env 设置 SUPABASE_URL / SUPABASE_KEY' });
    }
    const rows = await getFabricDataRows();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fabric-data ──
router.post('/fabric-data', async (req, res) => {
  try {
    if (!isSupabaseReady() || !supabase) {
      return res.status(503).json({ error: 'Supabase 未配置' });
    }
    const { data: items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: '无效的数据' });
    }

    const userId = req.session?.user?.id || req.session?.user?.name || null;
    const results = [];
    const errors = [];

    for (const item of items) {
      const record = {
        pdt_code: item.pdtCode,
        sku_code: item.skuCode || null,
        color_name: item.colorName || null,
        pdt_color_name: item.pdtColorName || null,
        mt_code: item.mtCode,
        mt_name: item.mtName || null,
        mt_spec_name: item.mtSpecName || null,
        warehouse: item.warehouse || null,
        supplier_name: item.supplierName || null,
        use_amt: item.useAmt || 0,
        stock: item.stock || 0,
        in_transit_qty: item.inTransitQty || 0,
        delivery_date: item.deliveryDate || null,
        orderable_qty: item.orderableQty || 0,
        lead_time_days: item.leadTimeDays || 0,
        factory_spot_qty: item.factorySpotQty || 0,
        mt_price: item.mtPrice || 0,
        mt_category: item.mtCategory || null,
        purchase_orders: item.purchaseOrders || null,
        fabric_info: item.fabricInfo || null,
        submitted_by: userId,
      };

      const recordToUpsert = { ...record };
      if (!record.fabric_info) {
        delete recordToUpsert.fabric_info;
      }

      const { data, error } = await supabase
        .from('fabric_data')
        .upsert(recordToUpsert, { onConflict: 'pdt_code,sku_code,mt_code,mt_spec_name,warehouse' })
        .select()
        .single();

      if (error) {
        console.error('[POST /api/fabric-data] upsert error:', error);
        errors.push(error);
      } else {
        results.push(data);
      }
    }

    // 共用面料联动：同一面料明细（mt_code + mt_spec_name + warehouse）同步补充信息
    const seenFabric = new Set();
    for (const r of results) {
      const hasData = Number(r.in_transit_qty) > 0 || !!r.delivery_date ||
        Number(r.factory_spot_qty) > 0 || Number(r.orderable_qty) > 0 || Number(r.lead_time_days) > 0;
      if (!hasData) continue;
      const fk = `${r.mt_code}|${r.mt_spec_name || ''}|${r.warehouse || ''}`;
      if (seenFabric.has(fk)) continue;
      seenFabric.add(fk);

      let q = supabase
        .from('fabric_data')
        .update({
          in_transit_qty: r.in_transit_qty,
          delivery_date: r.delivery_date,
          factory_spot_qty: r.factory_spot_qty,
          orderable_qty: r.orderable_qty,
          lead_time_days: r.lead_time_days,
          fabric_info: null,
        })
        .eq('mt_code', r.mt_code)
        .neq('id', r.id);
      q = r.mt_spec_name ? q.eq('mt_spec_name', r.mt_spec_name) : q.is('mt_spec_name', null);
      q = r.warehouse ? q.eq('warehouse', r.warehouse) : q.is('warehouse', null);

      const { error: propagErr } = await q;
      if (propagErr) {
        console.error('[POST /api/fabric-data] 共用面料联动失败:', propagErr.message);
      }
    }

    if (errors.length > 0) {
      return res.status(500).json({
        error: `保存失败：${errors[0].message || JSON.stringify(errors[0])}`,
        successCount: results.length,
        failCount: errors.length,
      });
    }
    res.json({ success: true, count: results.length });
  } catch (error) {
    console.error('[POST /api/fabric-data] exception:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/fabric-data/:id ──
router.delete('/fabric-data/:id', async (req, res) => {
  try {
    if (!isSupabaseReady() || !supabase) return res.status(503).json({ error: 'Supabase 未配置' });
    const { id } = req.params;
    const { error } = await supabase.from('fabric_data').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fabric-data/force-add ──
router.post('/fabric-data/force-add', async (req, res) => {
  try {
    const { pdt_code } = req.body;
    if (!pdt_code) return res.status(400).json({ error: '款号不能为空' });
    if (!isSupabaseReady() || !supabase) return res.status(503).json({ error: 'Supabase 未配置' });

    const userId = req.session?.user?.id || req.session?.user?.name || null;
    let skus = await getProductSkus(pdt_code);
    if (skus.length === 0) skus = await getSampleSkus(pdt_code);
    if (skus.length === 0) {
      return res.status(404).json({ error: '查不到此款或该款没有SKU数据' });
    }

    const { data: real } = await supabase
      .from('fabric_data')
      .select('id')
      .eq('pdt_code', pdt_code)
      .neq('mt_code', '_forced_')
      .limit(1);

    if (real && real.length > 0) {
      return res.status(400).json({ error: '该款号已有面料数据，无需强制添加' });
    }

    await supabase
      .from('fabric_data')
      .delete()
      .eq('pdt_code', pdt_code)
      .eq('mt_code', '_forced_');

    const skcMap = new Map();
    for (const sku of skus) {
      const skc = sku.skuCode.slice(0, -1);
      if (!skc) continue;
      if (!skcMap.has(skc)) {
        skcMap.set(skc, { skuCode: skc, colorName: sku.skuCorlorName || '' });
      }
    }

    const records = Array.from(skcMap.values()).map((s) => ({
      pdt_code,
      sku_code: s.skuCode,
      pdt_color_name: s.colorName || null,
      mt_code: '_forced_',
      mt_name: '(无面料信息)',
      mt_spec_name: '',
      warehouse: '',
      supplier_name: '',
      use_amt: 0,
      stock: 0,
      in_transit_qty: 0,
      delivery_date: null,
      orderable_qty: 0,
      lead_time_days: 0,
      factory_spot_qty: 0,
      mt_price: 0,
      mt_category: null,
      purchase_orders: null,
      fabric_info: null,
      sales_pieces: 0,
      sales_delivery_days: 0,
      sales_batches: [],
      submitted_by: userId,
    }));

    const { data, error } = await supabase.from('fabric_data').insert(records).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data, count: records.length });
  } catch (error) {
    console.error('[POST /api/fabric-data/force-add] exception:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fabric-data/fill-skcs ──
router.post('/fabric-data/fill-skcs', async (req, res) => {
  try {
    const { pdt_codes } = req.body;
    if (!Array.isArray(pdt_codes) || pdt_codes.length === 0) {
      return res.json({ success: true, inserted: 0 });
    }
    if (!isSupabaseReady() || !supabase) return res.status(503).json({ error: 'Supabase 未配置' });

    const userId = req.session?.user?.id || req.session?.user?.name || null;
    const allNewRecords = [];

    for (const pdtCode of pdt_codes) {
      let skus = await getProductSkus(pdtCode);
      if (skus.length === 0) skus = await getSampleSkus(pdtCode);
      if (skus.length === 0) continue;

      const { data: existing } = await supabase
        .from('fabric_data')
        .select('sku_code')
        .eq('pdt_code', pdtCode);
      const existingSkcs = new Set((existing || [])
        .map((r) => (r.sku_code || '').slice(0, -1))
        .filter(Boolean));

      const skcMap = new Map();
      for (const sku of skus) {
        const skc = sku.skuCode.slice(0, -1);
        if (!skc || existingSkcs.has(skc)) continue;
        if (!skcMap.has(skc)) {
          skcMap.set(skc, { skuCode: skc, colorName: sku.skuCorlorName || '' });
        }
      }

      for (const s of skcMap.values()) {
        allNewRecords.push({
          pdt_code: pdtCode,
          sku_code: s.skuCode,
          pdt_color_name: s.colorName || null,
          mt_code: '_forced_',
          mt_name: '(无面料信息)',
          mt_spec_name: '',
          warehouse: '',
          supplier_name: '',
          use_amt: 0,
          stock: 0,
          in_transit_qty: 0,
          delivery_date: null,
          orderable_qty: 0,
          lead_time_days: 0,
          factory_spot_qty: 0,
          mt_price: 0,
          mt_category: null,
          purchase_orders: null,
          fabric_info: null,
          sales_pieces: 0,
          sales_delivery_days: 0,
          sales_batches: [],
          submitted_by: userId,
        });
      }
    }

    if (allNewRecords.length > 0) {
      await supabase
        .from('fabric_data')
        .upsert(allNewRecords, { onConflict: 'pdt_code,sku_code,mt_code,mt_spec_name,warehouse', ignoreDuplicates: true });
    }
    res.json({ success: true, inserted: allNewRecords.length });
  } catch (error) {
    console.error('[POST /api/fabric-data/fill-skcs] exception:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/fabric-data/:id/sales ──
router.put('/fabric-data/:id/sales', async (req, res) => {
  try {
    if (!isSupabaseReady() || !supabase) return res.status(503).json({ error: 'Supabase 未配置' });
    const { id } = req.params;
    const { sales_pieces, sales_delivery_days, sales_batches, sales_base_snapshot } = req.body;

    const updateData = {
      sales_pieces: sales_pieces || 0,
      sales_delivery_days: sales_delivery_days || 0,
      sales_batches: Array.isArray(sales_batches) ? sales_batches : [],
    };
    if (sales_base_snapshot !== undefined) {
      updateData.sales_base_snapshot = sales_base_snapshot;
    }

    const { data, error } = await supabase
      .from('fabric_data')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/fabric-data/clear-supplementary ──
router.post('/fabric-data/clear-supplementary', async (_req, res) => {
  try {
    if (!isSupabaseReady() || !supabase) return res.status(503).json({ error: 'Supabase 未配置' });
    const { data, error } = await supabase
      .from('fabric_data')
      .update({
        in_transit_qty: 0,
        delivery_date: null,
        orderable_qty: 0,
        lead_time_days: 0,
        factory_spot_qty: 0,
        fabric_info: null,
        sales_pieces: 0,
        sales_delivery_days: 0,
        sales_batches: [],
      })
      .not('id', 'is', null)
      .select('id');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, count: data?.length || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/query ──
router.post('/query', async (req, res) => {
  try {
    const { pdtCodes } = req.body;
    if (!pdtCodes || !Array.isArray(pdtCodes) || pdtCodes.length === 0) {
      return res.status(400).json({ error: '请提供款式编码列表' });
    }

    const rows = await queryFabricInfoMulti(pdtCodes, 3);
    if (rows.length > 0) {
      const history = loadHistory();
      const record = {
        id: Date.now().toString(),
        time: new Date().toLocaleString('zh-CN'),
        codes: pdtCodes,
        results: rows,
      };
      history.unshift(record);
      saveHistory(history);
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[POST /api/query] 失败:', error.message);
    res.status(500).json({ error: error.message || '查询失败' });
  }
});

// ── GET /api/history & DELETE /api/history ──
router.get('/history', (_req, res) => {
  res.json({ success: true, data: loadHistory() });
});

router.delete('/history/:id', (req, res) => {
  const { id } = req.params;
  const history = loadHistory().filter((r) => r.id !== id);
  saveHistory(history);
  res.json({ success: true });
});

router.delete('/history', (_req, res) => {
  saveHistory([]);
  res.json({ success: true });
});

// ── GET /api/app-config & GET /api/config ──
router.get('/app-config', (_req, res) => {
  res.json({
    supabase: {
      url: process.env.SUPABASE_URL || '',
      key: process.env.SUPABASE_KEY || '',
    },
  });
});

router.get('/config', (_req, res) => {
  res.json({
    appId: process.env.VSCM_APP_ID || '',
    appSecret: process.env.VSCM_APP_SECRET || '',
    baseUrl: process.env.VSCM_BASE_URL || 'https://open.scm321.com',
  });
});

// ── POST /api/dingtalk-sync ──
router.post('/dingtalk-sync', async (req, res) => {
  res.json({ success: true, message: 'dingtalk_sync_acknowledged' });
});

export default router;
