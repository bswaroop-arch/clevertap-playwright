// Opens an authenticated Chromium window for manual recording / inspection.
// Use Playwright Inspector or DevTools to capture selectors as you click.
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();
  await page.goto('https://eu1.dashboard.clevertap.com/886-894-RK5Z/campaigns/campaign/new/whatsapp');

  console.log('\nBrowser open. Create one campaign end-to-end with personalized media URL.');
  console.log('When done, press Enter here to close.\n');

  await new Promise(r => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', r);
  });

  await browser.close();
  process.exit(0);
})();
