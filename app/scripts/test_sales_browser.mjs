import { chromium } from 'playwright-core';
import fs from 'fs';

async function testPage() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({ executablePath: edgePath, headless: true });
  const page = await browser.newPage();

  page.on('response', res => {
    if (res.status() >= 400) {
      console.log('HTTP', res.status(), res.url());
    }
  });

  const url = 'http://203.205.89.231:3700/fabric/sales.html?iframe=1&pids=MD21FW035';
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3000);
  await browser.close();
}

testPage().catch(console.error);
