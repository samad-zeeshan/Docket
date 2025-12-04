/**
 * Build the user message content shared by the Bedrock and Anthropic providers.
 * Anthropic on either transport takes the same content shape: a plain string, or
 * an array of image and text blocks.
 */
import type { ModelRequest } from './types';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ContentBlock = TextBlock | ImageBlock;

// A plain string when there is no image, which keeps the text path and every
// recorded fixture unchanged. Otherwise the images lead and the prompt follows,
// which is the ordering the model reads best.
export function userContent(request: ModelRequest): string | ContentBlock[] {
  if (!request.images || request.images.length === 0) return request.user;
  return [
    ...request.images.map(
      (img): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } }),
    ),
    { type: 'text', text: request.user },
  ];
}
