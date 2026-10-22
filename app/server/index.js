import express from 'express';
import http from 'node:http';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import productsRouter from './routes/products.js';
import samplesRouter from './routes/samples.js';
import traysRouter from './routes/trays.js';
import profilesRouter from './routes/profiles.js';
import fabricRouter from './routes/fabric.js';
import { router as uploadRouter, UPLOAD_DIR } from './uploads.js';
import { hasCredentials, clearProductsCache, clearSamplesCache } from './vscm-client.js';
import { clearBiCache, clearBiSkcCache } from './bi-client.js';
import { clearProfileCache } from './profile-client.js';
import { clearSizeCache } from './size-client.js';
import { clearCostCache } from './cost-client.js';
import { clearSalesCache } from './daysales-client.js';
import salesRouter from './routes/sales.js';
import { getRoleRules, saveRoleRules } from './role-rules.js';
import { getSceneRules, saveSceneRules } from './scene-rules.js';
import { getStrategyRules, saveStrategyRules } from './strategy-rules.js';
import { getWeatherRules, saveWeatherRules } from './weather-rules.js';
import aiRouter from './routes/ai.js';
import remainingInventoryRouter from './routes/remaining-inventory.js';
import { getWeather } from './weather-client.js';
import { attachTrayWs } from './ws-trays.js';
import { createSsoAuth, readSsoConfig } from './sso-auth.js';
import { createAccessControl } from './access-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch {}
}

const app = express();
const PORT = process.env.PORT || 3737;

const ssoAuth = createSsoAuth(readSsoConfig());
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || ssoAuth.isAllowedOrigin(origin)),
  credentials: true,
}));
app.use(express.json({ limit: '512kb' }));
app.use('/api/auth', ssoAuth.router);
app.use('/api', ssoAuth.requireSession);

// 权限中心：登录后先算角色，再挂权限管理接口
const access = createAccessControl();
app.use('/api', access.attach);
app.use('/api/access', access.router);

// 用户自传图静态托管（GET /uploads/<uuid>.<ext>）
// 自传商品图公开只读托管（写操作由 /api/upload 鉴权管控），避免因无 Cookie、会话过期或在公开页面访问时报 401 导致图片显示失败
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  immutable: true,
}));

// 面料与翻单页面静态托管（GET /fabric/sales.html, /fabric/index.html 等）
const FABRIC_DIR = path.join(__dirname, 'fabric-public');
app.use('/fabric', express.static(FABRIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// 图片代理：转发 OSS / 淘宝 CDN 等第三方图片（解决浏览器 CORS 限制）
// GET /api/image-proxy?url=<encoded full URL> → 返回图片二进制
// 内存缓存 1h（同一 URL 不重复拉）
const imageProxyCache = new Map(); // url -> { contentType, buffer, at }
const IMAGE_PROXY_TTL_MS = 60 * 60 * 1000;
const IMAGE_PROXY_TIMEOUT_MS = 8000;
const ALLOWED_IMAGE_HOSTS = /(oss\.scm321\.com|img\.alicdn\.com|alicdn\.com|oss-cn-|taobaocdn|aliyun|cdn\.ali|dingtalk|qpic\.cn)/i;
app.get('/api/image-proxy', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'missing url' });
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).json({ error: 'unsupported protocol' });
    }
    if (!ALLOWED_IMAGE_HOSTS.test(parsed.hostname)) {
      return res.status(403).json({ error: 'host not allowed' });
    }
    const cached = imageProxyCache.get(url);
    if (cached && Date.now() - cached.at < IMAGE_PROXY_TTL_MS) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(cached.buffer);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_PROXY_TIMEOUT_MS);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const arrayBuf = await r.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    imageProxyCache.set(url, { contentType, buffer, at: Date.now() });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buffer);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'upstream timeout' : e.message;
    res.status(502).json({ error: msg });
  }
});

// 简单健康检查（同时报告后端数据源）
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    vscm: hasCredentials() ? 'configured' : 'missing-creds',
  });
});

// 商品资源
app.use('/api/products', productsRouter);

// 人群画像 + 主播热卖榜（真实 BI 数据）
app.use('/api/profiles', profilesRouter);

// 用户自传图上传（POST /api/upload，返回 { url }）
app.use('/api/upload', access.guardWrites, uploadRouter);

// 样衣资源（独立端点；样衣阶段款号只在这里 / 经 /api/products/:id fallback 查到）
app.use('/api/samples', samplesRouter);
// 货盘写操作（PUT /api/trays、POST /api/trays/log）需要编辑权限
app.use('/api/trays', access.guardWrites, traysRouter);

