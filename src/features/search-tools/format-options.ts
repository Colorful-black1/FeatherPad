export const sqlDialects = ['sql', 'sqlite', 'postgresql', 'mysql'] as const;
export type SqlDialect = typeof sqlDialects[number];
