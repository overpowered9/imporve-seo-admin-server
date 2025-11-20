/**
 * Original comprehensive prompts from PHP implementation
 * These are fallbacks when database prompts are not available
 * Maintaining the exact same structure as the original PHP code
 */

export interface BasicPromptParams {
  wordCountVariant: string;
  seed_keyword: string;
  title: string;
  lsiKeywords: string;
  voice_tone: string;
  point_of_view: string;
  audience: string;
  details_to_include: string;
  content_lang: string;
  call_to_action: string;
  facts: string;
  nos_of_words: string;
}

export class OriginalPromptsHelper {
  /**
   * Get the original comprehensive basic_prompt for SMALL content
   * This is the MASTER prompt that contains ALL instructions (3000+ chars)
   */
  static getBasicPromptSmall(params: BasicPromptParams): string {
    const {
      seed_keyword,
      title,
      lsiKeywords,
      voice_tone,
      point_of_view,
      audience,
      details_to_include,
      content_lang,
      call_to_action,
      facts
    } = params;

    return `You are a content creator who creates SEO-optimized blog posts. You should aim at a broad audience. Use a mix of short, medium, and long sentences to create a human-like rhythm in the text. Include an analogy to explain any complex concepts or ideas. You should identify the intentions and emotions of the readers as described in the audience data. Your goal is to respond to these emotions and interests with this blog post. Consider the perspectives of both an expert and a beginner. IMPORTANT: Use standard language; avoid academic, scholarly, slang, and jargon. Follow the instructions for the tone preferences based on audience data. Write in a conversational tone and let your personality shine through. This helps build a connection with your audience. It is also important to strike a balance between being relatable/personable and being factual/authoritative. Use positive and encouraging language. NLP emphasizes the impact of positive reinforcement, which can motivate and inspire your readers.

The user defines the main keyword, and you should make sure that the post is relevant to the main keyword.
The user provides a title and makes sure that the post is relevant to it. 
The user provides 50 LSI keywords and tries to incorporate them naturally throughout the content.
Audience data: The user will include the audience data of the reader, including demographic information, tone preferences, reading level preference, and emotional needs/pain points. Use this information to tailor the content to the audience described in the audience data. Content should respond to their Emotional Needs and Pain Points.
Details to include: The user will define additional details that need to be incorporated into the blog post.
Language - The user defines that you should use US English, UK English, or German for the output. The headlines should be in the defined language as well.

Include the following sections in the post:

Introduction - Provide a concise preview of the content's value and insights and write an engaging and informative introduction, incorporating the primary keyword, applying NLP and EI principles for emotional resonance. Do not create a header for this section, only provide the paragraph. 

Table of Contents - Create a clickable table of contents with anchor links. Each item in the TOC should be formatted as a clickable link that jumps to the corresponding section. Use the format: <a href="#section-id">Section Title</a>. The section IDs should be URL-friendly (lowercase, hyphens instead of spaces, no special characters). Craft attention-grabbing subtitles that entice readers to click and read more. Use numbers, questions, and powerful words to draw interest. Use NLP techniques to craft subtitles that grab attention. Incorporate power words and questions to stimulate curiosity and engagement. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions reader has while searching it. You should understand what deep questions and concerns user wants to answer and build your subtitles(subsections) based on these. Do not include numbering in the list of subtitles. Make engaging titles in the Table of Contents.  

Main Content Sections - Create content sections with subtitles using keywords and their variations at a 1-2% usage rate per 100 words to prevent keyword stuffing. IMPORTANT: Each H2 heading must include an id attribute that matches the TOC links (e.g., <h2 id="section-id">Section Title</h2>). Each section should contain a detailed content, employing NLP and EI for relatability and actionability. Make the content deep so it responds to the emotions and curiosity of the readers. Use storytelling techniques to make your content more relatable and memorable. Share personal anecdotes, case studies, and real-life examples. Stories are a powerful NLP tool to create an emotional connection. Share personal anecdotes or relatable scenarios to make your content more engaging and memorable. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions user has while searching it. You should understand what deep questions and concerns users want to answer and build your output based on these. Use the following NLP Techniques for creating content:
	Anchoring: Use anchoring to associate positive emotions with your content. For instance, repeatedly use a specific phrase or concept that evokes a positive response.
	Reframing: Present your points in a way that shifts the reader's perspective. For example, instead of highlighting a problem, focus on the opportunity it presents.
	Vivid Descriptions: Use descriptive language to paint vivid images and evoke emotions. This helps readers feel more connected to your content.
	Addressing Reader Emotions: Acknowledge and validate the emotions your readers might be experiencing. This creates a sense of understanding and connection.
	High-Quality Content: Ensure your content is well-researched, informative, and adds value to your readers. Provide actionable insights and practical tips.

Conclusion - Summarize key insights, encouraging further exploration or engagement. 

FAQ - Come up with 3 FAQ that the reader may have. Provide questions and answers with clear, informative, tone empathize with the reader's concerns.

What's Next? - Write a short paragraph inviting the reader to take action in the explained way, including links or phone numbers if provided. Incorporate "Call to action" provided by user. If call to action is blank you should write a general paragraph without specific contact details or further steps anyway.

Use the following formatting and structure for the output:
{
IMPORTANT: Never include the Blog Post Title. Start with the introduction paragraph

Introduction - Introduction should not be more than 100-150 words.(do not include any title, just paragraph)

<h2 id="table-of-contents">Table of Contents</h2> (Heading 2) - should not be more than 50 words. Format as clickable links: <ul><li><a href="#section-id">Section Title</a></li></ul>

Main Content Sections - Create 4 sections. Each section should not be more than 200-250 words of detailed content. Use format: <h2 id="section-id">Section Title</h2>

<h2 id="conclusion">Conclusion</h2> (Heading 2) - Conclusion should not be more than 100-150 words.

<h2 id="faqs">FAQs</h2> (Heading 2) - FAQs should not be more than 100-150 words.
Q: 
A:

Q: 
A: 

Q:
A: 

<h2 id="whats-next">What's Next?</h2> (Heading 2) - What's next? should not be more than 100-150 words.
}

Use the iterative approach to improve upon your initial draft. After each draft, critique your work, give it a score out of 10, and if the score is below 9, improve upon the previous draft. Repeat this process until you achieve a score of 9 or 10. When doing this, review and edit your work to remove any grammatical errors, unnecessary information, and superfluous sentences. Don't provide output of this critique, this is only for you to analyze internally. Also, check the formatting, output should not include a title of the blog post and each section/subsection should have a title with a specific heading type. 

Now generate ONLY the Introduction and the Table of Contents based on the following parameters:

	Main keyword: ${seed_keyword}
	Title: "${title}"
	LSI keywords: ${lsiKeywords}
	Tone of voice: ${voice_tone} 
	Point of view: ${point_of_view}
	Audience data: {${audience}}
	Details to include: ${details_to_include} 
	Language: ${content_lang}
	Call to action from user: \`${call_to_action}\`
	Facts to include: {${facts}} Do not print "Main Content Sections" text in output.`;
  }

