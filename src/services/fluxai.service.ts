import axios from 'axios';

interface FluxAIGenerateRequest {
  prompt: string;
  width?: number;
  height?: number;
  prompt_upsampling?: boolean;
  safety_tolerance?: number;
  output_format?: 'jpeg' | 'png';
}

interface FluxAIGenerateResponse {
  id: string;
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
  private baseUrl: string = 'https://api.us1.bfl.ai/v1';

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
   */
  async generateImage(params: FluxAIGenerateRequest): Promise<string> {
    try {
      console.log('🎨 Initiating Flux AI image generation...');
      console.log('📝 Prompt:', params.prompt);

      const response = await axios.post<FluxAIGenerateResponse>(
        `${this.baseUrl}/flux-pro-1.1`,
        {
          prompt: params.prompt,
          width: params.width || 1024,
          height: params.height || 768,
          prompt_upsampling: params.prompt_upsampling ?? false,
          safety_tolerance: params.safety_tolerance ?? 2,
          output_format: params.output_format || 'jpeg'
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Key': this.apiKey
          }
        }
      );

      const taskId = response.data.id;
      console.log('✅ Flux AI task created:', taskId);

      return taskId;
    } catch (error: any) {
      console.error('❌ Flux AI generation error:', error.response?.data || error.message);
      throw new Error(`Flux AI generation failed: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Poll for image generation result
   */
  async getResult(taskId: string, maxAttempts: number = 10): Promise<string> {
    console.log(`🔄 Polling for result (max ${maxAttempts} attempts)...`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // Wait 4 seconds before checking again (same as WordPress plugin)
        await this.sleep(4000);
      }

      try {
        const response = await axios.get<FluxAIResultResponse>(
          `${this.baseUrl}/get_result`,
          {
            params: { id: taskId },
            headers: {
              'X-Key': this.apiKey
            }
          }
        );

        const data = response.data;

        if (data.status === 'Ready' && data.result?.sample) {
          console.log(`✅ Image ready! (attempt ${attempt + 1}/${maxAttempts})`);
          return data.result.sample;
        } else if (data.status === 'Error' || data.status === 'Request Moderated' || data.status === 'Content Moderated') {
          throw new Error(`Flux AI error: ${data.status} - ${data.error || 'Unknown error'}`);
        } else {
          console.log(`⏳ Status: ${data.status} (attempt ${attempt + 1}/${maxAttempts})`);
        }
      } catch (error: any) {
        if (error.message.includes('Flux AI error:')) {
          throw error;
        }
        console.error(`❌ Error checking result (attempt ${attempt + 1}):`, error.message);
      }
    }

    throw new Error('Timeout waiting for image generation. Please try again.');
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
