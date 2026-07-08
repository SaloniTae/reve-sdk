// src/types/index.ts

/**
 * Authentication options for the Reve AI SDK
 */
export interface AuthOptions {
  authorization: string;
  cookie: string;
}

export interface ReveAIOptions {
  auth: AuthOptions;
  projectId?: string;
  /**
   * Base URL for the Reve AI API
   * @default "https://app.reve.com"
   */
  baseUrl?: string;
  timeout?: number;
  maxPollingAttempts?: number;
  pollingInterval?: number;
  verbose?: boolean;
  customHeaders?: Record<string, string>;
}

export interface GenerateImageOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  batchSize?: number;
  
  /**
   * Model to use for generation
   * @default "unified-v1/prod/20260702-182131"
   */
  model?: string;
  enhancePrompt?: boolean;
}

export interface GenerateImageResult {
  imageUrls: string[];
  seed: number;
  completedAt: Date;
  prompt: string;
  enhancedPrompt?: string;
  enhancedPrompts?: string[];
  negativePrompt?: string;
}

export enum GenerationStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum ReveAIErrorType {
  AUTHENTICATION_ERROR = 'authentication_error',
  API_ERROR = 'api_error',
  REQUEST_ERROR = 'request_error',
  TIMEOUT_ERROR = 'timeout_error',
  GENERATION_ERROR = 'generation_error',
  POLLING_ERROR = 'polling_error',
  UNEXPECTED_RESPONSE = 'unexpected_response',
  UNKNOWN_ERROR = 'unknown_error',
}

export class ReveAIError extends Error {
  type: ReveAIErrorType;
  statusCode?: number;
  
  constructor(message: string, type: ReveAIErrorType = ReveAIErrorType.UNKNOWN_ERROR, statusCode?: number) {
    super(message);
    this.name = 'ReveAIError';
    this.type = type;
    this.statusCode = statusCode;
  }
}