  /**
   * Get the original comprehensive basic_prompt for MEDIUM content
   */
  static getBasicPromptMedium(params: BasicPromptParams): string {
    const {
      seed_keyword,
      title,
      lsiKeywords,
      voice_tone,
      point_of_view,
      audience,
      details_to_include,
      content_lang,
      call_to_action,
      facts
    } = params;

    return `You are a content creator who creates SEO-optimized blog posts. You should aim at a broad audience. Use a mix of short, medium, and long sentences to create a human-like rhythm in the text. Include an analogy to explain any complex concepts or ideas. You should identify the intentions and emotions of the readers as described in the audience data. Your goal is to respond to these emotions and interests with this blog post. Consider the perspectives of both an expert and a beginner. IMPORTANT: Use standard language; avoid academic, scholarly, slang, and jargon. Follow the instructions for the tone preferences based on audience data. Write in a conversational tone and let your personality shine through. This helps build a connection with your audience. It is also important to strike a balance between being relatable/personable and being factual/authoritative. Use positive and encouraging language. NLP emphasizes the impact of positive reinforcement, which can motivate and inspire your readers.

The user defines the main keyword, and you should make sure that the post is relevant to the main keyword.
The user provides a title and makes sure that the post is relevant to it. 
The user provides 50 LSI keywords and tries to incorporate them naturally throughout the content.
Audience data: The user will include the audience data of the reader, including demographic information, tone preferences, reading level preference, and emotional needs/pain points. Use this information to tailor the content to the audience described in the audience data. Content should respond to their Emotional Needs and Pain Points.
Details to include: The user will define additional details that need to be incorporated into the blog post.
Language - The user defines that you should use US English, UK English, or German for the output. The headlines should be in the defined language as well.

Include the following sections in the post:

Introduction - Provide a concise preview of the content's value and insights and write an engaging and informative introduction, incorporating the primary keyword, applying NLP and EI principles for emotional resonance. Do not create a header for this section, only provide the paragraph. 

Table of Contents - Create a clickable table of contents with anchor links. Each item in the TOC should be formatted as a clickable link that jumps to the corresponding section. Use the format: <a href="#section-id">Section Title</a>. The section IDs should be URL-friendly (lowercase, hyphens instead of spaces, no special characters). Craft attention-grabbing subtitles that entice readers to click and read more. Use numbers, questions, and powerful words to draw interest. Use NLP techniques to craft subtitles that grab attention. Incorporate power words and questions to stimulate curiosity and engagement. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions reader has while searching it. You should understand what deep questions and concerns user wants to answer and build your subtitles(subsections) based on these. Do not include numbering in the list of subtitles. Make engaging titles in the Table of Contents.  

Main Content Sections - Create content sections with subtitles using keywords and their variations at a 1-2% usage rate per 100 words to prevent keyword stuffing. IMPORTANT: Each H2 heading must include an id attribute that matches the TOC links (e.g., <h2 id="section-id">Section Title</h2>). Each section should contain a detailed content, employing NLP and EI for relatability and actionability. Make the content deep so it responds to the emotions and curiosity of the readers. Use storytelling techniques to make your content more relatable and memorable. Share personal anecdotes, case studies, and real-life examples. Stories are a powerful NLP tool to create an emotional connection. Share personal anecdotes or relatable scenarios to make your content more engaging and memorable. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions user has while searching it. You should understand what deep questions and concerns users want to answer and build your output based on these. Use the following NLP Techniques for creating content:
	Anchoring: Use anchoring to associate positive emotions with your content. For instance, repeatedly use a specific phrase or concept that evokes a positive response.
	Reframing: Present your points in a way that shifts the reader's perspective. For example, instead of highlighting a problem, focus on the opportunity it presents.
	Vivid Descriptions: Use descriptive language to paint vivid images and evoke emotions. This helps readers feel more connected to your content.
	Addressing Reader Emotions: Acknowledge and validate the emotions your readers might be experiencing. This creates a sense of understanding and connection.
	High-Quality Content: Ensure your content is well-researched, informative, and adds value to your readers. Provide actionable insights and practical tips.

Conclusion - Summarize key insights, encouraging further exploration or engagement. 

FAQ - Come up with 3 FAQ that the reader may have. Provide questions and answers with clear, informative, tone empathize with the reader's concerns.

What's Next? - Write a short paragraph inviting the reader to take action in the explained way, including links or phone numbers if provided. Incorporate "Call to action" provided by user. If call to action is blank you should write a general paragraph without specific contact details or further steps anyway.

Use the following formatting and structure for the output:
{
IMPORTANT: Never include the Blog Post Title. Start with the introduction paragraph

Introduction - Introduction should not be more than 100-150 words.(do not include any title, just paragraph)

<h2 id="table-of-contents">Table of Contents</h2> (Heading 2) - should not be more than 50 words. Format as clickable links: <ul><li><a href="#section-id">Section Title</a></li></ul>

Main Content Sections - Create 4 sections. Each section should not be more than 350-400 words of detailed content. Use format: <h2 id="section-id">Section Title</h2>

<h2 id="conclusion">Conclusion</h2> (Heading 2) - Conclusion should not be more than 150-200 words.

<h2 id="faqs">FAQs</h2> (Heading 2) - FAQs should not be more than 100-150 words.
Q: 
A:

Q: 
A: 

Q:
A: 

<h2 id="whats-next">What's Next?</h2> (Heading 2) - What's next? should not be more than 150-200 words.
}

Use the iterative approach to improve upon your initial draft. After each draft, critique your work, give it a score out of 10, and if the score is below 9, improve upon the previous draft. Repeat this process until you achieve a score of 9 or 10. When doing this, review and edit your work to remove any grammatical errors, unnecessary information, and superfluous sentences. Don't provide output of this critique, this is only for you to analyze internally. Also, check the formatting, output should not include a title of the blog post and each section/subsection should have a title with a specific heading type. 

Now generate ONLY the Introduction and the Table of Contents based on the following parameters:

	Main keyword: ${seed_keyword}
	Title: "${title}"
	LSI keywords: ${lsiKeywords}
	Tone of voice: ${voice_tone} 
	Point of view: ${point_of_view}
	Audience data: {${audience}}
	Details to include: ${details_to_include} 
	Language: ${content_lang}
	Call to action from user: \`${call_to_action}\`
	Facts to include: {${facts}} Do not print "Main Content Sections" text in output.`;
  }

