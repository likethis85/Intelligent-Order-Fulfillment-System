// 货盘导出 Excel 要和界面同口径，否则导出的文件「数据缺失」：
//   1) 搭配版块以前只导 6 行（少 成本/倍率、翻单周期、面料情况 三行）
//   2) 多款号坑位里两个款短名不同、翻单文案相同时，只留短名最长的那一份 → 另一个款的翻单记录被吞掉
//   3) 主图只认 cover 款号，主款没图就整格空白；下载失败还会被静默跳过
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.resolve(__dirname, '../src/sections/TraysPage.tsx'), 'utf8');

test('搭配版块导出跟主推版块同样的行', () => {
  assert.ok(
    page.includes('const subRows: FieldRow[] = mainRows.map((f) => ({ ...f, labelRed: true }));'),
    '搭配版块必须复用主推的字段行，否则导出比界面少 成本/倍率、翻单周期、面料情况',
  );
  const subRowsStart = page.indexOf('const subRows: FieldRow[]');
  const subRowsBody = page.slice(subRowsStart, subRowsStart + 260);
  assert.ok(!/label: '库存情况\(主仓\)'/.test(subRowsBody), '搭配版块不应再手写一份精简字段');
});

test('多款号的翻单记录不再合并丢失', () => {
  const fnStart = page.indexOf('function restockCellText(');
  const fnEnd = page.indexOf('\nasync function exportTrayLayoutExcel', fnStart);
  const fn = page.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
  assert.ok(fn.includes('const allSameShort ='), '要区分「短名相同」和「短名不同」');
  assert.ok(fn.includes('if (!allSameShort) {'), '短名不同时每个款号的翻单行都要保留');
  const branch = fn.slice(fn.indexOf('if (!allSameShort) {'), fn.indexOf('const best = group.reduce'));
  assert.ok(branch.includes('const dedupedLines = new Set<string>();'), '短名不同的分支按每个款号重建带前缀的翻单行');
  assert.ok(branch.includes('`${short} ${line}`'), '每个款号的行都要带自己的短名前缀');
});

test('主图在主款没图时退到同坑位其它款号', () => {
  const fnStart = page.indexOf('function pidImgUrl(');
  const fn = page.slice(fnStart, fnStart + 900);
  assert.ok(
    fn.includes('const candidates = [coverPid, ...look.pids.filter((pid) => pid !== coverPid)];'),
    '主款（多为裤子/配件）没图时要用同坑位其它款号的图，否则整格空白',
  );
  assert.ok(fn.includes('.find((x) => x?.img)'), '按顺序找第一个有图的款号');
});

test('自传主图也走 /api/image-proxy（直连 OSS 会被 credentials + ACAO:* 判成 CORS 失败）', () => {
  assert.ok(page.includes('function proxiedImageUrl('), '所有远程图要统一经过代理');
  const fnStart = page.indexOf('function pidImgUrl(');
  const fn = page.slice(fnStart, fnStart + 900);
  assert.ok(fn.includes('const userUrl = proxiedImageUrl(uImg);'), '自传主图（OSS 直链）必须走代理，否则整批空白');
  assert.ok(fn.includes('return proxiedImageUrl(String(p.img));'), '商品图同样走代理，不区分来源');
  assert.ok(
    !/return normUser;/.test(fn),
    '自传主图不能再直接返回 OSS 直链：导出用 authenticatedFetch（credentials: include），跨域直连必然失败',
  );
});

test('图片代理白名单包含抖音店铺图床', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server/index.js'), 'utf8');
  assert.ok(
    /ALLOWED_IMAGE_HOSTS[\s\S]{0,300}ecombdstatic/.test(server),
    '领猫同步的抖音店商品图在 lf3-cm.ecombdstatic.com，不在白名单会被 403 挡掉',
  );
});

test('主图下载失败会重试，并把失败数量告诉用户', () => {
  assert.ok(page.includes('const IMG_FETCH_TIMEOUT_MS = 12_000;'), '单张图超时放宽到 12s');
  assert.ok(page.includes('const IMG_FETCH_ATTEMPTS = 2;'), '失败要再试一次');
  assert.ok(page.includes('async function fetchImgOnce('), '重试包在 fetchImg 外层，单次逻辑独立');
  assert.ok(page.includes("console.warn('[导出] 图片下载失败（已重试）:', url);"), '最终失败要留日志');
  assert.ok(
    page.includes('toast.warning(`${failedImgCount} 张主图下载失败已跳过'),
    '导出结束要提示有多少张图没拉下来，而不是静默跳过',
  );
});
