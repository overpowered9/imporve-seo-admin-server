/**
 * OpenAI image generation (v2) — isolated from the Flux path (fluxai.service.ts / /generate/generateimage).
 *
 * Unlike Flux, OpenAI's image API is SYNCHRONOUS: one POST to /v1/images/generations returns the image
 * bytes (base64) in the response — no task-ID + polling loop. We build a documentary-style prompt from a
 * per-niche scene template (the spec's approach: drop "cinematic/800px", use natural-light wrapper) and
 * return base64 + a data URI. Hosting to a public URL (for the plugin) is optional and best-effort.
 *
 * All failures surface as ImageGenError with an http `status` so the route can return clean JSON.
 */
import axios from 'axios';
import { supabaseAdmin } from './supabase.service.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'generated-images';

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type ImageStyle = 'documentary' | 'illustration';

export interface GenerateImageParams {
  /** Finished prompt — if given, niche/title/location are ignored. */
  prompt?: string;
  niche?: string;
  title?: string;
  city?: string;
  state?: string;
  size?: ImageSize;
  quality?: ImageQuality;
  style?: ImageStyle;
  /**
   * Optional free-text steer supplied by the user for THIS image (the regenerate popup).
   * UNTRUSTED — must already have passed sanitizeCustomInstruction(). Appended as a delimited
   * block that refines the scene without displacing the composition/safety wrapper.
   */
  custom_instruction?: string;
}

export interface GenerateImageResult {
  b64: string;
  dataUri: string;
  promptUsed: string;
  size: string;
  model: string;
  format: 'jpeg';
  usage?: unknown;
}

export class ImageGenError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
    this.name = 'ImageGenError';
  }
}

// ----- per-niche scene templates (documentary, no faces, natural light) -----
const SCENE_TEMPLATES: Record<string, string> = {
  hvac: 'An HVAC technician seen from behind kneeling beside an outdoor AC condenser at the side of a suburban home, grey work shirt, concrete pad, residential yard',
  plumbing: 'Close-up of a plumber\'s hands working on pipes under a kitchen sink, natural light from a nearby window, tools on a cloth, a realistic worn cabinet interior',
  electrical: 'An electrician\'s hands wiring an open residential breaker panel, work gloves, natural daylight, a few tools resting nearby',
  roofing: 'A wide street-level shot of two workers seen from a distance on a sloped residential roof replacing shingles under an overcast sky in a suburban neighbourhood',
  landscaping: 'A landscaper seen from behind trimming a hedge in a residential front yard, morning light, a wheelbarrow and tools nearby',
  dental: 'A clean modern dental treatment room with an empty chair and an equipment tray, large window with soft natural light, no people',
  medical: 'A tidy, calm medical clinic exam room with an empty exam table and simple equipment, soft daylight through a window, no people',
  personal_injury_law: 'A wooden desk with open documents and reading glasses resting on papers, soft window light from the left, muted warm tones, no people',
  family_law: 'A quiet office desk with a closed folder, a pen, and a mug, soft side window light, muted tones, no people',
  legal_services: 'A wooden desk with open documents and reading glasses resting on papers, soft window light from the left, muted warm tones, no people',
  contractor: 'A partially renovated kitchen with exposed framing and a workbench with tools, dust sheets on the floor, daylight through a bare window, no people',
  home_services: 'A technician seen from behind carrying equipment up the front path of a suburban home, morning light, tidy front yard',
  wellness: 'A calm massage therapy room with an empty treatment table, folded towels, and a small plant, soft diffused window light, no people',
  auto_repair: 'A car raised on a lift in a working garage bay, a mechanic seen from behind looking at the underside, daylight through the open bay door',
  accounting: 'A tidy desk with a calculator, stacked receipts, and an open ledger, soft window light from the side, muted tones, no people',
  education: 'A student\'s hands writing in a notebook beside an open textbook at a wooden desk, soft window light, no face visible',
  realestate: 'The front exterior of a well-maintained single-storey suburban home on a quiet street, afternoon side light, mature trees, no people',
  mortgage: 'A desk with a small house keychain resting on mortgage paperwork and a calculator, soft natural light, muted tones, no people',
  restaurant: 'A prepared meal on a plain ceramic plate on a wooden table, soft natural side light, slightly imperfect plating, no branded items',
  fitness: 'A person seen from behind doing a dumbbell exercise, natural window light, simple gym equipment in the background, no face visible',
  beauty: 'A tidy salon station with a chair, mirror, and a few tools on the counter, soft natural light, no people',
  pet_services: 'A dog being gently brushed on a grooming table seen from the side, soft daylight, a calm grooming room, no human face visible',
  ecommerce: 'A single product on a plain wooden surface near a window, soft natural light, muted tones, slight shadow, no text or logos',
  general_blog: 'A person\'s hands typing on a laptop at a wooden desk, soft window light from the side, a coffee cup out of focus in the background, no face',
};
const DEFAULT_SCENE =
  'A simple, real-world scene relevant to the topic, photographed in natural light with muted tones, no people or only people seen from behind or at a distance';