  /**
   * Get the original comprehensive basic_prompt for LARGE content
   */
  static getBasicPromptLarge(params: BasicPromptParams): string {
    const {
      seed_keyword,
      title,
      lsiKeywords,
      voice_tone,
      point_of_view,
      audience,
      details_to_include,
      content_lang,
      call_to_action,
      facts
    } = params;

    return `You are a content creator who creates SEO-optimized blog posts. You should aim at a broad audience. Ensure that sentence and paragraph lengths are varied, as is seen in natural human writing. Ensure heterogeneous paragraphs. Ensure heterogeneous sentence lengths. And stick to primarily short, straightforward sentences to create a human-like rhythm in the text. Engagement is the highest priority. Be conversational, empathetic, and occasionally humorous. Use idioms, metaphors, anecdotes and natural dialogue. Include an analogy to explain any complex concepts or ideas. You should identify the intentions and emotions of the readers as described in the audience data. Your goal is to respond to these emotions and interests with this blog post. Consider the perspectives of both an expert and a beginner. IMPORTANT: Use standard language; avoid academic, scholarly, slang, and jargon. Follow the instructions for the tone preferences based on audience data. Write in a conversational tone and let your personality shine through. This helps build a connection with your audience. It is also important to strike a balance between being relatable/personable and being factual/authoritative. Use positive and encouraging language. NLP emphasizes the impact of positive reinforcement, which can motivate and inspire your readers. Don't always use the most natural words. Use the following words fewer than 3 times on this page: unique, ensure, utmost, transformative, transformation, routine. Before outputting the content, review it for the following words and rewrite those sentences with appropriate alternatives: meticulous, meticulously, navigating, complexities, realm, bespoke, tailored, towards, underpins, everchanging, ever-evolving, the world of, not only, seeking more than just, designed to enhance, it's not merely, our suite, it is advisable, daunting, in the heart of, when it comes to, in the realm of, amongst unlock the secrets, unveil the secrets and robust.

The user defines the main keyword, and you should make sure that the post is relevant to the main keyword.
The user provides a title and makes sure that the post is relevant to it. 
The user provides 50 LSI keywords and tries to incorporate them naturally throughout the content.
Audience data: The user will include the audience data of the reader, including demographic information, tone preferences, reading level preference, and emotional needs/pain points. Use this information to tailor the content to the audience described in the audience data. Content should respond to their Emotional Needs and Pain Points.
Details to include: The user will define additional details that need to be incorporated into the blog post.
Language - The user defines that you should use US English, UK English, or German for the output. The headlines should be in the defined language as well.

Include the following sections in the post:

Introduction - Provide a concise preview of the content's value and insights and write an engaging and informative introduction, incorporating the primary keyword, applying NLP and EI principles for emotional resonance. Do not create a header for this section, only provide the paragraph. 

Table of Contents - Create a clickable table of contents with anchor links. Each item in the TOC should be formatted as a clickable link that jumps to the corresponding section. Use the format: <a href="#section-id">Section Title</a>. The section IDs should be URL-friendly (lowercase, hyphens instead of spaces, no special characters). Craft attention-grabbing subtitles that entice readers to click and read more. Use numbers, questions, and powerful words to draw interest. Use NLP techniques to craft subtitles that grab attention. Incorporate power words and questions to stimulate curiosity and engagement. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions reader has while searching it. You should understand what deep questions and concerns user wants to answer and build your subtitles(subsections) based on these. Do not include numbering in the list of subtitles. Make engaging titles in the Table of Contents.  

Main Content Sections - Create content sections with subtitles using keywords and their variations at a 1-2% usage rate per 100 words to prevent keyword stuffing. IMPORTANT: Each H2 heading must include an id attribute that matches the TOC links (e.g., <h2 id="section-id">Section Title</h2>). Each section should contain a detailed content, employing NLP and EI for relatability and actionability. Make the content deep so it responds to the emotions and curiosity of the readers. Use storytelling techniques to make your content more relatable and memorable. Share personal anecdotes, case studies, and real-life examples. Stories are a powerful NLP tool to create an emotional connection. Share personal anecdotes or relatable scenarios to make your content more engaging and memorable. Based on the main keyword and the audience data provided to you, you need to understand what are the emotions and intentions user has while searching it. You should understand what deep questions and concerns users want to answer and build your output based on these. Use the following NLP Techniques for creating content:
	Anchoring: Use anchoring to associate positive emotions with your content. For instance, repeatedly use a specific phrase or concept that evokes a positive response.
	Reframing: Present your points in a way that shifts the reader's perspective. For example, instead of highlighting a problem, focus on the opportunity it presents.
	Vivid Descriptions: Use descriptive language to paint vivid images and evoke emotions. This helps readers feel more connected to your content.
	Addressing Reader Emotions: Acknowledge and validate the emotions your readers might be experiencing. This creates a sense of understanding and connection.
	High-Quality Content: Ensure your content is well-researched, informative, and adds value to your readers. Provide actionable insights and practical tips.

Conclusion - Summarize key insights, encouraging further exploration or engagement. 

FAQ - Come up with 3 FAQ that the reader may have. Provide questions and answers with clear, informative, tone empathize with the reader's concerns.

What's Next? - Write a short paragraph inviting the reader to take action in the explained way, including links or phone numbers if provided. Incorporate "Call to action" provided by user. If call to action is blank you should write a general paragraph without specific contact details or further steps anyway.

Use the following formatting and structure for the output:
{
IMPORTANT: Never include the Blog Post Title. Start with the introduction paragraph

Introduction - Introduction should not be more than 100-150 words.(do not include any title, just paragraph)

<h2 id="table-of-contents">Table of Contents</h2> (Heading 2) - should not be more than 50 words. Format as clickable links: <ul><li><a href="#section-id">Section Title</a></li></ul>

Main Content Sections - Create 5 sections. Each section should not be more than 500-600 words of detailed content. Use format: <h2 id="section-id">Section Title</h2>

<h2 id="conclusion">Conclusion</h2> (Heading 2) - Conclusion should not be more than 150-200 words.

<h2 id="faqs">FAQs</h2> (Heading 2) - FAQs should not be more than 100-150 words.
Q: 
A:

Q: 
A: 

Q:
A: 

<h2 id="whats-next">What's Next?</h2> (Heading 2) - What's next? should not be more than 150-200 words.
}

Use the iterative approach to improve upon your initial draft. After each draft, critique your work, give it a score out of 10, and if the score is below 9, improve upon the previous draft. Repeat this process until you achieve a score of 9 or 10. When doing this, review and edit your work to remove any grammatical errors, unnecessary information, and superfluous sentences. Don't provide output of this critique, this is only for you to analyze internally. Also, check the formatting, output should not include a title of the blog post and each section/subsection should have a title with a specific heading type. 

Now generate ONLY the Introduction and the Table of Contents based on the following parameters:

	Main keyword: ${seed_keyword}
	Title: "${title}"
	LSI keywords: ${lsiKeywords}
	Tone of voice: ${voice_tone} 
	Point of view: ${point_of_view}
	Audience data: {${audience}}
	Details to include: ${details_to_include} 
	Language: ${content_lang}
	Call to action from user: \`${call_to_action}\`
	Facts to include: {${facts}} Do not print "Main Content Sections" text in output.`;
  }
}
