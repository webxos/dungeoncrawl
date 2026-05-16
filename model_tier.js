// model_tier.js – Safe defaults for any environment (no LLM required)

export function detectTier(modelName) {
  const name = modelName.toLowerCase();
  // Explicit size suffixes take priority
  if (/\b(0\.5b|0\.4b|1b|tiny)\b/.test(name)) return 'tiny';
  if (/\b(1\.5b|2b|3b|4b|nano)\b/.test(name)) return 'small';   // nano → small
  if (/\b(7b|8b)\b/.test(name)) return 'medium';
  if (/\b(13b|14b|20b|30b)\b/.test(name)) return 'large';
  if (/\b(40b|50b|70b|100b|ultra|giant)\b/.test(name)) return 'ultra';
  // Fallback to small if nothing matches – safe default, works without Ollama
  return 'small';
}

export const TIER_CONFIG = {
  tiny: {
    narrator: false,
    questGen: false,
    llmFallback: false,
    maxTokens: 60,
    temperature: 0.3,
    combatFlavor: false,
    nliOnly: true,
    deepStory: false,
  },
  small: {
    narrator: true,         // Still can be disabled via .env
    questGen: true,         // Static quest templates used, not LLM
    llmFallback: true,      // May attempt LLM if ALWAYS_USE_LLM=true (default false)
    maxTokens: 80,
    temperature: 0.4,
    combatFlavor: true,
    nliOnly: false,
    deepStory: false,
  },
  medium: {
    narrator: true,
    questGen: true,
    llmFallback: true,
    maxTokens: 120,
    temperature: 0.6,
    combatFlavor: true,
    nliOnly: false,
    deepStory: false,
  },
  large: {
    narrator: true,
    questGen: true,
    llmFallback: true,
    maxTokens: 300,
    temperature: 0.75,
    combatFlavor: true,
    deepStory: true,
    nliOnly: false,
  },
  ultra: {
    narrator: true,
    questGen: true,
    llmFallback: true,
    maxTokens: 500,
    temperature: 0.8,
    combatFlavor: true,
    deepStory: true,
    nliOnly: false,
  },
};
