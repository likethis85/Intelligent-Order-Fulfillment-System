// 有头模式驱动 WPS 界面：菜单 → 导出为 → xlsx，拦截下载
import { chromium } from 'playwright-core';
import fs from 'fs';

const PROFILE = process.env.HOME + '/.kdocs-auth-profile';
const LINK = 'cknMsjY1zPlI';
const OUT = process.env.HOME + '/.claude/jobs/56bed02d/tmp/kdocs-dump';
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('download', (d) => {
  const p = `${OUT}/${d.suggestedFilename() || 'export.xlsx'}`;
  d.saveAs(p).then(() => { console.log('✓ 下载已保存:', p); }).catch((e) => console.log('下载保存失败:', e.message));
});

console.log('打开文档…');
await page.goto(`https://www.kdocs.cn/l/${LINK}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(10000);
fs.writeFileSync(`${OUT}/shot-editor.png`, await page.screenshot());

// 找左上角汉堡菜单按钮（☰，文档名左侧）
let clicked = false;
for (const sel of ['button[aria-label="菜单"]', '[aria-label="菜单"]', 'button:has-text("☰")']) {
  const el = page.locator(sel).first();
  if (await el.count() > 0) { await el.click(); clicked = true; console.log('菜单 selector:', sel); break; }
}
if (!clicked) {
  // 兜底：直接点坐标（窗口左上角 ~96,20 的汉堡图标）
  await page.mouse.click(96, 20);
  console.log('菜单用坐标点击');
}
await page.waitForTimeout(2000);
fs.writeFileSync(`${OUT}/shot-menu.png`, await page.screenshot());

// 菜单面板里点「下载」（直接下载原始 xlsx）
const exportItem = page.getByText('下载', { exact: true }).first();
if (await exportItem.count() === 0) {
  console.log('菜单里没找到「下载」，截图已存 shot-menu.png');
  await ctx.close(); process.exit(1);
}
await exportItem.click();
console.log('已点「下载」，等待下载事件…');
await page.waitForTimeout(10000);
fs.writeFileSync(`${OUT}/shot-after-download.png`, await page.screenshot());
await ctx.close();
console.log('完成');
process.exit(0);

await ctx.close();
console.log('完成');
process.exit(0);
