import mongoose from 'mongoose';
import { PromptTemplate, PromptVersion } from '../models/prompt.models.js';
import { config } from '../config/config.js';

// Fixed template definitions based on generateAiHtmlPost2 analysis
const FIXED_TEMPLATES = [
  {
    name: 'audience_generation',
    displayName: 'Audience Generation',
    description: 'Generates target audience analysis for content',
    templateType: 'audience_generation' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'context'],
    defaultPrompt: `Analyze and define the target audience for content about "{seed_keyword}". 
    
Consider:
- Demographics and psychographics
- Pain points and challenges
- Goals and motivations
- Content preferences
- Language and tone preferences

Context: {context}

Provide a detailed audience profile that will guide content creation.`
  },
  {
    name: 'lsi_keywords',
    displayName: 'LSI Keywords Generation',
    description: 'Generates semantically related keywords for SEO',
    templateType: 'lsi_keywords' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'audience_data'],
    defaultPrompt: `Generate 15-20 LSI (Latent Semantic Indexing) keywords related to "{seed_keyword}".

Target Audience: {audience_data}

Requirements:
- Keywords should be semantically related to the main topic
- Include long-tail variations
- Consider search intent variations
- Focus on keywords the target audience would use
- Provide keywords that support comprehensive content coverage

Format as a comma-separated list.`
  },
  {
    name: 'facts_generation',
    displayName: 'Facts Generation',
    description: 'Generates relevant facts and statistics for content',
    templateType: 'facts_generation' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'audience_data', 'lsi_keywords'],
    defaultPrompt: `Generate 8-12 relevant, accurate facts and statistics about "{seed_keyword}".

Target Audience: {audience_data}
Related Keywords: {lsi_keywords}

Requirements:
- Facts should be current and verifiable
- Include numerical data and statistics where possible
- Cover different aspects of the topic
- Be relevant to the target audience
- Support comprehensive content creation

Format each fact as a bullet point with source context where appropriate.`
  },
  {
    name: 'format_small',
    displayName: 'Format Template - Small',
    description: 'Content structure template for small articles (500-800 words)',
    templateType: 'format_small' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'audience_data', 'lsi_keywords', 'facts'],
    defaultPrompt: `Create a content outline for a small article (500-800 words) about "{seed_keyword}".

Target Audience: {audience_data}
LSI Keywords to include: {lsi_keywords}
Key Facts to incorporate: {facts}

Structure:
1. Introduction (100-150 words)
   - Hook and problem statement
   - Brief overview of what readers will learn
   
2. Main Content Section (300-500 words)
   - 2-3 key points with subheadings
   - Incorporate LSI keywords naturally
   - Include 2-3 relevant facts
   
3. Conclusion (100-150 words)
   - Summarize key points
   - Call to action

Provide detailed section breakdowns with specific talking points.`
  },
  {
    name: 'format_medium',
    displayName: 'Format Template - Medium',
    description: 'Content structure template for medium articles (800-1500 words)',
    templateType: 'format_medium' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'audience_data', 'lsi_keywords', 'facts'],
    defaultPrompt: `Create a content outline for a medium article (800-1500 words) about "{seed_keyword}".

Target Audience: {audience_data}
LSI Keywords to include: {lsi_keywords}
Key Facts to incorporate: {facts}

Structure:
1. Introduction (150-200 words)
   - Compelling hook
   - Problem/opportunity presentation
   - Article overview and value proposition
   
2. Main Content Sections (500-1000 words)
   - 3-5 main sections with descriptive subheadings
   - Each section 150-250 words
   - Incorporate LSI keywords throughout
   - Include relevant facts and examples
   
3. FAQ Section (100-200 words)
   - 3-4 common questions and answers
   
4. Conclusion (100-150 words)
   - Key takeaways summary
   - Strong call to action

Provide detailed section breakdowns with specific talking points and keyword placement strategies.`
  },
  {
    name: 'format_large',
    displayName: 'Format Template - Large',
    description: 'Content structure template for large articles (1500+ words)',
    templateType: 'format_large' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'audience_data', 'lsi_keywords', 'facts'],
    defaultPrompt: `Create a comprehensive content outline for a large article (1500+ words) about "{seed_keyword}".

Target Audience: {audience_data}
LSI Keywords to include: {lsi_keywords}
Key Facts to incorporate: {facts}

Structure:
1. Introduction (200-250 words)
   - Attention-grabbing hook
   - Problem statement and context
   - Detailed article overview
   - Value proposition for readers
   
2. Table of Contents
   - Clear navigation for long-form content
   
3. Main Content Sections (1000-1500 words)
   - 5-7 comprehensive sections
   - Each section 200-300 words
   - Detailed subheadings and bullet points
   - Strategic LSI keyword placement
   - Multiple facts and examples per section
   
4. FAQ Section (200-250 words)
   - 5-7 detailed questions and answers
   
5. What's Next Section (100-150 words)
   - Next steps for readers
   - Related topics to explore
   
6. Conclusion (150-200 words)
   - Comprehensive summary
   - Key actionables
   - Strong call to action

Provide detailed section breakdowns with specific talking points, keyword density recommendations, and content depth guidelines.`
  },
  {
    name: 'section_content',
    displayName: 'Section Content Generation',
    description: 'Generates content for individual article sections',
    templateType: 'section_content' as const,
    category: 'content_generation' as const,
    variables: ['section_topic', 'section_outline', 'seed_keyword', 'audience_data', 'lsi_keywords', 'relevant_facts'],
    defaultPrompt: `Write engaging content for the section: "{section_topic}"

Section Outline: {section_outline}
Main Keyword: {seed_keyword}
Target Audience: {audience_data}
LSI Keywords to incorporate: {lsi_keywords}
Relevant Facts: {relevant_facts}

Requirements:
- Write in a conversational, engaging tone
- Incorporate LSI keywords naturally (avoid keyword stuffing)
- Include relevant facts and examples
- Use bullet points or numbered lists where appropriate
- Ensure content flows logically
- Maintain focus on audience needs and interests
- Include actionable insights where possible

Word count should match the section requirements from the overall format template.`
  },
  {
    name: 'conclusion',
    displayName: 'Conclusion Generation',
    description: 'Generates article conclusions with key takeaways',
    templateType: 'conclusion' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'main_points', 'audience_data', 'call_to_action'],
    defaultPrompt: `Write a compelling conclusion for an article about "{seed_keyword}".

Main Points Covered: {main_points}
Target Audience: {audience_data}
Desired Call to Action: {call_to_action}

Structure:
1. Summarize key takeaways (2-3 main points)
2. Reinforce the value provided to readers
3. Include a strong, specific call to action
4. End with a memorable closing statement

Tone: Confident, helpful, and encouraging
Length: 100-200 words depending on article size`
  },
  {
    name: 'faqs',
    displayName: 'FAQ Generation',
    description: 'Generates frequently asked questions and answers',
    templateType: 'faqs' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'article_content', 'audience_data', 'lsi_keywords'],
    defaultPrompt: `Generate FAQ section for an article about "{seed_keyword}".

Article Content Context: {article_content}
Target Audience: {audience_data}
Related Keywords: {lsi_keywords}

Requirements:
- Create 3-7 questions (based on article length)
- Questions should address common concerns and queries
- Answers should be concise but comprehensive
- Include LSI keywords in questions and answers naturally
- Address different levels of user knowledge
- Cover practical implementation questions
- Include questions that complement the main article content

Format:
**Q: [Question]**
A: [Answer]

Focus on questions your target audience would actually ask.`
  },
  {
    name: 'whats_next',
    displayName: 'What\'s Next Section',
    description: 'Generates next steps and related topics section',
    templateType: 'whats_next' as const,
    category: 'content_generation' as const,
    variables: ['seed_keyword', 'article_topic', 'audience_data'],
    defaultPrompt: `Create a "What's Next" section for an article about "{seed_keyword}".

Article Topic: {article_topic}
Target Audience: {audience_data}

Include:
1. Immediate next steps readers can take
2. Related topics they might want to explore
3. Resources for deeper learning
4. Logical progression of knowledge/skills

Structure:
- 2-3 immediate action items
- 3-4 related topics with brief explanations
- Additional resources or tools

Tone: Encouraging and forward-looking
Length: 100-150 words`
  },
  {
    name: 'meta_title',
    displayName: 'Meta Title Generation',
    description: 'Generates SEO-optimized meta titles',
    templateType: 'meta_title' as const,
    category: 'meta_generation' as const,
    variables: ['seed_keyword', 'article_focus', 'audience_data'],
    defaultPrompt: `Create an SEO-optimized meta title for an article about "{seed_keyword}".

Article Focus: {article_focus}
Target Audience: {audience_data}

Requirements:
- 50-60 characters (including spaces)
- Include the main keyword naturally
- Be compelling and click-worthy
- Accurately represent the article content
- Appeal to the target audience
- Use power words when appropriate

Provide 3 title options with character counts.`
  },
  {
    name: 'meta_description',
    displayName: 'Meta Description Generation',
    description: 'Generates SEO-optimized meta descriptions',
    templateType: 'meta_description' as const,
    category: 'meta_generation' as const,
    variables: ['seed_keyword', 'article_summary', 'audience_data', 'main_benefit'],
    defaultPrompt: `Create an SEO-optimized meta description for an article about "{seed_keyword}".

Article Summary: {article_summary}
Target Audience: {audience_data}
Main Benefit/Value: {main_benefit}

Requirements:
- 150-160 characters (including spaces)
- Include the main keyword naturally
- Clearly communicate the article's value
- Include a compelling reason to click
- End with action-oriented language
- Appeal to search intent

Provide 2 description options with character counts.`
  }
];

