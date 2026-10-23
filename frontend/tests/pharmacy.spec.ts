import { expect, test } from '@playwright/test';

// Exercise all four views against the real seeded API and persisted ledger.
test('search, inspect history, capture and find a dispense', async ({ page }) => {
  await page.goto('/medicines');
  await expect(page.getByRole('link', { name: 'SEED-0000', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('link', { name: 'SEED-0020', exact: true })).toBeVisible();
  await page.getByLabel('Search medicines').fill('SEED-0000');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: 'SEED-0000', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rule history' })).toBeVisible();
  await expect(page.locator('.timeline li')).toHaveCount(4);
  await expect(page.getByText('In force now', { exact: true })).toHaveCount(1);
  await page.getByRole('link', { name: 'Capture this medicine' }).click();
  const patient = `browser-${Date.now()}`;
  await page.getByLabel('Patient reference').fill(patient);
  await page.getByLabel('Quantity', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Record dispense' }).click();
  await expect(page.getByRole('status')).toContainText('Dispense recorded');
  await page.getByRole('link', { name: 'View patient ledger' }).click();
  await expect(page.getByRole('cell', { name: 'SEED-0000' })).toBeVisible();
});

// Render every reason beside its field without dropping multiple quantity failures.
test('show all simultaneous server rejections', async ({ page }) => {
  await page.route('**/api/v1/dispenses', route => route.fulfill({ status: 422, json: { errors: [
    { code: 'single_quantity_limit', field: 'quantity', message: 'Single limit exceeded.' },
    { code: 'rolling_quantity_limit', field: 'quantity', message: 'Rolling limit exceeded.' },
    { code: 'authorisation_required', field: 'authorisation_ref', message: 'Authorisation required.' },
  ] } }));
  await page.goto('/capture');
  await page.getByLabel('Medicine code').fill('SEED-0000');
  await page.getByLabel('Patient reference').fill('opaque');
  await page.getByRole('button', { name: 'Record dispense' }).click();
  await expect(page.locator('#quantity-errors')).toContainText('Single limit exceeded.');
  await expect(page.locator('#quantity-errors')).toContainText('Rolling limit exceeded.');
  await expect(page.locator('#authorisation_ref-errors')).toContainText('Authorisation required.');
});

// A lost response must retain the same payload and key, including after a page reload.
test('retry uncertain submissions with the original key', async ({ page }) => {
  const payloads: Record<string, unknown>[] = [];
  await page.route('**/api/v1/dispenses', async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await route.abort('failed');
    else await route.fulfill({ status: 201, json: { id: 99, ...payloads[0] } });
  });
  await page.goto('/capture');
  await page.getByLabel('Medicine code').fill('SEED-0000');
  await page.getByLabel('Patient reference').fill('retry-patient');
  await page.getByRole('button', { name: 'Record dispense' }).click();
  await expect(page.getByText('Outcome unknown. Retry the same request to confirm it.')).toBeVisible();
  await expect(page.getByLabel('Quantity', { exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await expect(page.getByRole('status')).toContainText('Dispense recorded');
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});

// Changing a definitively rejected payload represents a new operation, not a key conflict.
test('use a new key after correcting a rejected form', async ({ page }) => {
  const keys: string[] = [];
  await page.route('**/api/v1/dispenses', route => {
    keys.push(route.request().postDataJSON().idempotency_key);
    return route.fulfill({ status: 422, json: { errors: [
      { code: 'single_quantity_limit', field: 'quantity', message: 'Reduce quantity.' },
    ] } });
  });
  await page.goto('/capture');
  await page.getByLabel('Medicine code').fill('SEED-0000');
  await page.getByLabel('Patient reference').fill('corrected-patient');
  await page.getByLabel('Quantity', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Record dispense' }).click();
  await expect(page.getByText('Reduce quantity.')).toBeVisible();
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Record dispense' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

// A stale response from an earlier search must never replace the latest results.
test('cancel stale catalogue searches', async ({ page }) => {
  await page.route('**/api/v1/medicines?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'slow') await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { items: [{ code: query || 'initial', name: query || 'Initial', form: 'tablet', strength_value: 1, strength_unit: 'unit', is_active: true }], next_cursor: null } });
  });
  await page.goto('/medicines');
  await page.getByLabel('Search medicines').fill('slow');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search medicines').fill('latest');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: 'latest', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'slow', exact: true })).toHaveCount(0);
});

// A failed page load must be recoverable without losing the current filters.
test('retry a failed catalogue page', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/medicines?*', route => {
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 500, json: { errors: [
      { code: 'internal_error', field: 'body', message: 'The request could not be completed.' },
    ] } });
    return route.fulfill({ json: { items: [{ code: 'RECOVERED', name: 'Recovered', form: 'tablet', strength_value: 1, strength_unit: 'unit', is_active: true }], next_cursor: null } });
  });
  await page.goto('/medicines');
  await expect(page.getByRole('alert')).toContainText('could not be completed');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('link', { name: 'RECOVERED', exact: true })).toBeVisible();
});

// History navigation between two medicines reuses the view and must reload its data.
test('reload medicine detail when the route code changes', async ({ page }) => {
  await page.goto('/medicines/SEED-0000');
  await expect(page.getByText('SEED-0000 ·')).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/medicines/SEED-0001');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('SEED-0001 ·')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Generated medicine 0001' })).toBeVisible();
});

