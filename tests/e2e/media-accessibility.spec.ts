import { expect, test } from './test-fixture';

function contrast(foreground: string, background: string) {
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(channel => {
      const normalized = Number(channel) / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    if (!channels || channels.length !== 3) throw new Error(`Expected an RGB browser color: ${value}`);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const left = luminance(foreground); const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test('browser AX exposes save state and dirty risk while cursor metrics remain readable without live announcements', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+n');
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  await editor.focus();
  await page.keyboard.insertText('读屏标签😀');
  const tab = page.getByRole('tab', { name: /无标题 1/ });
  await expect(tab).toHaveAttribute('aria-description', '固定标签；有未保存修改');
  await expect(page.getByRole('button', { name: '关闭 无标题 1，有未保存修改', exact: true })).toBeVisible();
  const status = page.getByRole('status', { name: '应用状态', exact: true });
  const metrics = page.getByRole('group', { name: '光标与字数', exact: true });
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveAttribute('aria-atomic', 'false');
  await expect(metrics).toHaveAttribute('aria-live', 'off');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await expect(metrics).toContainText('行 1，列 2');
  await expect(status).toContainText('未保存修改');
  const session = await page.context().newCDPSession(page);
  const tree = await session.send('Accessibility.getFullAXTree');
  const statusNode = tree.nodes.find(node => node.role?.value === 'status' && node.name?.value === '应用状态');
  expect(statusNode?.properties?.find(property => property.name === 'live')?.value.value).toBe('polite');
  expect(statusNode?.properties?.find(property => property.name === 'atomic')?.value.value).toBe(false);
  expect(tree.nodes.some(node => node.role?.value === 'group' && node.name?.value === '光标与字数')).toBe(true);
  await session.detach();
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(tab).toHaveAttribute('aria-description', '固定标签；没有未保存修改');
  await expect(page.getByRole('button', { name: '关闭 无标题 1', exact: true })).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`browser forced colors preserve contrast, search markers and keyboard focus with ${colorScheme} system colors`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active', colorScheme });
    await page.goto('/');
    await page.keyboard.press('Control+n');
    const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
    await editor.focus();
    await page.keyboard.insertText('one one');
    const colors = await editor.evaluate(element => ({
      text: getComputedStyle(element).color,
      background: getComputedStyle(element.closest('.cm-editor')!).backgroundColor,
    }));
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByRole('button', { name: '已固定', exact: true })).toHaveCSS('opacity', '1');
    await page.keyboard.press('Control+f');
    const query = page.getByRole('textbox', { name: '查找内容', exact: true });
    await query.fill('one');
    await expect(page.locator('.cm-searchMatch')).toHaveCount(2);
    const matchColors = await page.locator('.cm-searchMatch-current').evaluate(element => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor, adjustment: style.forcedColorAdjust,
        outline: style.outlineStyle, width: style.outlineWidth };
    });
    expect(contrast(matchColors.text, matchColors.background)).toBeGreaterThanOrEqual(4.5);
    expect(matchColors.adjustment).toBe('none');
    expect(matchColors.outline).toBe('solid');
    expect(Number.parseFloat(matchColors.width)).toBeGreaterThanOrEqual(2);
    await expect(query).toBeFocused();
    const focus = await query.evaluate(element => {
      const style = getComputedStyle(element);
      return { color: style.outlineColor, background: style.backgroundColor, style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(focus.style).toBe('solid');
    expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
    expect(contrast(focus.color, focus.background)).toBeGreaterThanOrEqual(3);
    const primary = await page.getByRole('button', { name: /^全部替换/ }).evaluate(element => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor, adjustment: style.forcedColorAdjust };
    });
    expect(contrast(primary.text, primary.background)).toBeGreaterThanOrEqual(4.5);
    expect(primary.adjustment).toBe('none');
    await page.screenshot({ path: test.info().outputPath(`forced-colors-${colorScheme}.png`) });
  });
}

test('reduced-motion media leaves editing and region navigation usable without active CSS animations', async ({ page }) => {
  const motionMilliseconds = () => page.evaluate(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--motion').trim();
    return Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.keyboard.press('Control+n');
  const editor = page.getByRole('textbox', { name: '文档内容', exact: true });
  await editor.focus();
  await page.keyboard.insertText('减少动画');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect(await motionMilliseconds()).toBe(0);
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  await expect(page.getByRole('button', { name: '切换资源管理器', exact: true })).toHaveCSS('transition-duration', '0s');
  await page.keyboard.press('F6');
  await expect(page.getByRole('status', { name: '应用状态', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await motionMilliseconds()).toBe(100);
});
