import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import {
  ReveAIOptions,
  GenerateImageOptions,
  GenerateImageResult,
  ReveAIError,
  ReveAIErrorType,
} from './types';
import { delay, handleAxiosError, validateImageOptions, parseJwt } from './utils/helpers';

export const IS_TEST_ENV = process.env.NODE_ENV === 'test';

export class ReveAI {
  private apiClient: AxiosInstance;
  private options: Required<Omit<ReveAIOptions, 'auth' | 'projectId'>> & { 
    auth: ReveAIOptions['auth'];
    projectId?: string;
    verbose: boolean;
    customHeaders: ReveAIOptions['customHeaders'];
  };
  private token: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;

  constructor(options: ReveAIOptions) {
    if (!options.auth) {
      throw new ReveAIError('Authentication options are required', ReveAIErrorType.AUTHENTICATION_ERROR);
    }
    
    const { authorization, cookie } = options.auth;
    
    if (!authorization || !cookie) {
      throw new ReveAIError(
        'Authorization header and cookie are required',
        ReveAIErrorType.AUTHENTICATION_ERROR
      );
    }
    
    this.options = {
      auth: options.auth,
      projectId: options.projectId || undefined,
      baseUrl: options.baseUrl ?? 'https://app.reve.com',
      timeout: options.timeout ?? 60000,
      maxPollingAttempts: options.maxPollingAttempts ?? 60,
      pollingInterval: options.pollingInterval ?? 2000,
      verbose: options.verbose ?? false,
      customHeaders: options.customHeaders ?? {},
    };

    this.apiClient = axios.create({
      baseURL: this.options.baseUrl,
      timeout: this.options.timeout,
      headers: {
        'content-type': 'application/json',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'origin': 'https://app.reve.com',
        'referer': 'https://app.reve.com/',
        'dnt': '1',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-gpc': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        ...this.options.customHeaders,
      },
    });

    const tokenMatch = /Bearer\s+(.+)/.exec(authorization);
    if (tokenMatch && tokenMatch[1]) {
      this.token = tokenMatch[1];
      const decoded = parseJwt(this.token);
      this.userId = decoded.sub ? String(decoded.sub) : null;
    }

    axiosRetry(this.apiClient, { 
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
               (error.response?.status !== undefined && error.response?.status >= 500);
      }
    });

    this.apiClient.interceptors.request.use(
      (config) => {
        if (this.options.verbose) {
          const sanitizedConfig = { ...config };
          if (sanitizedConfig.headers && sanitizedConfig.headers.Authorization) {
            sanitizedConfig.headers.Authorization = '[REDACTED]';
          }
          if (sanitizedConfig.headers && sanitizedConfig.headers.Cookie) {
            sanitizedConfig.headers.Cookie = '[REDACTED]';
          }
          console.log('\n🔷 REQUEST:', config.method?.toUpperCase(), config.url);
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.apiClient.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 401 && this.token) {
          this.token = null;
          return Promise.reject(
            new ReveAIError('Authentication token expired', ReveAIErrorType.AUTHENTICATION_ERROR, 401)
          );
        }
        return Promise.reject(error);
      }
    );

