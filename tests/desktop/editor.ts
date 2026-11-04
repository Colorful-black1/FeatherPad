import { documentOptions, resumeEditing } from '../ui-actions';
import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export async function verifyNativeEditor(page: Page, evidence: string) {
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const editor = page.locator('.cm-content');
  const status = page.getByRole('status');
  await editor.focus();
  await page.keyboard.insertText('alpha\nbeta');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(status).toContainText('0 字符');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('alphabeta');
  await editor.focus();
  await page.keyboard.press('Control+y');
  await expect(status).toContainText('0 字符');
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('alphabeta');
  await editor.focus();
  await page.keyboard.press('Control+Home');
  await expect(status).toContainText('行 1，列 1');
  await page.keyboard.press('Control+ArrowRight');
  await expect(status).toContainText('行 1，列 6');
  await page.keyboard.press('Control+a');
  await expect(status).toContainText('已选 10 字符');
  await (await documentOptions(page)).getByRole('combobox', { name: '缩进宽度', exact: true }).selectOption('2'); await resumeEditing(page);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Tab');
  await expect(page.locator('.cm-line')).toHaveText(['  alpha', 'beta']);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-line')).toHaveText(['alpha', 'beta']);

  await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('java'); await resumeEditing(page);
  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('public class Main ');
  await page.keyboard.type('{');
  const publicToken = editor.locator('span').filter({ hasText: 'public' }).first();
  await expect(publicToken).toBeVisible();
  expect(await publicToken.evaluate(element => getComputedStyle(element).color))
    .not.toBe(await editor.evaluate(element => getComputedStyle(element).color));
  await expect(editor).toHaveText('public class Main {}');
  await expect(page.locator('.cm-matchingBracket')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(editor).toHaveText('public class Main ');
  await (await documentOptions(page)).getByRole('checkbox', { name: '自动配对', exact: true }).uncheck(); await resumeEditing(page);
  await page.keyboard.insertText('(');
  await expect(editor).toHaveText('public class Main (');
  await (await documentOptions(page)).getByRole('checkbox', { name: '匹配括号', exact: true }).uncheck(); await resumeEditing(page);
  await page.screenshot({ path: path.join(evidence, 'native-release-editor.png') });

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await editor.focus();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', {
    text: 'zhong', selectionStart: 5, selectionEnd: 5, replacementStart: 0, replacementEnd: 0,
  });
  await session.send('Input.imeSetComposition', {
    text: '中文', selectionStart: 2, selectionEnd: 2, replacementStart: 0, replacementEnd: 5,
  });
  await session.send('Input.insertText', { text: '中文' });
  await expect(editor).toHaveText('中文');
  await page.keyboard.insertText('(');
  await expect(editor).toHaveText('中文()');

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await editor.focus();
  await page.keyboard.insertText('clipboard');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+v');
  await expect(editor).toHaveText('clipboardclipboard');

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await (await documentOptions(page)).getByRole('combobox', { name: '语言模式', exact: true }).selectOption('json'); await resumeEditing(page);
  await editor.focus();
  const syntaxText = '{"a": {"b": 42}}';
  await page.keyboard.insertText(syntaxText);
  // Wait for the actual lazy-loaded grammar before using syntax selection.
  await expect(editor.locator('span').filter({ hasText: '42' }).first()).toBeVisible();
  await page.keyboard.press('Control+Home');
  for (let offset = 0; offset < 13; offset++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+i');
  await expect(status).toContainText('已选 2 字符');
  await page.keyboard.press('Control+i');
  await expect(status).toContainText('已选 7 字符');
  await page.keyboard.press('Control+u');
  await expect(status).toContainText('已选 2 字符');
  await expect(editor).toHaveText(syntaxText);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+Backslash');
  await expect(status).toContainText('行 1，列 17');
  await page.keyboard.press('Control+Shift+Backslash');
  await expect(status).toContainText('行 1，列 1');
  await page.screenshot({ path: path.join(evidence, 'native-selection-and-bracket-jump.png') });

  return {
    statusAndSelectionVerified: true,
    undoRedoAndWordNavigationVerified: true,
    tabWidthVerified: true,
    javaHighlightAndManualSelectionVerified: true,
    bracketPairingAndMatchingVerified: true,
    webView2CompositionInputVerified: true,
    clipboardPasteVerified: true,
    syntaxSelectionGrowAndSelectionUndoShrinkVerified: true,
    matchingBracketKeyboardJumpBothDirectionsVerified: true,
    scope: 'Real Tauri WebView2/CodeMirror; composition events use CDP and do not exercise the OS candidate window',
  };
}
