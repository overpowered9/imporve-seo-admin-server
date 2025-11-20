/**
 * Migration Script: Seed Conversational Prompt Templates
 * 
 * This script creates the new prompt templates for the conversational AI system
 * that maintains context throughout the generation process.
 * 
 * Run: npx ts-node src/scripts/seed-conversational-prompts.ts
 */

import mongoose from 'mongoose';
import { PromptTemplate, PromptVersion } from '../models/prompt.models.js';
import { config } from '../config/config.js';
import { getOriginalMasterPrompt, getContinuationPrompt, getFinalizationPrompt } from '../services/original-prompts.helper.js';

async function seedConversationalPrompts() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Master Instruction Set Templates (3 variants)
    const masterPrompts = [
      {
        name: 'master_instruction_set_small',
        displayName: 'Master Instructions - Small (600-1200 words)',
        description: 'Comprehensive instructions for small blog post generation. Contains all SEO, NLP, and EI principles.',
        templateType: 'master_instruction_set_small' as const,
        category: 'master_context' as const,
        variables: ['seed_keyword', 'title', 'lsi_keywords', 'facts', 'audience_data', 'voice_tone', 'point_of_view', 'details_to_include', 'call_to_action', 'content_lang'],
        wordCountVariant: 'small' as const,
        orderIndex: 10,
        dependsOn: ['lsi_keywords', 'facts_generation']
      },
      {
        name: 'master_instruction_set_medium',
        displayName: 'Master Instructions - Medium (1200-2400 words)',
        description: 'Comprehensive instructions for medium blog post generation.',
        templateType: 'master_instruction_set_medium' as const,
        category: 'master_context' as const,
        variables: ['seed_keyword', 'title', 'lsi_keywords', 'facts', 'audience_data', 'voice_tone', 'point_of_view', 'details_to_include', 'call_to_action', 'content_lang'],
        wordCountVariant: 'medium' as const,
        orderIndex: 10,
        dependsOn: ['lsi_keywords', 'facts_generation']
      },
      {
        name: 'master_instruction_set_large',
        displayName: 'Master Instructions - Large (2400+ words)',
        description: 'Comprehensive instructions for large blog post generation.',
        templateType: 'master_instruction_set_large' as const,
        category: 'master_context' as const,
        variables: ['seed_keyword', 'title', 'lsi_keywords', 'facts', 'audience_data', 'voice_tone', 'point_of_view', 'details_to_include', 'call_to_action', 'content_lang'],
        wordCountVariant: 'large' as const,
        orderIndex: 10,
        dependsOn: ['lsi_keywords', 'facts_generation']
      }
    ];

    // Continuation Prompts (6 sections for flexibility)
    const continuationPrompts = [
      {
        name: 'continuation_section_first',
        displayName: 'Continue: First Section',
        description: 'Prompt to generate the first content section from the TOC',
        templateType: 'continuation_section_first' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 20,
        dependsOn: ['master_instruction_set_small', 'master_instruction_set_medium', 'master_instruction_set_large']
      },
      {
        name: 'continuation_section_second',
        displayName: 'Continue: Second Section',
        description: 'Prompt to generate the second content section',
        templateType: 'continuation_section_second' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 21,
        dependsOn: ['continuation_section_first']
      },
      {
        name: 'continuation_section_third',
        displayName: 'Continue: Third Section',
        description: 'Prompt to generate the third content section',
        templateType: 'continuation_section_third' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 22,
        dependsOn: ['continuation_section_second']
      },
      {
        name: 'continuation_section_fourth',
        displayName: 'Continue: Fourth Section',
        description: 'Prompt to generate the fourth content section',
        templateType: 'continuation_section_fourth' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 23,
        dependsOn: ['continuation_section_third']
      },
      {
        name: 'continuation_section_fifth',
        displayName: 'Continue: Fifth Section',
        description: 'Prompt to generate the fifth content section (medium/large only)',
        templateType: 'continuation_section_fifth' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 24,
        dependsOn: ['continuation_section_fourth']
      },
      {
        name: 'continuation_section_sixth',
        displayName: 'Continue: Sixth Section',
        description: 'Prompt to generate the sixth content section (large only)',
        templateType: 'continuation_section_sixth' as const,
        category: 'continuation' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'all' as const,
        orderIndex: 25,
        dependsOn: ['continuation_section_fifth']
      }
    ];

    // Finalization Prompts (9 variants: 3 types x 3 sizes)
    const finalizationPrompts = [
      // Conclusion
      {
        name: 'conclusion_small',
        displayName: 'Conclusion - Small',
        description: 'Generate conclusion for small post',
        templateType: 'conclusion_small' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'small' as const,
        orderIndex: 30
      },
      {
        name: 'conclusion_medium',
        displayName: 'Conclusion - Medium',
        description: 'Generate conclusion for medium post',
        templateType: 'conclusion_medium' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'medium' as const,
        orderIndex: 30
      },
      {
        name: 'conclusion_large',
        displayName: 'Conclusion - Large',
        description: 'Generate conclusion for large post',
        templateType: 'conclusion_large' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'large' as const,
        orderIndex: 30
      },
      // FAQs
      {
        name: 'faqs_small',
        displayName: 'FAQs - Small',
        description: 'Generate FAQs for small post',
        templateType: 'faqs_small' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'small' as const,
        orderIndex: 31
      },
      {
        name: 'faqs_medium',
        displayName: 'FAQs - Medium',
        description: 'Generate FAQs for medium post',
        templateType: 'faqs_medium' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'medium' as const,
        orderIndex: 31
      },
      {
        name: 'faqs_large',
        displayName: 'FAQs - Large',
        description: 'Generate FAQs for large post',
        templateType: 'faqs_large' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'large' as const,
        orderIndex: 31
      },
      // What's Next
      {
        name: 'whats_next_small',
        displayName: 'What\'s Next - Small',
        description: 'Generate What\'s Next section for small post',
        templateType: 'whats_next_small' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'small' as const,
        orderIndex: 32
      },
      {
        name: 'whats_next_medium',
        displayName: 'What\'s Next - Medium',
        description: 'Generate What\'s Next section for medium post',
        templateType: 'whats_next_medium' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'medium' as const,
        orderIndex: 32
      },
      {
        name: 'whats_next_large',
        displayName: 'What\'s Next - Large',
        description: 'Generate What\'s Next section for large post',
        templateType: 'whats_next_large' as const,
        category: 'finalization' as const,
        variables: ['min_words', 'max_words'],
        wordCountVariant: 'large' as const,
        orderIndex: 32
      }
    ];

    const allTemplates = [...masterPrompts, ...continuationPrompts, ...finalizationPrompts];

    console.log(`📝 Creating ${allTemplates.length} prompt templates...\n`);

    for (const template of allTemplates) {
      // Check if template already exists
      const existing = await PromptTemplate.findOne({ name: template.name });
      
      if (existing) {
        console.log(`⏭️  Skipping ${template.name} - already exists`);
        continue;
      }

      // Create template
      const newTemplate = await PromptTemplate.create({
        ...template,
        isSystem: true
      });

      console.log(`✅ Created template: ${template.name}`);

      // Create initial version with original prompt from PHP
      let promptText = '';
      
      if (template.name.startsWith('master_instruction_set_')) {
        const variant = template.wordCountVariant as 'small' | 'medium' | 'large';
        promptText = getOriginalMasterPrompt(variant);
      } else if (template.name.startsWith('continuation_section_')) {
        const ordinal = template.name.replace('continuation_section_', '') as 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'sixth';
        promptText = getContinuationPrompt(ordinal);
      } else if (template.name.startsWith('conclusion_') || template.name.startsWith('faqs_') || template.name.startsWith('whats_next_')) {
        const parts = template.name.split('_');
        const type = parts[0] as 'conclusion' | 'faqs' | 'whats_next';
        const variant = parts[parts.length - 1] as 'small' | 'medium' | 'large';
        promptText = getFinalizationPrompt(type, variant);
      }

      await PromptVersion.create({
        templateId: newTemplate._id,
        version: 1,
        prompt: promptText,
        isActive: true,
        createdBy: 'system',
        metadata: {
          notes: 'Initial version migrated from original PHP implementation'
        }
      });

      console.log(`   ✅ Created version 1 (active)\n`);
    }

    console.log('\n🎉 Migration completed successfully!');
    console.log('\nSummary:');
    console.log(`- Master prompts: ${masterPrompts.length}`);
    console.log(`- Continuation prompts: ${continuationPrompts.length}`);
    console.log(`- Finalization prompts: ${finalizationPrompts.length}`);
    console.log(`- Total templates: ${allTemplates.length}`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

export { seedConversationalPrompts };

// Run the migration (ES module compatible)
seedConversationalPrompts()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
