/**
 * Live settings for the niche profile: the niche data JSON and the two proof pieces from the prompt
 * registry (in-code defaults as fallback), and the disclaimer texts (G4).
 *
 * DISCLAIMERS (G4). One text per Regulated niche, inserted by code before the last two sections
 * (phase 8), never through a prompt. The texts are not written yet, so the setting
 * content_v3_disclaimers ships EMPTY ("{}") and no disclaimer is inserted until a text exists —
 * never an empty or placeholder one. Keys: a niche key ("dental") or a profile key ("health") as a
 * fallback for every niche of that profile.
 */
import { PromptManagementService } from '../prompt-management.service.js';
import { DEFAULT_NICHE_SETTINGS, NICHE_SETTINGS_DEF, parseNicheSettings, type NicheSettings } from './niche-profile.js';
import { NICHE_REGULATED_PIECE_DEF, NICHE_STANDARD_PIECE_DEF } from './pieces.js';

export const DISCLAIMERS_DEF = {
  templateType: 'content_v3_disclaimers' as const,
  displayName: 'Content v3 — Disclaimers per regulated niche (JSON setting; texts not written yet)',
  fallback: '{}',
};

async function active(svc: PromptManagementService, type: string): Promise<string | null> {
  try {
    const v = await svc.getPromptWithVersion(type);
    return v.text && v.text.trim() ? v.text : null;
  } catch {
    return null;
  }
}

export interface LiveNicheSettings {
  settings: NicheSettings;
  standardPiece: string;
  regulatedPiece: string;
  disclaimers: Record<string, string>;
}

export function parseDisclaimers(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(v ?? {})) if (typeof t === 'string' && t.trim().length >= 20) out[k] = t.trim();
    return out;
  } catch {
    return {};
  }
}

/** The disclaimer for this niche (or its profile), or null — never an empty string. */
export function disclaimerFor(disclaimers: Record<string, string>, nicheKey: string | null | undefined, profileKey: string | null | undefined): string | null {
  return (nicheKey && disclaimers[nicheKey]) || (profileKey && disclaimers[profileKey]) || null;
}

export async function liveNicheSettings(svc: PromptManagementService = new PromptManagementService()): Promise<LiveNicheSettings> {
  const [json, std, reg, disc] = await Promise.all([
    active(svc, NICHE_SETTINGS_DEF.templateType),
    active(svc, NICHE_STANDARD_PIECE_DEF.templateType),
    active(svc, NICHE_REGULATED_PIECE_DEF.templateType),
    active(svc, DISCLAIMERS_DEF.templateType),
  ]);
  return {
    settings: parseNicheSettings(json) ?? DEFAULT_NICHE_SETTINGS,
    standardPiece: std ?? NICHE_STANDARD_PIECE_DEF.fallback,
    regulatedPiece: reg ?? NICHE_REGULATED_PIECE_DEF.fallback,
    disclaimers: parseDisclaimers(disc),
  };
}
