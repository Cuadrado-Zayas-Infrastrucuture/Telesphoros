import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from '../e2e/helpers';

// The mascot's approved image has a white ground shadow baked in. In the dark theme it sits on the logos' seafoam plate
// (--mark-plate, #DCEBE7); the light theme shows it exactly as before.
const SEAFOAM = 'rgb(220, 235, 231)';
const NONE = 'rgba(0, 0, 0, 0)';
// `filled`: the mascot itself still takes most of its box. A plate that squeezes it to a dot passes every other check.
const plate = (image: Locator) =>
  image.evaluate((element) => {
    const style = getComputedStyle(element);
    const content = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      background: style.backgroundColor,
      radius: style.borderRadius,
      square: Math.abs(element.clientWidth - element.clientHeight) <= 1,
      filled: content / element.clientWidth >= 0.75,
    };
  });
const theme = (page: Page, value: 'dark' | 'light') => page.addInitScript((saved) => window.localStorage.setItem('telesphoros.theme', saved), value);

for (const mode of ['dark', 'light'] as const) {
  test(`workspace mascot and answer avatar: ${mode === 'dark' ? 'round seafoam plate' : 'no plate'} in the ${mode} theme`, async ({ page }) => {
    await theme(page, mode);
    await signInAs(page, 'alice', '/local-workspace');
    const check = async (image: Locator) => {
      await expect(image).toBeVisible();
      const seen = await plate(image);
      if (mode === 'dark') expect(seen).toEqual({ background: SEAFOAM, radius: '50%', square: true, filled: true });
      else expect(seen).toEqual({ background: NONE, radius: '0px', square: false, filled: true });
    };
    // The large mascot shows on the start screen; the avatar beside each answer.
    await check(page.locator('img.one-screen-mascot'));
    await page.getByRole('button', { name: 'Explain this example', exact: true }).click();
    await check(page.locator('img.one-screen-avatar').first());
  });
}

test('chat preview mascot sits on the plate in the dark theme', async ({ page }) => {
  await theme(page, 'dark');
  await signInAs(page, 'alice', '/local-interpretation');
  const image = page.locator('img.mascot-welcome-image').first();
  await expect(image).toBeVisible();
  expect(await plate(image)).toEqual({ background: SEAFOAM, radius: '50%', square: true, filled: true });
});
