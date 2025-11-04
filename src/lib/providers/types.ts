/**
 * The one seam between the pipeline and a model. Bedrock is primary, the direct
 * Anthropic API is a one-file fallback, and the recorded provider replays
 * fixtures so tests and CI never touch a network or a bill.
 */

export interface ModelRequest {
  system: string;
  user: string;
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
