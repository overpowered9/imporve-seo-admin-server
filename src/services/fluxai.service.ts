import axios from 'axios';

interface FluxAIGenerateRequest {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  prompt_upsampling?: boolean;
  safety_tolerance?: number;
  output_format?: 'jpeg' | 'png';
  seed?: number;
}

interface FluxAIGenerateResponse {
  id: string;
}

interface FluxAIErrorResponse {
  detail?: string | Array<{
    loc: string[];
    msg: string;
    type: string;
  }>;
  error?: string;
}

interface FluxAIResultResponse {
  status: 'Ready' | 'Pending' | 'Error' | 'Request Moderated' | 'Content Moderated';
  result?: {
    sample: string;
  };
  error?: string;
}

export class FluxAIService {
  private apiKey: string;
  private baseUrl: string = 'https://api.bfl.ai/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.FLUX_AI_API_KEY || '';
    
    if (!this.apiKey) {
      console.warn('⚠️ Flux AI API key not configured. Image generation will fail.');
    }
  }

  /**
   * Generate image prompt from title using OpenAI
   */
  async generateImagePrompt(title: string, openAiKey: string): Promise<string> {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            {
              role: 'user',
              content: `I need help creating a Dalle image prompt for an article based on the title: ${title}. Provide the description without any further explanation. Do not include the word 'prompt'.`
            }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey}`
          }
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('❌ Error generating image prompt with OpenAI:', error);
      throw new Error('Failed to generate image prompt');
    }
  }

  /**
   * Initiate image generation with Flux AI
   * Returns immediately with task ID - does not wait for generation to complete
   */
  async generateImage(params: FluxAIGenerateRequest): Promise<string> {
    try {
      console.log('🎨 Initiating Flux AI image generation...');
      console.log('📝 Prompt:', params.prompt);

      const requestBody = {
        prompt: params.prompt,
        width: params.width || 1024,
        height: params.height || 768,
        steps: params.steps || 28,
        guidance: params.guidance || 3,
        prompt_upsampling: params.prompt_upsampling ?? false,
        safety_tolerance: params.safety_tolerance ?? 2,
        output_format: params.output_format || 'jpeg'
      };

      console.log('🔧 Request params:', requestBody);

      const response = await axios.post<FluxAIGenerateResponse>(
        `${this.baseUrl}/flux-dev`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-key': this.apiKey
          },
          timeout: 30000, // 30 seconds is enough for initial request
          validateStatus: (status) => status === 200 || status === 422
        }
      );

      // Handle validation errors (422)
      if (response.status === 422) {
        const errorData = response.data as unknown as FluxAIErrorResponse;
        let errorMessage = 'Validation error';
        
        if (errorData.detail) {
          if (Array.isArray(errorData.detail)) {
            errorMessage = errorData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join(', ');
          } else {
            errorMessage = errorData.detail;
          }
        }
        
        console.error('❌ Flux AI validation error:', errorMessage);
        throw new Error(`Invalid request parameters: ${errorMessage}`);
      }

      // Handle missing task ID
      if (!response.data || !response.data.id) {
        console.error('❌ Invalid API response:', response.data);
        throw new Error('Invalid response from Flux AI API - no task ID received');
      }

      const taskId = response.data.id;
      console.log('✅ Flux AI task created:', taskId);
      console.log('⏳ Image generation started (will poll for completion)...');

      return taskId;
      
    } catch (error: any) {
      // Handle timeout errors
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        console.error('❌ Flux AI connection timeout');
        throw new Error('Connection timeout while connecting to Flux AI. Please check your network and try again.');
      }
      
      // Handle network errors
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        console.error('❌ Flux AI connection failed:', error.code);
        throw new Error('Unable to connect to Flux AI service. Please try again later.');
      }

      // Re-throw our custom errors
      if (error.message.includes('Invalid request parameters') || 
          error.message.includes('Invalid response')) {
        throw error;
      }

      // Handle other errors
      console.error('❌ Flux AI generation error:', error.response?.data || error.message);
      throw new Error(`Flux AI generation failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Poll for image generation result with exponential backoff
   * Flux Dev can take 1-3 minutes to generate images
   */
  async getResult(taskId: string, maxAttempts: number = 30): Promise<string> {
    console.log(`🔄 Polling for result (max ${maxAttempts} attempts)...`);
    console.log('⏱️  Expected wait time: 1-3 minutes');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Exponential backoff: start with 2s, increase to max 10s
      if (attempt > 0) {
        const waitTime = Math.min(2000 * Math.pow(1.2, attempt - 1), 10000);
        console.log(`⏳ Waiting ${Math.round(waitTime / 1000)}s before next check...`);
        await this.sleep(waitTime);
      }

      try {
        const response = await axios.get<FluxAIResultResponse>(
          `${this.baseUrl}/get_result`,
          {
            params: { id: taskId },
            headers: {
              'x-key': this.apiKey
            },
            timeout: 15000, // 15 second timeout for status checks
            validateStatus: (status) => status === 200 || status === 404
          }
        );

        // Handle 404 - task not found
        if (response.status === 404) {
          throw new Error(`Task ${taskId} not found. It may have expired.`);
        }

        const data = response.data;

        // Success - image is ready
        if (data.status === 'Ready' && data.result?.sample) {
          console.log(`✅ Image ready! (attempt ${attempt + 1}/${maxAttempts})`);
          console.log('🖼️  Image URL:', data.result.sample);
          return data.result.sample;
        } 
        
        // Error states - don't retry
        if (data.status === 'Error') {
          throw new Error(`Flux AI generation failed: ${data.error || 'Unknown error'}`);
        }
        
        if (data.status === 'Request Moderated') {
          throw new Error('Request was moderated by Flux AI. Please try a different prompt.');
        }
        
        if (data.status === 'Content Moderated') {
          throw new Error('Generated content was moderated by Flux AI. Please try a different prompt.');
        }
        
        // Still pending - continue polling
        if (data.status === 'Pending') {
          const elapsed = Math.round((attempt + 1) * 4); // rough estimate
          console.log(`⏳ Status: Pending (attempt ${attempt + 1}/${maxAttempts}, ~${elapsed}s elapsed)`);
        } else {
          console.log(`⏳ Status: ${data.status} (attempt ${attempt + 1}/${maxAttempts})`);
        }
        
      } catch (error: any) {
        // Re-throw business logic errors
        if (error.message.includes('not found') || 
            error.message.includes('moderated') ||
            error.message.includes('generation failed')) {
          throw error;
        }
        
        // Handle timeout on status check
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          console.warn(`⚠️ Timeout checking result (attempt ${attempt + 1}/${maxAttempts})`);
          continue; // Retry on timeout
        }
        
        // Log other errors but continue trying
        console.error(`⚠️ Error checking result (attempt ${attempt + 1}):`, error.message);
        
        // If we're close to max attempts, be more aggressive about failing
        if (attempt >= maxAttempts - 3) {
          throw new Error(`Failed to check generation status: ${error.message}`);
        }
      }
    }

    // Exhausted all attempts
    throw new Error(`Image generation timeout after ${maxAttempts} attempts (~${Math.round(maxAttempts * 4 / 60)} minutes). The task may still be processing. Please try again later.`);
  }

  /**
   * Generate image with automatic polling (all-in-one method)
   */
  async generateImageWithPolling(
    title: string,
    openAiKey: string,
    options?: {
      width?: number;
      height?: number;
      customPrompt?: string;
      useCustomPrompt?: boolean;
    }
  ): Promise<{ imageUrl: string; promptUsed: string }> {
    try {
      let imagePrompt: string;

      if (options?.useCustomPrompt && options?.customPrompt) {
        // Use custom prompt directly
        imagePrompt = options.customPrompt;
      } else {
        // Generate prompt using OpenAI
        const basicPrompt = await this.generateImagePrompt(title, openAiKey);
        imagePrompt = `You should come up with the cover image for an article. The image should be a very high quality shooting from a distance, high detail, photorealistic, image resolution is 800 pixels, cinematic. Do not include any text on the image. Using the following information generate an image. ${basicPrompt}`;
      }

      // Initiate generation
      const taskId = await this.generateImage({
        prompt: imagePrompt,
        width: options?.width || 1024,
        height: options?.height || 768,
        prompt_upsampling: false,
        safety_tolerance: 2,
        output_format: 'jpeg'
      });

      // Poll for result
      const imageUrl = await this.getResult(taskId);

      return {
        imageUrl,
        promptUsed: imagePrompt
      };
    } catch (error: any) {
      console.error('❌ Full image generation flow error:', error);
      throw error;
    }
  }

  /**
   * Download image from URL (for saving to storage)
   */
  async downloadImage(imageUrl: string): Promise<Buffer> {
    try {
      console.log('⬇️ Downloading image from Flux AI...');
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer'
      });

      console.log('✅ Image downloaded successfully');
      return Buffer.from(response.data);
    } catch (error) {
      console.error('❌ Error downloading image:', error);
      throw new Error('Failed to download generated image');
    }
  }

  /**
   * Helper to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const fluxAIService = new FluxAIService();
