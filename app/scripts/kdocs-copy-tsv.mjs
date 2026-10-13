// 方案B：不点菜单。表格网格内 Ctrl+A → Ctrl+C，用 pbpaste 读系统剪贴板拿 TSV
// 逐个工作表抓取。注意：会覆盖系统剪贴板内容。
import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';

const PROFILE = process.env.HOME + '/.kdocs-auth-profile';
const LINK = 'cknMsjY1zPlI';
const OUT = process.env.HOME + '/.claude/jobs/56bed02d/tmp/kdocs-dump';
fs.mkdirSync(OUT, { recursive: true });

const SHEETS = ['9-12月核价明细', '1-8月核价明细', '价格'];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null,
});
const page = ctx.pages()[0] || await ctx.newPage();
console.log('打开文档…');
await page.goto(`https://www.kdocs.cn/l/${LINK}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(12000);

for (const sheet of SHEETS) {
  const tab = page.getByText(sheet, { exact: true }).first();
  if (await tab.count() === 0) { console.log('⚠ 没找到工作表:', sheet); continue; }
  await tab.click();
  await page.waitForTimeout(2500);

  // 点一个单元格确保网格获得焦点（用名称框旁边的 fx 区域不行，直接点画布中间）
  await page.mouse.click(500, 300);
  await page.waitForTimeout(500);
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(400);
  await page.keyboard.press('ControlOrMeta+a'); // 有的实现第一次选当前区域，第二次全选
  await page.waitForTimeout(400);
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForTimeout(1500);

  let tsv = '';
  try { tsv = execSync('pbpaste').toString(); } catch {}
  const file = `${OUT}/sheet-${sheet}.tsv`;
  fs.writeFileSync(file, tsv);
  console.log(`✓ ${sheet}: ${tsv.length} 字符, ${tsv.split('\n').length} 行 → ${file}`);
  console.log('  首行:', tsv.split('\n')[0]?.slice(0, 120));
}
await ctx.close();
console.log('完成');
process.exit(0);