// The patient filter lives in the URL so reloads and the main navigation stay consistent.
test('keep the ledger filter in the URL', async ({ page }) => {
  await page.goto('/ledger');
  await page.getByLabel('Patient reference').fill('patient-0000');
  await page.getByRole('button', { name: 'Find dispenses' }).click();
  await expect(page).toHaveURL(/patient=patient-0000/);
  await expect(page.getByRole('cell', { name: 'SEED-0000' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name: 'SEED-0000' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Patient ledger' }).click();
  await expect(page.getByLabel('Patient reference')).toHaveValue('');
  await expect(page.getByRole('table')).toHaveCount(0);
});

// Loading placeholders must reserve the space of the loaded page so content below does not jump.
test('keep layout stable while the catalogue loads', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 823 });
  await page.addInitScript(() => {
    (window as unknown as { cls: number }).cls = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) (window as unknown as { cls: number }).cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/v1/medicines?*', async route => {
    // Hold the response so the placeholder is painted before the real rows replace it.
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto('/medicines');
  await expect(page.getByRole('link', { name: 'SEED-0019', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { cls: number }).cls)).toBeLessThan(0.1);
});

// Rule editor tests run against a mocked medicine so the seeded history is never changed.
const medicine = { code: 'MOCK-001', name: 'Mock medicine', form: 'tablet', strength_value: '10', strength_unit: 'mg', is_active: true };
const april = { id: 1, effective_from: '2026-04-09T22:00:00Z', effective_to: null as string | null,
  max_quantity_per_dispense: 60, max_quantity_per_30_days: 120, requires_authorisation: false, is_current: true };
const businessToday = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Serve a medicine whose history changes once a rule is posted. */
async function mockRules(page: import('@playwright/test').Page, onPost: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  let rules = [april];
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/v1/medicines/MOCK-001', route =>
    route.fulfill({ json: { ...medicine, current_rule: rules.find(rule => rule.is_current) ?? null } }));
  await page.route('**/api/v1/medicines/MOCK-001/rules', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { items: rules } });
    const body = route.request().postDataJSON();
    posts.push(body);
    const result = onPost(body);
    if (result.status === 201) {
      const start = `${body.effective_from}T00:00:00+02:00`;
      rules = [{ ...april, effective_to: start, is_current: false }, { ...(result.json as typeof april), is_current: true }];
    }
    return route.fulfill(result);
  });
  return posts;
}

// 10 Apr 2026 → open ended, in force, 60 / 120 / not required: update to 30 per dispense through the modal.
test('update the rule in force from 60 to 30 per dispense', async ({ page }) => {
  const posts = await mockRules(page, body => ({ status: 201, json: { ...april, id: 2,
    effective_from: new Date(`${body.effective_from}T00:00:00+02:00`).toISOString(), max_quantity_per_dispense: 30 } }));
  await page.goto('/medicines/MOCK-001');
  const current = page.locator('.timeline li.current');
  await expect(current).toContainText('10 Apr 2026');
  await expect(current).toContainText('open ended');
  await expect(current).toContainText('In force now');
  await expect(current).toContainText('Per dispense 60');
  await expect(current).toContainText('Per 30 days 120');
  await expect(current).toContainText('Authorisation not required');

  await page.getByRole('button', { name: 'Update rule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Update rule' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Per dispense')).toHaveValue('60');
  await expect(dialog.getByLabel('Per 30 days')).toHaveValue('120');
  await expect(dialog.getByLabel('Authorisation required')).not.toBeChecked();
  await expect(dialog.getByLabel(/Effective from/)).toHaveValue(businessToday());
  await expect(dialog.getByRole('button', { name: 'Save new version' })).toBeDisabled();

  await dialog.getByLabel('Per dispense').fill('30');
  await expect(dialog.locator('.change-summary')).toContainText('Per dispense 60');
  await expect(dialog.locator('.change-summary')).toContainText('30');
  await dialog.getByRole('button', { name: 'Save new version' }).click();

  await expect(dialog).toBeHidden();
  expect(posts).toEqual([{ effective_from: businessToday(), max_quantity_per_dispense: 30,
    max_quantity_per_30_days: 120, requires_authorisation: false }]);
  await expect(page.locator('.alert.success')).toContainText('Rule saved: 30 per dispense, 120 per 30 days');
  await expect(page.locator('.timeline li')).toHaveCount(2);
  await expect(page.locator('.timeline li').first()).toContainText('Per dispense 60');
  await expect(page.locator('.timeline li').first()).not.toContainText('open ended');
  await expect(current).toContainText('open ended');
  await expect(current).toContainText('Per dispense 30');
  await expect(current).toContainText('Per 30 days 120');
  await expect(current).toContainText('Authorisation not required');
  await expect(page.locator('.stat').first()).toContainText('30');
});

// Server rejections stay in the modal, beside their fields, with the entered values intact.
test('show rule update rejections beside their fields', async ({ page }) => {
  await mockRules(page, () => ({ status: 409, json: { errors: [
    { code: 'rule_start_conflict', field: 'effective_from', message: 'A rule already starts on this date.' },
  ] } }));
  await page.goto('/medicines/MOCK-001');
  await page.getByRole('button', { name: 'Update rule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Update rule' });
  await dialog.getByLabel('Per dispense').fill('45');
  await dialog.getByRole('button', { name: 'Save new version' }).click();
  await expect(dialog.locator('#effective_from-errors')).toContainText('A rule already starts on this date.');
  await expect(dialog.getByLabel('Per dispense')).toHaveValue('45');
});

// Obvious mistakes are caught before any request is sent.
test('block a 30-day limit below the per-dispense limit locally', async ({ page }) => {
  const posts = await mockRules(page, () => ({ status: 500, json: { errors: [] } }));
  await page.goto('/medicines/MOCK-001');
  await page.getByRole('button', { name: 'Update rule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Update rule' });
  await dialog.getByLabel('Per dispense').fill('150');
  await dialog.getByRole('button', { name: 'Save new version' }).click();
  await expect(dialog.locator('#max_quantity_per_30_days-errors')).toContainText('at least the per-dispense limit');
  expect(posts).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