// 销量：直播当天 + 累计总销量（数据源 e106807e，宽表关联后数据源）
app.use('/api/sales', salesRouter);

// 面料与翻单相关 API（/api/fabric-data, /api/query 等）
// 面料数据的增删改属于货盘内容编辑；查询类 GET/POST /api/query 不受影响
app.use('/api/fabric-data', access.guardWrites);
app.use('/api/history', access.guardWrites);
// 排单同步会真实写入钉钉，属于业务写操作，只读账号不得触发
app.use('/api/dingtalk-sync', access.guardWrites);
app.use('/api', fabricRouter);

// 规则配置（写）与数据同步仅管理员
app.use('/api/config', access.guardAdminWrites);

// 排品角色判定规则（配置后台读写；商品映射时实时生效）
app.get('/api/config/role-rules', (_req, res) => {
  res.json({ rules: getRoleRules(), source: fs.existsSync(path.join(__dirname, 'data', 'role-rules.json')) ? 'custom' : 'default' });
});
app.put('/api/config/role-rules', (req, res) => {
  try {
    const rules = saveRoleRules(req.body?.rules);
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 场景规则库（配置后台读写；持久化已接真，自动激活执行引擎尚未实现）
app.get('/api/config/scene-rules', (_req, res) => {
  res.json({ rules: getSceneRules(), source: fs.existsSync(path.join(__dirname, 'data', 'scene-rules.json')) ? 'custom' : 'default' });
});
app.put('/api/config/scene-rules', (req, res) => {
  try {
    const rules = saveSceneRules(req.body?.rules);
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// AI 选款策略口径（配置后台读写；system prompt 引用）
app.get('/api/config/strategy-rules', (_req, res) => {
  res.json({ rules: getStrategyRules(), source: fs.existsSync(path.join(__dirname, 'data', 'strategy-rules.json')) ? 'custom' : 'default' });
});
app.put('/api/config/strategy-rules', (req, res) => {
  try {
    const rules = saveStrategyRules(req.body?.rules);
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 天气选款规则（配置后台读写；从 weather 项目移植，可整段覆盖保存）
app.get('/api/config/weather-rules', (_req, res) => {
  res.json({ rules: getWeatherRules(), source: fs.existsSync(path.join(__dirname, 'data', 'weather-recommendation-rules.json')) ? 'custom' : 'default' });
});
app.put('/api/config/weather-rules', (req, res) => {
  try {
    const rules = saveWeatherRules(req.body?.rules);
    res.json({ rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// AI 选款策略 LLM 端点
app.use('/api/ai', aiRouter);

// 剩余库存推荐（BI 卡片 j93dcdbbe10994fc1a708939）
app.use('/api/remaining-inventory', access.guardAdminWrites, remainingInventoryRouter);

// 天气（Open-Meteo 免费 API，移植自 weather 项目；1h 缓存；?fresh=true 强制重拉）
app.get('/api/weather', async (req, res) => {
  try {
    const data = await getWeather({ fresh: req.query.fresh === 'true' });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'weather_fetch_failed', message: err.message, failed: err.failed || [] });
  }
});

// POST /api/sync — 从源头重新拉数据
//   kind='商品' → 领猫基础资料 + BI 款式卡（名称/小名/售价）+ 尺码 ETL
//   kind='库存' → BI SKC 卡（现货/在途/占单/交期） + 尺码 ETL（聚水潭接入后改聚水潭）
app.use('/api/sync', access.guardSyncWrites);
app.post('/api/sync', async (req, res) => {
  const kind = req.body?.kind === '库存' ? '库存' : '商品';
  try {
    if (!hasCredentials()) {
      return res.json({
        ok: true, kind,
        syncedAt: new Date().toISOString(),
        source: 'mock',
        message: `已从${kind === '库存' ? 'BI' : '领猫'}重新拉取（mock）`,
      });
    }
    if (kind === '商品') {
      // 清掉所有商品相关缓存：领猫基础资料 + 样衣库 + BI 款式卡 + BI SKC 卡 + 尺码 / 成本 ETL + 画像/主播 + 销量
      clearProductsCache({ hard: true });
      clearSamplesCache({ hard: true });
      clearBiCache();
      clearSizeCache();
      clearCostCache();
      clearProfileCache();
      clearSalesCache({ hard: true });
    } else {
      // 库存：只清 BI SKC 卡（现货/在途/占单/交期）、尺码 / 成本 ETL，保留款式卡基础资料
      clearBiSkcCache();
      clearSizeCache();
      clearCostCache();
    }
    // 触发重新拉取（命中磁盘缓存就秒返，否则走 guancli 重拉）
    const url = '/api/products?fresh=true';
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { headers: { Cookie: req.headers.cookie || '' } });
    const json = await r.json().catch(() => ({}));
    // /products?fresh=true 在拉取失败时返回 503 + source:'fetch-failed'，
    // 不要把这种"空 + 报错"的响应当作"同步成功 0 款"
    if (!r.ok || json.source === 'fetch-failed') {
      return res.status(500).json({
        ok: false,
        kind,
        error: json.message || json.error || `fresh fetch failed (HTTP ${r.status})`,
      });
    }
    return res.json({
      ok: true,
      kind,
      syncedAt: new Date().toISOString(),
      source: json.source,
      count: json.count,
      message: kind === '库存'
        ? `已从 BI 重新拉取库存（${json.count} 款；聚水潭接入后会切换）`
        : `已从领猫 + BI 款式卡重新拉取 ${json.count} 款商品`,
    });
  } catch (err) {
    console.error(`[sync] ${kind} 同步失败:`, err.message);
    return res.status(500).json({ ok: false, kind, error: err.message });
  }
});

// POST /api/sync/hengji — 运行 scripts/dingtalk-sync-cost.mjs，从钉钉核价表拉取成本 + 销售价
// 同步流程：打开非 headless Chrome → 复制核价表 → 解析 → 写入 server/data/hengji-cost.json
// 注意：脚本支持跨平台剪贴板读取（确保 ~/.dingtalk-auth-profile 或 storageState 已登录）
const HENGJI_SCRIPT = process.env.COST_SYNC_SCRIPT || path.join(__dirname, '..', 'scripts', 'dingtalk-sync-cost.mjs');
app.post('/api/sync/hengji', async (_req, res) => {
  const startedAt = Date.now();
  const child = spawn('node', [HENGJI_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  // 120s 超时：脚本正常 ~30-60s，登录态失效/网络抖动时可能更久
  const killer = setTimeout(() => {
    console.error('[sync/hengji] 超时 120s，kill 子进程');
    child.kill('SIGTERM');
  }, 120_000);
  child.on('close', (code) => {
    clearTimeout(killer);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (code === 0) {
      // 读最新 JSON 拿到 count
      let costCount = 0, salesCount = 0;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'hengji-cost.json'), 'utf8'));
        costCount = Object.keys(j.byCode || {}).length;
        salesCount = Object.keys(j.salesPriceByCode || {}).length;
      } catch {}
      console.log(`[sync/hengji] 完成 ${elapsed}s：${costCount} 成本 / ${salesCount} 销售价`);
      return res.json({
        ok: true,
        kind: '成本及价格',
        syncedAt: new Date().toISOString(),
        message: `已同步钉钉核价表：${costCount} 个款号成本，${salesCount} 个款号销售价（${elapsed}s）`,
        count: { cost: costCount, sales: salesCount },
      });
    }
    // 失败：截取 stderr 末尾 800 字作为错误消息
    const tail = (stderr || stdout).slice(-800) || `exit code ${code}`;
    console.error(`[sync/hengji] 失败 exit=${code} ${elapsed}s：${tail}`);
    return res.status(500).json({ ok: false, kind: '成本及价格', error: tail });
  });
  child.on('error', (err) => {
    clearTimeout(killer);
    console.error('[sync/hengji] spawn 失败:', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, kind: '成本及价格', error: err.message });
  });
});

// GET /api/sync/hengji/status — 快速检查钉钉文档登录态（headless，约 6-10s）
// 不复制表格，只验证能打开。登录态失效时让前端提前提示用户
// 而不是等 30-60s 同步脚本跑完才发现
const HENGJI_STATUS_SCRIPT = process.env.COST_STATUS_SCRIPT || path.join(__dirname, '..', 'scripts', 'dingtalk-check-status.mjs');
app.get('/api/sync/hengji/status', (_req, res) => {
  const child = spawn('node', [HENGJI_STATUS_SCRIPT], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const killer = setTimeout(() => child.kill('SIGTERM'), 25_000);
  child.on('close', () => {
    clearTimeout(killer);
    try {
      const result = JSON.parse(stdout || '{}');
      return res.json(result);
    } catch {
      return res.json({ ok: false, error: stderr || 'check_status_parse_error' });
    }
  });
  child.on('error', (err) => {
    clearTimeout(killer);
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  });
});

// 全局兜底
app.use((err, _req, res, _next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const server = http.createServer(app);
attachTrayWs(server, ssoAuth, access);
server.on('close', () => ssoAuth.close());

server.listen(PORT, () => {
  const vscm = hasCredentials() ? '✓ 已配' : '✗ 缺凭证';
  console.log(`[server] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[server] 领猫凭证：${vscm}`);
});
