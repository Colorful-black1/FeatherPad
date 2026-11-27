import { expect, test } from './test-fixture';

test('settings about shows the 1.0.0 version and explains that updater signing is not configured yet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('tab', { name: '系统', exact: true }).click();
  const about = dialog.getByRole('region', { name: '关于轻羽', exact: true });
  await expect(about).toContainText('v1.0.0');
  await expect(about.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled();
  await expect(about).toContainText('自动更新尚未启用');
  await expect(about).toContainText('安装版启动时自动检查 GitHub Releases');
  await expect(page.getByRole('button', { name: /发现新版本/ })).toHaveCount(0);
});
