import { expect, it } from 'vitest';
import { describeFileIcon } from './file-icons';

it('maps common file types to distinct icons and keeps exact-name overrides', () => {
  expect(describeFileIcon('README.md')).toEqual({ shape: 'markdown', color: 'blue' });
  expect(describeFileIcon('notes.txt')).toEqual({ shape: 'text', color: 'grey' });
  expect(describeFileIcon('data.json')).toEqual({ shape: 'braces', color: 'yellow' });
  expect(describeFileIcon('main.ts')).toEqual({ shape: 'code', color: 'blue' });
  expect(describeFileIcon('App.tsx')).toEqual({ shape: 'react', color: 'blue' });
  expect(describeFileIcon('schema.sql')).toEqual({ shape: 'database', color: 'pink' });
  expect(describeFileIcon('package-lock.json')).toEqual({ shape: 'lock', color: 'gold' });
  expect(describeFileIcon('.gitignore')).toEqual({ shape: 'git', color: 'orange' });
  expect(describeFileIcon('.env.local')).toEqual({ shape: 'gear', color: 'yellow' });
  expect(describeFileIcon('Dockerfile')).toEqual({ shape: 'package', color: 'blue' });
  expect(describeFileIcon('LICENSE')).toEqual({ shape: 'text', color: 'grey' });
  expect(describeFileIcon('unknown.zzz')).toEqual({ shape: 'text', color: 'grey' });
});