export async function seedFixedTemplates(): Promise<void> {
  try {
    console.log('🌱 Starting fixed template seeding...');

    // Connect to MongoDB
    await mongoose.connect(config.mongoUri);
    console.log('📊 Connected to MongoDB');

    // Clear existing templates (if needed - be careful in production!)
    const existingCount = await PromptTemplate.countDocuments({ isSystem: true });
    console.log(`📋 Found ${existingCount} existing system templates`);

    for (const templateData of FIXED_TEMPLATES) {
      try {
        // Check if template already exists
        let template = await PromptTemplate.findOne({ name: templateData.name });
        
        if (!template) {
          // Create new template
          template = new PromptTemplate({
            ...templateData,
            isSystem: true
          });
          await template.save();
          console.log(`✅ Created template: ${templateData.displayName}`);
        } else {
          // Update existing template
          await PromptTemplate.updateOne(
            { _id: template._id },
            {
              displayName: templateData.displayName,
              description: templateData.description,
              templateType: templateData.templateType,
              category: templateData.category,
              variables: templateData.variables,
              isSystem: true
            }
          );
          console.log(`🔄 Updated template: ${templateData.displayName}`);
        }

        // Create or update default prompt version
        let version = await PromptVersion.findOne({ 
          templateId: template._id,
          version: 1 
        });

        if (!version) {
          version = new PromptVersion({
            templateId: template._id,
            version: 1,
            prompt: templateData.defaultPrompt,
            isActive: true,
            createdBy: 'system',
            metadata: {
              description: 'Default system prompt',
              tags: ['system', 'default']
            }
          });
          await version.save();
          console.log(`📝 Created default version for: ${templateData.displayName}`);
        } else if (!version.isActive) {
          // Ensure default version is active
          await PromptVersion.updateOne(
            { _id: version._id },
            { isActive: true }
          );
          console.log(`🔄 Activated default version for: ${templateData.displayName}`);
        }

      } catch (error) {
        console.error(`❌ Error processing template ${templateData.name}:`, error);
      }
    }

    console.log('✨ Fixed template seeding completed successfully!');
    
  } catch (error) {
    console.error('💥 Error seeding fixed templates:', error);
    throw error;
  }
}

// Allow direct execution - run the seeding
console.log('🌟 Starting seeding process...');
seedFixedTemplates()
  .then(() => {
    console.log('🎉 Seeding completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Seeding failed:', error);
    process.exit(1);
  });

export default seedFixedTemplates;