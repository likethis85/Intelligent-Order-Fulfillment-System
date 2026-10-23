import { chromium } from 'playwright-core';

async function testPage() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });

  const url = 'http://203.205.89.231:3700/fabric/sales.html?iframe=1&pids=MD21FW035';
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'd:/Marius/ai/Intelligent-Order-Fulfillment-System/app/scripts/sales_page_test.png' });
  console.log('Screenshot saved to sales_page_test.png');
  await browser.close();
}

testPage().catch(console.error);
