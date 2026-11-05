import type { Locator, Page } from '@playwright/test';

const menuLocations: Readonly<Record<string, readonly [string, string]>> = {
  新窗口: ['文件', '新建窗口'],
  打开文件夹: ['文件', '打开文件夹'],
  另存为: ['文件', '另存为'], 保存副本: ['文件', '保存副本'], 全部保存: ['文件', '全部保存'],
  打开工作区文件: ['文件', '打开工作区文件'], 保存工作区文件: ['文件', '保存工作区文件'],
  '添加根…': ['文件', '添加文件夹…'],
  '添加文件夹…': ['文件', '添加文件夹…'],
  固定标签: ['视图', '固定标签'], 已固定: ['视图', '固定标签'],
  向右拆分: ['视图', '向右拆分编辑器'], 关闭拆分: ['视图', '关闭拆分'],
  重新打开关闭的标签: ['文件', '重新打开关闭的标签'],
  关闭其他: ['视图', '关闭其他标签'], 关闭右侧: ['视图', '关闭右侧标签'], 关闭已保存: ['视图', '关闭已保存标签'],
  后退: ['转到', '导航后退'], 前进: ['转到', '导航前进'], '行:列': ['转到', '跳转到行列'], 大纲: ['转到', '打开当前文档大纲'],
  查找: ['工具', '文件内查找与替换'], 目录搜索: ['工具', '在文件和工作区中查找'],
  '格式化…': ['工具', '格式化文档'], '文本工具…': ['工具', '文本工具'], '比较文件…': ['工具', '双文件对比'],
};

// Follow the same visible menus as a user; assertions still inspect real command
// availability, and business/native mocks remain owned by each scenario.
export async function menuItem(page: Page, previousLabel: string): Promise<Locator> {
  const location = menuLocations[previousLabel];
  if (!location) throw new Error(`Unknown menu action: ${previousLabel}`);
  const [menu, title] = location;
  const trigger = page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  return page.getByRole('menu', { name: menu, exact: true }).getByRole('menuitem', { name: title, exact: true });
}

export async function documentOptions(page: Page): Promise<Locator> {
  const panel = page.locator('.document-options');
  if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click();
  return panel;
}

export async function resumeEditing(page: Page) {
  // Let the options' focus restoration finish before explicitly returning to the
  // buffer, without moving the selection or waiting an arbitrary duration.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await page.locator('.cm-content').first().focus();
}

export async function sidebarSection(page: Page, title: string) {
  const sidebar = page.getByRole('complementary', { name: '资源管理器', exact: true });
  if (await sidebar.count() === 0) await page.getByRole('button', { name: '切换资源管理器', exact: true }).click();
  const section = sidebar.locator('.sidebar-section').filter({ has: page.locator('summary', { hasText: title }) });
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
}
