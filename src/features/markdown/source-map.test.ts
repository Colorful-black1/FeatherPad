import { expect, it } from 'vitest';
import { Marked } from 'marked';
import { blockAtSource, headingAnchor, headingLocations, topLevelSourceRanges } from './source-map';

it('maps ATX H1–H6 and setext/quoted headings without treating fenced syntax as headings', () => {
  const source = '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\n> ## 引用\n\nSetext\n======\n\n```md\n# 代码\n```\n';
  const locations = headingLocations(source);
  expect(locations.map(item => item.level)).toEqual([1, 2, 3, 4, 5, 6, 2, 1]);
  expect(locations[6]!.from).toBe(source.indexOf('## 引用'));
  const tokens = new Marked().lexer(source);
  const ranges = topLevelSourceRanges(source, tokens)!;
  expect(ranges).not.toBeNull();
  for (const [index, range] of ranges.entries()) if (range) expect(source.slice(range.from, range.to)).toBe(tokens[index]!.raw);
});

it('creates deterministic, collision-free Unicode anchors including duplicate and empty titles', () => {
  const used = new Set<string>();
  expect(['中文 标题', '中文 标题', '中文-标题-2', '', '', 'ＡＢＣ'].map(text => headingAnchor(text, used)))
    .toEqual(['中文-标题', '中文-标题-2', '中文-标题-2-2', 'section', 'section-2', 'abc']);
});

it('rejects mismatched raw maps and locates visible blocks without proportional document scrolling', () => {
  expect(topLevelSourceRanges('# actual', [{ type: 'heading', raw: '# stale' }])).toBeNull();
  const blocks = [{ from: 0, to: 20 }, { from: 30, to: 50 }, { from: 70, to: 90 }];
  expect(blockAtSource(blocks, 60)).toEqual(blocks[1]);
  expect(blockAtSource(blocks, 0)).toEqual(blocks[0]);
  expect(blockAtSource([], 0)).toBeNull();
});
