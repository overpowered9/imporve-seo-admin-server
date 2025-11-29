/**
 * Update Script: Fix FAQ and What's Next Prompts
 * 
 * This script updates the finalization prompts (FAQs and What's Next) to include
 * explicit formatting instructions for bold questions and CTA inclusion.
 * 
 * Run: npx ts-node src/scripts/update-finalization-prompts.ts
 */

import mongoose from 'mongoose';
import { PromptTemplate, PromptVersion } from '../models/prompt.models.js';
import { config } from '../config/config.js';

async function updateFinalizationPrompts() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Updated FAQ prompts with explicit bold formatting
    const faqPrompts = {
      'faqs_small': `Now generate the FAQs content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Come up with 3 FAQ that the reader may have
- Format each question in BOLD using HTML: <strong>Q: Question here?</strong>
- Format answers as: A: Answer text here.
- Use clear, informative tone
- Empathize with the reader's concerns
- Do not include the word count in the output

Example format:
<strong>Q: What is the main topic?</strong>
A: The answer goes here with detailed information.

<strong>Q: How does this work?</strong>
A: Another detailed answer here.`,

      'faqs_medium': `Now generate the FAQs content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Come up with 3 FAQ that the reader may have
- Format each question in BOLD using HTML: <strong>Q: Question here?</strong>
- Format answers as: A: Answer text here.
- Use clear, informative tone
- Empathize with the reader's concerns
- Do not include the word count in the output

Example format:
<strong>Q: What is the main topic?</strong>
A: The answer goes here with detailed information.

<strong>Q: How does this work?</strong>
A: Another detailed answer here.`,

      'faqs_large': `Now generate the FAQs content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Come up with 3 FAQ that the reader may have
- Format each question in BOLD using HTML: <strong>Q: Question here?</strong>
- Format answers as: A: Answer text here.
- Use clear, informative tone
- Empathize with the reader's concerns
- Do not include the word count in the output

Example format:
<strong>Q: What is the main topic?</strong>
A: The answer goes here with detailed information.

<strong>Q: How does this work?</strong>
A: Another detailed answer here.`
    };

    // Updated What's Next prompts with explicit CTA instructions
    const whatsNextPrompts = {
      'whats_next_small': `Now generate What is next? content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Write a short paragraph inviting the reader to take action
- MUST incorporate the call to action: {{call_to_action}}
- If call to action contains URLs, links, or contact info, include them as clickable links
- If call to action is blank, write a general paragraph encouraging further exploration
- Do not include the word count in the output
- Use natural, engaging language that flows from the article content`,

      'whats_next_medium': `Now generate What is next? content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Write a short paragraph inviting the reader to take action
- MUST incorporate the call to action: {{call_to_action}}
- If call to action contains URLs, links, or contact info, include them as clickable links
- If call to action is blank, write a general paragraph encouraging further exploration
- Do not include the word count in the output
- Use natural, engaging language that flows from the article content`,

      'whats_next_large': `Now generate What is next? content. 

IMPORTANT: 
- Output should be {{min_words}}-{{max_words}} words
- After writing an output check the word count and regenerate if it is not in the range
- Write a short paragraph inviting the reader to take action
- MUST incorporate the call to action: {{call_to_action}}
- If call to action contains URLs, links, or contact info, include them as clickable links
- If call to action is blank, write a general paragraph encouraging further exploration
- Do not include the word count in the output
- Use natural, engaging language that flows from the article content`
    };

    const allPrompts = { ...faqPrompts, ...whatsNextPrompts };

    console.log(`📝 Updating ${Object.keys(allPrompts).length} finalization prompts...\n`);

    for (const [templateName, newPromptText] of Object.entries(allPrompts)) {
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

      // Check if already updated
      if (activeVersion.prompt.includes('<strong>Q:') || activeVersion.prompt.includes('MUST incorporate')) {
        console.log(`⏭️  Already updated: ${templateName}`);
        continue;
      }

      // Deactivate current version
      activeVersion.isActive = false;
      await activeVersion.save();

      // Create new version with updated prompt
      const newVersion = await PromptVersion.create({
        templateId: template._id,
        version: activeVersion.version + 1,
        prompt: newPromptText,
        isActive: true,
        createdBy: 'system',
        metadata: {
          notes: 'Updated with explicit formatting instructions for FAQ bold questions and CTA inclusion',
          previousVersion: activeVersion.version
        }
      });

      console.log(`✅ Updated ${templateName}: v${activeVersion.version} → v${newVersion.version}`);
    }

    console.log('\n🎉 Update completed successfully!');
    console.log('\nSummary:');
    console.log(`- FAQ prompts updated: 3 (small, medium, large)`);
    console.log(`- What\'s Next prompts updated: 3 (small, medium, large)`);
    console.log(`- Total updated: 6 prompts`);

  } catch (error) {
    console.error('❌ Update failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

export { updateFinalizationPrompts };

// Run the update (ES module compatible)
updateFinalizationPrompts()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
