import { chromium } from '@playwright/test';
const OUT = process.argv[2]; const paths = process.argv.slice(3);
const APP = 'http://127.0.0.1:3200';
const O = `${APP}/o/1bfed2e0-1de8-52d5-9352-0cfd7e27a5e1`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ locale: 'es-CO', timezoneId: 'America/Caracas', viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(`${APP}/login`);
await p.getByLabel('Correo').fill('owner@demo.fluvia.test');
await p.getByLabel('Contraseña').fill('demo-owner-password');
await p.locator('form button[type="submit"]').click();
await p.waitForURL((u) => !u.pathname.startsWith('/login'));
for (const spec of paths) {
  const [path, w] = spec.split('@');
  const width = Number(w || 1440);
  await p.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await p.goto(`${O}${path}`); await p.waitForLoadState('networkidle');
  const name = (path.replace(/[^a-z0-9]+/gi, '_') || 'home') + '-' + width;
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const sw = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(name, 'hscroll', sw);
}
await b.close();
