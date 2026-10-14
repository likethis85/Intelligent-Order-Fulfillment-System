import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import fabricRouter, { getFabricDataRows } from '../server/routes/fabric.js';
import { queryFabricInfoMulti } from '../server/fabric-client.js';

const appDir = fileURLToPath(new URL('../', import.meta.url));

test('static assets exist in server/fabric-public', () => {
  const publicDir = path.join(appDir, 'server', 'fabric-public');
  assert.ok(fs.existsSync(path.join(publicDir, 'sales.html')), 'sales.html exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'index.html')), 'index.html exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'prefill-listener.js')), 'prefill-listener.js exists');
  assert.ok(fs.existsSync(path.join(publicDir, 'vendor', 'supabase.min.js')), 'supabase.min.js exists');
});

test('fabric client exports queryFabricInfoMulti', () => {
  assert.equal(typeof queryFabricInfoMulti, 'function');
});

test('fabric router handles basic endpoints', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', fabricRouter);

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const resConfig = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(resConfig.status, 200);
    const configData = await resConfig.json();
    assert.ok('appId' in configData);
    assert.ok('baseUrl' in configData);

    const resHistory = await fetch(`http://127.0.0.1:${port}/api/history`);
    assert.equal(resHistory.status, 200);
    const histData = await resHistory.json();
    assert.equal(histData.success, true);
    assert.ok(Array.isArray(histData.data));
  } finally {
    server.close();
  }
});

test('fabric-public assets do not have broken root script tags or recursive login redirects', () => {
  const indexHtml = fs.readFileSync(path.join(appDir, 'server', 'fabric-public', 'index.html'), 'utf8');
  assert.ok(!indexHtml.includes('src="/vendor/supabase.min.js"'), 'index.html must not use root /vendor path');
  assert.ok(!indexHtml.includes("window.location.replace('/login.html')"), 'index.html must not redirect to login.html');
  assert.ok(indexHtml.includes('src="/fabric/vendor/supabase.min.js"'), 'index.html must use /fabric/vendor/supabase.min.js');

  const salesHtml = fs.readFileSync(path.join(appDir, 'server', 'fabric-public', 'sales.html'), 'utf8');
  assert.ok(!salesHtml.includes('src="/vendor/supabase.min.js"'), 'sales.html must not use root /vendor path');
  assert.ok(!salesHtml.includes("window.location.href = '/login.html'"), 'sales.html must not redirect to login.html');
  assert.ok(salesHtml.includes('src="/fabric/vendor/supabase.min.js"'), 'sales.html must use /fabric/vendor/supabase.min.js');
});

test('TraysPage points to /fabric/index.html explicitly and supports mobile dialog', () => {
  const traysPage = fs.readFileSync(path.join(appDir, 'src', 'sections', 'TraysPage.tsx'), 'utf8');
  assert.ok(traysPage.includes('${FABRIC_BASE}/index.html?codes='), 'TraysPage must use /fabric/index.html');
  assert.ok(traysPage.includes('h-[100dvh] w-full sm:h-[85vh] sm:w-[90vw]'), 'TraysPage dialog must support mobile full height/width');
});

test('fabric-public index.html includes mobile responsiveness and iframe-mode optimization', () => {
  const indexHtml = fs.readFileSync(path.join(appDir, 'server', 'fabric-public', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('@media (max-width: 768px)'), 'index.html must include mobile media query');
  assert.ok(indexHtml.includes('body.iframe-mode'), 'index.html must include iframe-mode styles');
  assert.ok(indexHtml.includes('norestock-label'), 'index.html must include touch-friendly norestock label');
  assert.ok(indexHtml.includes('<th style="text-align: center; min-width: 68px;">翻单</th>'), 'index.html table header must include 翻单 column');
  assert.ok(indexHtml.includes('th.freeze-col:nth-of-type(n+4)'), 'index.html must allow columns after col 3 to scroll freely on mobile');
  assert.ok(indexHtml.includes('isMobile ? 3 :'), 'index.html must freeze 3 columns (款式编码, SKC, 成衣颜色) on mobile');
});
