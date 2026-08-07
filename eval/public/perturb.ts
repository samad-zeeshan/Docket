/**
 * Graded visual damage for the robustness suite: blur, rotation, crop, darkening and JPEG compression, three levels each.
 */
import sharp from 'sharp';

export const PERTURBATIONS = {
  blur: [1, 2, 4],
  rotate: [5, 10, 20],
  crop: [0.03, 0.06, 0.1],
  dark: [0.6, 0.4, 0.25],
  jpeg: [30, 15, 5],
} as const;

export type PerturbationKind = keyof typeof PERTURBATIONS;

export function variantName(kind: PerturbationKind, level: 1 | 2 | 3): string {
  return `${kind}-${level}`;
}

export function allVariants(): string[] {
  return (Object.keys(PERTURBATIONS) as PerturbationKind[]).flatMap((k) => [1, 2, 3].map((l) => variantName(k, l as 1 | 2 | 3)));
}

export async function perturb(image: Buffer, variant: string): Promise<Buffer> {
  if (variant === 'clean') return image;
  const [kind, levelText] = variant.split('-') as [PerturbationKind, string];
  const amount = PERTURBATIONS[kind]?.[Number(levelText) - 1];
  if (amount === undefined) throw new Error(`unknown variant ${variant}`);
  const img = sharp(image);
  switch (kind) {
    case 'blur':
      return img.blur(amount).jpeg({ quality: 90 }).toBuffer();
    case 'rotate':
      // White fill, because a receipt photographed at an angle sits on a table,
      // and black corners would add a cue a real photo does not have.
      return img.rotate(amount, { background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    case 'crop': {
      const { width = 0, height = 0 } = await img.metadata();
      const dx = Math.round(width * amount);
      const dy = Math.round(height * amount);
      return img.extract({ left: dx, top: dy, width: width - 2 * dx, height: height - 2 * dy }).jpeg({ quality: 90 }).toBuffer();
    }
    case 'dark':
      return img.linear(amount, 0).jpeg({ quality: 90 }).toBuffer();
    case 'jpeg':
      return img.jpeg({ quality: amount }).toBuffer();
  }
}