const DOCUMENTARY_WRAPPER =
  'Documentary photography style. Natural light. Muted, slightly desaturated colour palette. Shot on a 50mm lens with a slight shallow depth of field and faint film grain. A real-world environment with one minor natural imperfection. Not staged, not studio, not rendered, candid and authentic. No text, no logos, no signs, no lens flare, no neon or glowing effects, no digital overlays, no dramatic or studio lighting, no perfect symmetry. Show people only from behind, from the side, or at a distance, or include no people at all.';

const ILLUSTRATION_WRAPPER =
  'Flat editorial illustration, simple geometric shapes, muted colour palette, no people, no text, minimal style, a single clear subject, on a white or light grey background.';

function nicheKey(niche?: string): string {
  return (niche || '').toLowerCase().trim().replace(/[\s/]+/g, '_');
}

/**
 * Render the user's optional steer as a trailing, clearly-labelled clause.
 *
 * Deliberately placed LAST and phrased as a refinement: the composition/safety wrapper has already
 * been stated, and this says it may adjust the subject and mood but not override those rules. The
 * text is sanitised upstream (sanitizeCustomInstruction) — this only frames it.
 */
function imageInstructionClause(instruction?: string): string {
  const s = (instruction || '').trim();
  if (!s) return '';
  return ` Additional request from the user for this image: "${s}". Apply it to the subject, styling and mood only — it must not introduce text, logos, watermarks or people's faces, and it must not override the composition and safety rules already stated.`;
}

export function buildImagePrompt(p: GenerateImageParams): string {
  // A fully-formed prompt still honours the user's extra steer — this is the "Edit Prompt" flow,
  // where the caller supplied the scene but may still be regenerating with a refinement.
  if (p.prompt && p.prompt.trim()) return `${p.prompt.trim()}${imageInstructionClause(p.custom_instruction)}`;
  const nicheScene = SCENE_TEMPLATES[nicheKey(p.niche)];
  const wrapper = p.style === 'illustration' ? ILLUSTRATION_WRAPPER : DOCUMENTARY_WRAPPER;
  const loc = [p.city, p.state].filter(Boolean).join(', ');
  const locationHint = loc
    ? ` The scene is in ${loc}; hint at the location only through architecture, climate and vegetation — never with text or signs.`
    : '';
  const title = (p.title || '').trim();

  // Niche-only request: the stock scene is the subject (previous behaviour).
  if (!title) {
    return `${nicheScene || DEFAULT_SCENE}.${locationHint} ${wrapper}${imageInstructionClause(p.custom_instruction)}`;
  }

  // Title-led prompt: the title's concrete subject drives the image; the niche scene is only
  // supporting context, so a specific title never gets buried under a generic stock scene.
  const parts = [
    `Cover photo for a blog article titled "${title}".`,
    'Depict the single most concrete, visually recognisable subject from that exact title and make it the clear focus of the scene — a viewer should be able to guess the article topic from the image alone.',
  ];
  if (nicheScene) {
    parts.push(`For flavour only, a typical setting in this industry looks like: ${nicheScene}. Borrow from it only where it fits the title; when the title suggests something more specific, the title wins.`);
  }
  if (locationHint) parts.push(locationHint.trim());
  parts.push(wrapper);
  // Last, so it reads as a refinement of everything above rather than a competing instruction.
  const extra = imageInstructionClause(p.custom_instruction);
  if (extra) parts.push(extra.trim());
  return parts.join(' ');
}

