export const encodingIds = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'gbk', 'shift_jis', 'big5', 'windows-1252'] as const;
export type EncodingId = typeof encodingIds[number];
export interface EncodingInspection {
  encoding: EncodingId;
  documentVersion: number;
  lossCount: number;
  samples: { offset: number; length: number }[];
  replacementText: string | null;
}
