import mongoose, { Document, Schema } from 'mongoose';

// Interface for Generation Parameters
interface IGenerationParams {
  seed_keyword: string;
  nos_of_words: '600 to 1200 words' | '1200 to 2400 words' | '2400 to 3600 words';
  content_lang: string;
  voice_tone?: string;
  point_of_view?: string;
  title?: string;
  call_to_action?: string;
  details_to_include?: string;
  audienceData?: string;
}

// Interface for Testing Parameters
interface ITestingParams extends IGenerationParams {
  testPromptType: string;
  testVersionId: string;
}

// Interface for Generation Result
interface IGenerationResult {
  search_data: string;
  content: string;
  meta_title: string;
  meta_description: string;
}

// Interface for Generation Metadata
interface IGenerationMetadata {
  templatesUsed: string[];
  promptVersions: Record<string, string>;
  processingTime: number;
}

// Interface for Testing Info
interface ITestingInfo {
  testedPromptType: string;
  testedVersionId: string;
  message: string;
}

// Main Generation Document Interface
export interface IGeneration extends Document {
  _id: mongoose.Types.ObjectId;
  type: 'active' | 'testing';
  parameters: IGenerationParams | ITestingParams;
  result: IGenerationResult;
  metadata: IGenerationMetadata;
  testingInfo?: ITestingInfo;
  status: 'success' | 'error';
  error?: string;
  userId?: string; // For future user management
  sessionId?: string; // For anonymous tracking
  createdAt: Date;
  updatedAt: Date;
}

// Generation Parameters Schema
const GenerationParamsSchema = new Schema({
  seed_keyword: { type: String, required: true },
  nos_of_words: { 
    type: String, 
    enum: ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'],
    required: true 
  },
  content_lang: { type: String, required: true },
  voice_tone: { type: String },
  point_of_view: { type: String },
  title: { type: String },
  call_to_action: { type: String },
  details_to_include: { type: String },
  audienceData: { type: String },
  // Testing specific fields
  testPromptType: { type: String },
  testVersionId: { type: String }
}, { _id: false });

// Generation Result Schema
const GenerationResultSchema = new Schema({
  search_data: { type: String, default: '' },
  content: { type: String, default: '' },
  meta_title: { type: String, default: '' },
  meta_description: { type: String, default: '' }
}, { _id: false });

// Generation Metadata Schema
const GenerationMetadataSchema = new Schema({
  templatesUsed: [{ type: String }],
  promptVersions: { type: Map, of: String },
  processingTime: { type: Number, default: 0 }
}, { _id: false });

// Testing Info Schema
const TestingInfoSchema = new Schema({
  testedPromptType: { type: String, required: true },
  testedVersionId: { type: String, required: true },
  message: { type: String, required: true }
}, { _id: false });

// Main Generation Schema
const GenerationSchema = new Schema<IGeneration>({
  type: { 
    type: String, 
    enum: ['active', 'testing'], 
    required: true,
    index: true 
  },
  parameters: { 
    type: GenerationParamsSchema, 
    required: true 
  },
  result: { 
    type: GenerationResultSchema, 
    required: true 
  },
  metadata: { 
    type: GenerationMetadataSchema, 
    required: true 
  },
  testingInfo: TestingInfoSchema,
  status: { 
    type: String, 
    enum: ['success', 'error'], 
    required: true,
    index: true 
  },
  error: { type: String },
  userId: { 
    type: String, 
    index: true 
  },
  sessionId: { 
    type: String, 
    index: true 
  }
}, {
  timestamps: true,
  collection: 'generations'
});

// Indexes for better query performance
GenerationSchema.index({ createdAt: -1 });
GenerationSchema.index({ type: 1, status: 1 });
GenerationSchema.index({ 'parameters.seed_keyword': 'text' });

export const Generation = mongoose.model<IGeneration>('Generation', GenerationSchema);

export default Generation;