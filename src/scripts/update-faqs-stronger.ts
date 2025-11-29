/**
 * Update Script: Stronger FAQ Formatting Instructions
 * 
 * This script updates FAQ prompts with even more explicit formatting requirements
 * to ensure GPT outputs bold questions consistently.
 * 
 * Run: npx tsx src/scripts/update-faqs-stronger.ts
 */

import mongoose from 'mongoose';
import { PromptTemplate, PromptVersion } from '../models/prompt.models.js';
import { config } from '../config/config.js';

async function updateFAQsStronger() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Ultra-explicit FAQ prompts with multiple formatting examples
    const faqPrompts = {
      'faqs_small': `Now generate the FAQs content. 

CRITICAL FORMATTING REQUIREMENTS:
- Output should be {{min_words}}-{{max_words}} words
- Come up with 3 FAQ that the reader may have
- **EVERY question MUST be wrapped in <strong> tags**
- Questions MUST start with: <strong>Q: 
- Questions MUST end with: ?</strong>
- Answers start with: A: (no tags)
- Use clear, informative tone
- Do not include the word count in the output

EXACT FORMAT TO FOLLOW (copy this structure):
<strong>Q: What is the main benefit of this product?</strong>
A: The answer provides detailed information about the benefits and features that users will find valuable.

<strong>Q: How does this technology work?</strong>
A: A comprehensive explanation of the technology, breaking down complex concepts into understandable terms.

<strong>Q: Is this suitable for beginners?</strong>
A: An answer addressing the skill level requirements and providing reassurance to newcomers.

IMPORTANT: DO NOT output questions without <strong> tags. DO NOT use ** for bold. Use HTML <strong> tags ONLY.`,

      'faqs_medium': `Now generate the FAQs content. 

CRITICAL FORMATTING REQUIREMENTS:
- Output should be {{min_words}}-{{max_words}} words
- Come up with 3 FAQ that the reader may have
- **EVERY question MUST be wrapped in <strong> tags**
- Questions MUST start with: <strong>Q: 
- Questions MUST end with: ?</strong>
- Answers start with: A: (no tags)
- Use clear, informative tone
- Do not include the word count in the output

EXACT FORMAT TO FOLLOW (copy this structure):
<strong>Q: What is the main benefit of this product?</strong>
A: The answer provides detailed information about the benefits and features that users will find valuable.

<strong>Q: How does this technology work?</strong>
A: A comprehensive explanation of the technology, breaking down complex concepts into understandable terms.

<strong>Q: Is this suitable for beginners?</strong>
A: An answer addressing the skill level requirements and providing reassurance to newcomers.

IMPORTANT: DO NOT output questions without <strong> tags. DO NOT use ** for bold. Use HTML <strong> tags ONLY.`,

      'faqs_large': `Now generate the FAQs content. 

CRITICAL FORMATTING REQUIREMENTS:
- Output should be {{min_words}}-{{max_words}} words
- Come up with 3 FAQ that the reader may have
- **EVERY question MUST be wrapped in <strong> tags**
- Questions MUST start with: <strong>Q: 
- Questions MUST end with: ?</strong>
- Answers start with: A: (no tags)
- Use clear, informative tone
- Do not include the word count in the output

EXACT FORMAT TO FOLLOW (copy this structure):
<strong>Q: What is the main benefit of this product?</strong>
A: The answer provides detailed information about the benefits and features that users will find valuable.

<strong>Q: How does this technology work?</strong>
A: A comprehensive explanation of the technology, breaking down complex concepts into understandable terms.

<strong>Q: Is this suitable for beginners?</strong>
A: An answer addressing the skill level requirements and providing reassurance to newcomers.

IMPORTANT: DO NOT output questions without <strong> tags. DO NOT use ** for bold. Use HTML <strong> tags ONLY.`
    };

    console.log(`📝 Updating ${Object.keys(faqPrompts).length} FAQ prompts with stronger formatting...\n`);

    for (const [templateName, newPromptText] of Object.entries(faqPrompts)) {
      // Find the template
      const template = await PromptTemplate.findOne({ name: templateName });
      
      if (!template) {
        console.log(`⚠️  Template not found: ${templateName}`);
        continue;
      }

      // Find the active version
      const activeVersion = await PromptVersion.findOne({ 
        templateId: template._id, 
        isActive: true 
      });

      if (!activeVersion) {
        console.log(`⚠️  No active version for: ${templateName}`);
        continue;
      }

      // Deactivate current version
      activeVersion.isActive = false;
      await activeVersion.save();

      // Create new version with stronger prompt
      const newVersion = await PromptVersion.create({
        templateId: template._id,
        version: activeVersion.version + 1,
        prompt: newPromptText,
        isActive: true,
        createdBy: 'system',
        metadata: {
          notes: 'Updated with ultra-explicit formatting requirements - emphasized HTML <strong> tags with multiple examples',
          previousVersion: activeVersion.version
        }
      });

      console.log(`✅ Updated ${templateName}: v${activeVersion.version} → v${newVersion.version} (stronger formatting)`);
    }

    console.log('\n🎉 Update completed successfully!');
    console.log('\nChanges:');
    console.log('- Added "CRITICAL FORMATTING REQUIREMENTS" header');
    console.log('- Multiple explicit examples showing <strong> tag usage');
    console.log('- Explicit prohibition of ** markdown bold');
    console.log('- Clear directive: "DO NOT output questions without <strong> tags"');

  } catch (error) {
    console.error('❌ Update failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

export { updateFAQsStronger };

// Run the update
updateFAQsStronger()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
