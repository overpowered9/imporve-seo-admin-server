import { Schema, model, Document, Types } from 'mongoose';

// Interface definitions
export interface IPromptTemplate extends Document {
  _id: Types.ObjectId;
  name: string; // Fixed names: "audience_generation", "lsi_keywords", "facts_generation", etc.
  displayName: string; // Human readable: "LSI Keywords Generation", "Facts Generation"
  description: string;
  templateType: 'audience_generation' | 'lsi_keywords' | 'facts_generation' | 'format_small' | 'format_medium' | 'format_large' | 'section_content' | 'conclusion' | 'faqs' | 'whats_next' | 'meta_title' | 'meta_description' | 'master_instruction_set_small' | 'master_instruction_set_medium' | 'master_instruction_set_large' | 'continuation_section_first' | 'continuation_section_second' | 'continuation_section_third' | 'continuation_section_fourth' | 'continuation_section_fifth' | 'continuation_section_sixth' | 'conclusion_small' | 'conclusion_medium' | 'conclusion_large' | 'faqs_small' | 'faqs_medium' | 'faqs_large' | 'whats_next_small' | 'whats_next_medium' | 'whats_next_large' | 'content_v2_intelligence' | 'content_v2_system' | 'content_v2_humanize' | 'content_v2_blueprint_directives' | 'content_v2_seo_rules';
  category: 'content_generation' | 'meta_generation' | 'pre_generation' | 'master_context' | 'continuation' | 'finalization';
  variables: string[]; // Template variables this prompt uses: ['seed_keyword', 'audience_data', etc.]
  isSystem: boolean; // true for pre-seeded templates (cannot be deleted)
  wordCountVariant?: 'small' | 'medium' | 'large' | 'all'; // null for universal prompts
  orderIndex?: number; // execution order in pipeline
  dependsOn?: string[]; // which templates must run before this
  createdAt: Date;
  updatedAt: Date;
}

export interface IPromptVersion extends Document {
  _id: Types.ObjectId;
  templateId: Types.ObjectId; // Reference to PromptTemplate
  version: number;
  prompt: string; // The actual prompt text with {{variable}} placeholders
  isActive: boolean;
  createdBy: string; // Admin user ID
  createdAt: Date;
  metadata?: {
    expectedOutput?: string;
    notes?: string;
    testResults?: {
      qualityScore?: number;
      performanceMetrics?: any;
    };
  };
}

// MongoDB Schemas
const promptTemplateSchema = new Schema<IPromptTemplate>({
  name: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  description: { type: String, required: true },
  templateType: { 
    type: String, 
    required: true, 
    enum: ['audience_generation', 'lsi_keywords', 'facts_generation', 'format_small', 'format_medium', 'format_large', 'section_content', 'conclusion', 'faqs', 'whats_next', 'meta_title', 'meta_description', 'master_instruction_set_small', 'master_instruction_set_medium', 'master_instruction_set_large', 'continuation_section_first', 'continuation_section_second', 'continuation_section_third', 'continuation_section_fourth', 'continuation_section_fifth', 'continuation_section_sixth', 'conclusion_small', 'conclusion_medium', 'conclusion_large', 'faqs_small', 'faqs_medium', 'faqs_large', 'whats_next_small', 'whats_next_medium', 'whats_next_large', 'content_v2_intelligence', 'content_v2_system', 'content_v2_humanize', 'content_v2_blueprint_directives', 'content_v2_seo_rules']
  },
  category: { 
    type: String, 
    required: true, 
    enum: ['content_generation', 'meta_generation', 'pre_generation', 'master_context', 'continuation', 'finalization'] 
  },
  variables: [{ type: String }],
  isSystem: { type: Boolean, default: false },
  wordCountVariant: { type: String, enum: ['small', 'medium', 'large', 'all'], required: false },
  orderIndex: { type: Number, required: false },
  dependsOn: [{ type: String }]
}, {
  timestamps: true
});

const promptVersionSchema = new Schema<IPromptVersion>({
  templateId: { type: Schema.Types.ObjectId, ref: 'PromptTemplate', required: true },
  version: { type: Number, required: true },
  prompt: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  metadata: {
    expectedOutput: String,
    notes: String,
    testResults: {
      qualityScore: Number,
      performanceMetrics: Schema.Types.Mixed
    }
  }
});

// Indexes for performance (name index is already created by unique: true)
promptVersionSchema.index({ templateId: 1, version: -1 });
promptVersionSchema.index({ templateId: 1, isActive: 1 });

// Models
export const PromptTemplate = model<IPromptTemplate>('PromptTemplate', promptTemplateSchema);
export const PromptVersion = model<IPromptVersion>('PromptVersion', promptVersionSchema);