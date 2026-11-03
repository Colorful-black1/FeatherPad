import { describe, expect, it } from 'vitest';
import { DocumentRegistry } from '../editor/documents';
import { markdownTasks, toggleMarkdownTask } from './task-mapping';

describe('position-bound Markdown tasks', () => {
  it('distinguishes duplicate tasks, nested quote/list tasks and fenced or inline lookalikes', () => {
    const source = '- [ ] 重复\n> - [X] 重复\n>   - [x] 嵌套\n\n```\n- [ ] 非任务\n```\n\n`- [ ] 非任务`';
    const tasks = markdownTasks(source);
    expect(tasks.map(task => source.slice(task.from, task.to))).toEqual([' ', 'X', 'x']);
    expect(tasks.map(task => task.checked)).toEqual([false, true, true]);
    expect(new Set(tasks.map(task => task.from)).size).toBe(3);
  });

  it('rejects stale and forged offsets without changing buffer or version', () => {
    const registry = new DocumentRegistry();
    const id = registry.createUntitled();
    const record = registry.getDocument(id)!;
    registry.commit(id, [record.state.update({ changes: { from: 0, insert: '- [ ] task' } })]);
    const version = registry.getDocument(id)!.summary.version;
    const task = markdownTasks('- [ ] task')[0]!;
    expect(toggleMarkdownTask(registry, id, version - 1, task).ok).toBe(false);
    expect(toggleMarkdownTask(registry, id, version, { ...task, from: 0, to: 1 }).ok).toBe(false);
    expect(registry.getDocument(id)!.summary.version).toBe(version);
    expect(registry.getDocument(id)!.state.doc.toString()).toBe('- [ ] task');
  });
});
