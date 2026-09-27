import type { Page } from '@playwright/test';

/**
 * Sign-in is PIN first: on a browser that is not a registered device the screen offers an emailed
 * link. Support and test accounts use the email-and-password form behind a link; open it.
 */
export async function usePasswordSignIn(page: Page): Promise<void> {
  const link = page.getByRole('button', { name: 'Sign in with email and password' });
  await link
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => link.click())
    .catch(() => undefined);
}