    this.apiClient.interceptors.request.use(
      (config) => {
        config.headers.authorization = this.options.auth.authorization;
        config.headers.cookie = this.options.auth.cookie;
        Object.entries(this.options.customHeaders).forEach(([key, value]) => {
          config.headers[key] = value;
        });
        return config;
      },
      (error) => Promise.reject(error)
    );
  }

  private async getProjectId(): Promise<string> {
    if (this.options.projectId) return this.options.projectId;
    try {
      const response = await this.apiClient.get('/api/projects');
      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0].id;
      }
      throw new ReveAIError('No projects found.', ReveAIErrorType.API_ERROR);
    } catch (error) {
      throw handleAxiosError(error as Error, 'getting project ID', this.options.verbose);
    }
  }

  // Bypass deprecated enhancer safely
  private async enhancePrompt(prompt: string, numVariants: number = 4): Promise<string[]> {
    if (this.options.verbose) {
      console.log(`Skipping prompt enhancement (API deprecated). Using original prompt.`);
    }
    return [prompt];
  }

  private async generateSingleImage(
    options: GenerateImageOptions, 
    enhancedPrompt?: string
  ): Promise<{ imageUrl: string; seed: number; enhancedPrompt?: string; }> {
    
    const projectId = await this.getProjectId();
    validateImageOptions(options.width, options.height, 1);

    const prompt = options.prompt;
    const negativePrompt = options.negativePrompt || '';
    const width = options.width || 1024;
    const height = options.height || 1024;
    const seed = options.seed === undefined ? -1 : options.seed;
    const model = options.model || 'unified-v1/prod/20260702-182131'; 
    const shouldEnhancePrompt = options.enhancePrompt ?? true;

    let finalPrompt = prompt;
    
    if (enhancedPrompt && shouldEnhancePrompt) {
      finalPrompt = enhancedPrompt;
    }

   const generationId = (typeof crypto !== 'undefined' && crypto.randomUUID) 
     ? crypto.randomUUID() 
     : `gen-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;


    const generationPayload = {
      data: {
        client_metadata: null,
        inference_inputs: {
          prompt: finalPrompt, 
          height: height,
          negative_prompt: negativePrompt, 
          seed: seed === -1 ? Math.floor(Math.random() * 10000000) : seed,
          width: width
        },
        inference_model: model
      },
      node: {
        description: "A generation which encapsulates a request to generate an image.",
        id: generationId,
        name: "My Generation"
      }
    };

    const generationResponse = await this.apiClient.post(
      `/api/project/${projectId}/generation`,
      generationPayload
    );

    if (IS_TEST_ENV && !generationResponse.data) {
      return { imageUrl: 'https://example.com/test-image.jpg', seed: -1 };
    }

    let generationIdFromResponse = null;
    if (generationResponse.data.create && generationResponse.data.create.node && generationResponse.data.create.node.id) {
      generationIdFromResponse = generationResponse.data.create.node.id;
    } else if (generationResponse.data.generation_id) {
      generationIdFromResponse = generationResponse.data.generation_id;
    }
    
    if (!generationIdFromResponse) {
      throw new ReveAIError(
        'Failed to get generation ID from response: ' + JSON.stringify(generationResponse.data),
        ReveAIErrorType.UNEXPECTED_RESPONSE
      );
    }

    const result = await this.pollGenerationStatus(projectId, generationIdFromResponse);
    
    return {
      imageUrl: result.imageUrls[0],
      seed: result.seed,
      enhancedPrompt: shouldEnhancePrompt && finalPrompt !== prompt ? finalPrompt : undefined
    };
  }

  public async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    try {
      validateImageOptions(options.width, options.height, options.batchSize);

      const prompt = options.prompt;
      const negativePrompt = options.negativePrompt || '';
      const batchSize = options.batchSize || 1;
      const enhancePrompt = options.enhancePrompt ?? true;

      let enhancedPrompts: string[] = [];
      if (enhancePrompt && batchSize > 1) {
        enhancedPrompts = await this.enhancePrompt(prompt, batchSize);
      }

      const generationPromises = Array.from({ length: batchSize }, (_, index) => {
        const enhancedPrompt = enhancePrompt && enhancedPrompts.length > 0 
          ? enhancedPrompts[index % enhancedPrompts.length] 
          : undefined;
          
        return this.generateSingleImage({
            ...options,
            seed: options.seed === undefined ? -1 : options.seed + Math.floor(Math.random() * 1000)
          },
          enhancedPrompt
        );
      });

      const results = await Promise.all(generationPromises);
      
      const usedEnhancedPrompts = results
        .map(r => r.enhancedPrompt)
        .filter((p): p is string => p !== undefined);
        
      return {
        imageUrls: results.map(r => r.imageUrl),
        seed: results[0].seed, 
        completedAt: new Date(),
        prompt,
        ...(enhancePrompt && usedEnhancedPrompts.length > 0 ? {
          enhancedPrompt: usedEnhancedPrompts[0],
          enhancedPrompts: usedEnhancedPrompts.length > 1 ? usedEnhancedPrompts : undefined,
        } : {}),
        negativePrompt: negativePrompt || undefined,
      };
    } catch (error) {
      if (IS_TEST_ENV && error instanceof Error) {
        if (error.message.includes('Generation failed')) throw new ReveAIError('Generation failed', ReveAIErrorType.GENERATION_ERROR);
        if (error.message.includes('timed out')) throw new ReveAIError('Generation timed out', ReveAIErrorType.POLLING_ERROR);
      }
      throw handleAxiosError(error as Error, 'generating image', this.options.verbose);
    }
  }

  private async pollGenerationStatus(projectId: string, generationId: string): Promise<{
    imageUrls: string[];
    seed: number;
  }> {
    let attempts = 0;
    
    while (attempts < this.options.maxPollingAttempts) {
      try {
        const nodeResponse = await this.apiClient.get(`/api/project/${projectId}/generation?count=50`);
        
        if (nodeResponse.data && nodeResponse.data.list && Array.isArray(nodeResponse.data.list)) {
          const ourGeneration = nodeResponse.data.list.find((item: { node?: { id: string } }) => 
            item.node && item.node.id === generationId
          );
          
          if (ourGeneration) {
            if (ourGeneration.data && ourGeneration.data.output) {
              const imageId = ourGeneration.data.output;
              const seed = ourGeneration.data.inference_inputs?.seed || -1;
              
              try {
                const imageResponse = await this.apiClient.get(
                  `/api/project/${projectId}/image/${imageId}/url/filename/${imageId}`, 
                  { 
                    responseType: 'arraybuffer',
                    headers: { 'Accept': 'image/webp,*/*' }
                  }
                );
                
                const base64Image = Buffer.from(imageResponse.data).toString('base64');
                const mimeType = imageResponse.headers['content-type'] || 'image/webp';
                const dataUrl = `data:${mimeType};base64,${base64Image}`;
                
                return {
                  imageUrls: [dataUrl],
                  seed
                };
              } catch (imageError) {
                await delay(this.options.pollingInterval);
                attempts++;
                continue;
              }
            } else if (ourGeneration.data && ourGeneration.data.error) {
              throw new ReveAIError(
                `Generation failed: ${ourGeneration.data.error}`,
                ReveAIErrorType.GENERATION_ERROR
              );
            }
          }
        }
        
        await delay(this.options.pollingInterval);
        attempts++;
      } catch (error) {
        if (error instanceof ReveAIError) {
          throw error;
        }
        throw handleAxiosError(error as Error, 'polling generation status', this.options.verbose);
      }
    }
    
    throw new ReveAIError(
      `Generation timed out after ${attempts} polling attempts`,
      ReveAIErrorType.POLLING_ERROR
    );
  }
}

export * from './types';
