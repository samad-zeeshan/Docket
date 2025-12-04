/**
 * The one seam between the pipeline and a model. Bedrock is primary, the direct
 * Anthropic API is a one-file fallback, and the recorded provider replays
 * fixtures so tests and CI never touch a network or a bill.
 */

// An image to send alongside the prompt, for extracting from a receipt photo
// rather than born-digital text. Base64 is what both Bedrock and the Anthropic
// API expect on the wire.
export interface ImageInput {
  mediaType: string; // image/png, image/jpeg, image/webp
  dataBase64: string;
}

export interface ModelRequest {
  system: string;
  user: string;
  // When present, the request is multimodal: the images lead the user message and
  // the text follows. Absent for the text path, which keeps its prompt unchanged.
  images?: ImageInput[];
  maxTokens?: number;
}

export interface ModelResult {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResult>;
}
