/**
 * The two public receipt sets, pinned to exact files by sha256, with their licences.
 */

export interface SourceFile {
  url: string;
  name: string;
  sha256: string;
  split: string;
}

export interface Source {
  id: 'sroie' | 'cord';
  title: string;
  licence: string;
  home: string;
  // Neither set labels a currency. Every SROIE receipt is Malaysian and every
  // CORD receipt Indonesian, so the currency is a property of the set, not a label.
  currency: string;
  files: SourceFile[];
}

const HF = 'https://huggingface.co/datasets';

export const SOURCES: Source[] = [
  {
    id: 'sroie',
    title: 'ICDAR 2019 SROIE (scanned receipts, Malaysia)',
    licence: 'CC BY 4.0 as stated by the mirror jsdnrs/ICDAR2019-SROIE',
    home: 'https://rrc.cvc.uab.es/?ch=13',
    currency: 'MYR',
    files: [
      { split: 'train', name: 'sroie-train.parquet', url: `${HF}/jsdnrs/ICDAR2019-SROIE/resolve/main/data/train-00000-of-00001.parquet`, sha256: 'b18c16b4d8481e5e4537a1700e4616907fe4acd92d6362a7e430b0e866213887' },
      { split: 'test', name: 'sroie-test.parquet', url: `${HF}/jsdnrs/ICDAR2019-SROIE/resolve/main/data/test-00000-of-00001.parquet`, sha256: '04f8f31b45944cc6e6459a7a95c851a721fc93ffec0a5c29ece9ded734a684c2' },
    ],
  },
  {
    id: 'cord',
    title: 'CORD v2 (receipt photos, Indonesia)',
    licence: 'CC BY 4.0, naver-clova-ix/cord-v2',
    home: 'https://github.com/clovaai/cord',
    currency: 'IDR',
    files: [
      { split: 'train', name: 'cord-train-0.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/train-00000-of-00004-b4aaeceff1d90ecb.parquet`, sha256: 'da3994eee1bf9bd3c57f0d53a72c3a6812c8696c5ba26245987949ddf73483cc' },
      { split: 'train', name: 'cord-train-1.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/train-00001-of-00004-7dbbe248962764c5.parquet`, sha256: 'cce4def16a0d6a6c75f80be712f7494c56c318a8829b712f5c62650155c9e58e' },
      { split: 'train', name: 'cord-train-2.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/train-00002-of-00004-688fe1305a55e5cc.parquet`, sha256: '591e2db8fe8b1d364b054f46e8c375b7f00e72578914ba46a573b6858162cab2' },
      { split: 'train', name: 'cord-train-3.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/train-00003-of-00004-2d0cd200555ed7fd.parquet`, sha256: '1ffd9de8d6fbcee7630fd4cdfedff05b9b7fabc0fae4fc17557c5fe7cf178748' },
      { split: 'validation', name: 'cord-validation.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/validation-00000-of-00001-cc3c5779fe22e8ca.parquet`, sha256: '0d0f6dac11fdcc549de2746aa9f53136a3bc22a2a1aff2b0b847f7622ad60c15' },
      { split: 'test', name: 'cord-test.parquet', url: `${HF}/naver-clova-ix/cord-v2/resolve/main/data/test-00000-of-00001-9c204eb3f4e11791.parquet`, sha256: '51c65f1788faff392abe2a0b55b023eb23e9be551c509138eaa3a832514224e7' },
    ],
  },
];
