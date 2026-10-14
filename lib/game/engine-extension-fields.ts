/** Engine state is never an author variable, even when stored in the same legacy container. */
export const ENGINE_EXTENSION_FIELDS: ReadonlySet<string> = new Set([
  'flowState', 'tileEffects', 'battlePresentation', 'presentationQueue',
  'battleProfile', 'debugBattle', 'adventureWorld', 'adventureCards',
  'skillPresentation', 'contentMode', 'removedPieces', 'authorOutOfPlay', '__dryRunSkillPreflight',
])