/** Map an axios/OpenAI failure to a clean ImageGenError. */
function normalizeError(err: any): ImageGenError {
  if (err instanceof ImageGenError) return err;
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return new ImageGenError('Image generation timed out. Please try again.', 504, 'timeout');
  }
  const status = err?.response?.status;
  const apiErr = err?.response?.data?.error;
  const apiMsg: string = apiErr?.message || '';
  const apiCode: string = apiErr?.code || apiErr?.type || '';

  if (status === 400 && /moderation|content_policy|safety|blocked/i.test(`${apiCode} ${apiMsg}`)) {
    return new ImageGenError('The prompt was blocked by content moderation. Try a different description.', 400, 'moderation');
  }
  if (status === 401) return new ImageGenError('OpenAI rejected the API key.', 502, 'auth');
  if (status === 429) return new ImageGenError('OpenAI rate limit hit. Please retry shortly.', 429, 'rate_limit');
  if (status === 400) return new ImageGenError(apiMsg || 'Invalid image request.', 400, 'bad_request');
  if (status && status >= 500) return new ImageGenError('OpenAI image service error. Please retry.', 502, 'upstream');
  if (err?.request && !err?.response) return new ImageGenError('Could not reach OpenAI image service.', 502, 'network');
  return new ImageGenError(apiMsg || err?.message || 'Image generation failed.', 500, 'unknown');
}

/**
 * Generate an image synchronously. Returns base64 (jpeg) + a data URI. Throws ImageGenError on failure.
 */
export async function generateOpenAiImage(p: GenerateImageParams): Promise<GenerateImageResult> {
  if (!OPENAI_API_KEY) throw new ImageGenError('OPENAI_API_KEY is not configured.', 500, 'config');

  const prompt = buildImagePrompt(p);
  const size: ImageSize = p.size || '1536x1024';
  const quality: ImageQuality = p.quality || 'medium';

  try {
    const { data } = await axios.post(
      IMAGES_URL,
      {
        model: IMAGE_MODEL,
        prompt,
        size,
        quality,
        n: 1,
        output_format: 'jpeg',
        output_compression: 85,
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 120_000,
      }
    );

    const b64: string | undefined = data?.data?.[0]?.b64_json;
    if (!b64) throw new ImageGenError('OpenAI returned no image data.', 502, 'empty');

    return {
      b64,
      dataUri: `data:image/jpeg;base64,${b64}`,
      promptUsed: prompt,
      size,
      model: IMAGE_MODEL,
      format: 'jpeg',
      usage: data?.usage,
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Best-effort upload to Supabase Storage so the plugin can later consume a real URL (like Flux's CDN URL).
 * Returns the public URL, or null if hosting isn't configured / fails — never throws.
 */
export async function uploadImageToSupabase(b64: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(b64, 'base64');
    const path = `v2/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await supabaseAdmin.storage
      .from(IMAGE_BUCKET)
      .upload(path, buffer, { contentType: 'image/jpeg', upsert: false });
    if (error) {
      console.warn('⚠️ [v2 image] Supabase upload failed (returning base64 only):', error.message);
      return null;
    }
    const { data } = supabaseAdmin.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e: any) {
    console.warn('⚠️ [v2 image] Supabase upload threw (returning base64 only):', e?.message);
    return null;
  }
}
