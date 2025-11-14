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
    this.apiKey = process.env.FLUX_AI_API_KEY || '';
    
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
      console.log('📝 Prompt:', params.prompt.substring(0, 100) + '...');

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

      console.log('🔧 Request params:', { ...requestBody, prompt: '[truncated]' });

      const response = await axios.post(
        `${this.baseUrl}/flux-dev`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'x-key': this.apiKey
          },
          timeout: 30000
        }
      );

      console.log('📥 API Response status:', response.status);
      console.log('📥 API Response data:', JSON.stringify(response.data));

      // Validate response
      if (!response.data) {
        throw new Error('Empty response from Flux AI API');
      }

      if (!response.data.id) {
        console.error('❌ Invalid response structure:', response.data);
        throw new Error('No task ID in API response. Response: ' + JSON.stringify(response.data));
      }

      const taskId = response.data.id;
      console.log('✅ Flux AI task created successfully');
      console.log('🆔 Task ID:', taskId);

      return taskId;
      
    } catch (error: any) {
      console.error('❌ Flux AI API Error Details:');
      console.error('   Status:', error.response?.status);
      console.error('   Data:', JSON.stringify(error.response?.data));
      console.error('   Message:', error.message);
      
      if (error.response?.status === 422) {
        const detail = error.response.data?.detail;
        const errorMsg = Array.isArray(detail) 
          ? detail.map(e => `${e.loc?.join('.')}: ${e.msg}`).join(', ')
          : detail || 'Validation error';
        throw new Error(`Invalid parameters: ${errorMsg}`);
      }
      
      if (error.code === 'ETIMEDOUT') {
        throw new Error('Connection timeout. Please check your network and try again.');
      }
      
      if (error.response?.data?.error) {
        throw new Error(error.response.data.error);
      }
      
      throw new Error(`Flux AI error: ${error.message}`);
    }
  }

  /**
   * Poll for image generation result
   * Flux Dev typically takes 1-3 minutes to generate images
   */
  async getResult(taskId: string, maxAttempts: number = 40): Promise<string> {
    console.log('🔄 Starting to poll for image result...');
    console.log('🆔 Task ID:', taskId);
    console.log('⏱️  Max wait time: ~3 minutes');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before checking (except first attempt)
      if (attempt > 0) {
        const waitTime = Math.min(3000 + (attempt * 200), 8000); // 3s to 8s
        await this.sleep(waitTime);
      } else {
        // Small initial delay to let task register
        await this.sleep(1000);
      }

      try {
        console.log(`📡 Checking status (attempt ${attempt + 1}/${maxAttempts})...`);
        
        const response = await axios.get(
          `${this.baseUrl}/get_result`,
          {
            params: { id: taskId },
            headers: {
              'x-key': this.apiKey
            },
            timeout: 10000
          }
        );

        console.log('📥 Status response:', JSON.stringify(response.data));
        const data = response.data;

        // Success!
        if (data.status === 'Ready' && data.result?.sample) {
          console.log(`✅ Image ready after ${attempt + 1} attempts!`);
          console.log('🖼️  URL:', data.result.sample);
          return data.result.sample;
        } 
        
        // Error states
        if (data.status === 'Error') {
          throw new Error(`Generation failed: ${data.error || 'Unknown error'}`);
        }
        
        if (data.status === 'Request Moderated') {
          throw new Error('Request was blocked by content moderation. Try a different prompt.');
        }
        
        if (data.status === 'Content Moderated') {
          throw new Error('Generated content was blocked by moderation. Try a different prompt.');
        }
        
        // Still pending
        console.log(`⏳ Status: ${data.status}`);
        
      } catch (error: any) {
        console.error(`⚠️  Error on attempt ${attempt + 1}:`, error.message);
        
        // Don't retry on these errors
        if (error.message.includes('moderated') || 
            error.message.includes('Generation failed')) {
          throw error;
        }
        
        // 404 might mean task is still registering on first few attempts
        if (error.response?.status === 404) {
          if (attempt < 3) {
            console.log('⏳ Task not found yet, waiting for it to register...');
            continue;
          }
          throw new Error('Task not found. It may have expired or the task ID is invalid.');
        }
        
        // Timeout - retry
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          console.log('⏳ Timeout checking status, will retry...');
          continue;
        }
        
        // On last few attempts, fail fast
        if (attempt >= maxAttempts - 2) {
          throw new Error(`Status check failed: ${error.message}`);
        }
      }
    }

    throw new Error(`Generation timeout after ${maxAttempts} attempts. Please try again later.`);
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
