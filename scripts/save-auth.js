const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://eu1.dashboard.clevertap.com/886-894-RK5Z/main');

  console.log('\nLog in to CleverTap in the browser window (use Google SSO).');
  console.log('Press Enter here once you are fully logged in.\n');

  await new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', resolve);
  });

  await context.storageState({ path: 'auth.json' });
  console.log('Session saved to auth.json');
  await browser.close();
  process.exit(0);
})();
