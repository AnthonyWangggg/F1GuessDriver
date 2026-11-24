// Explicit test injection only. Does not modify any environment or production defaults.
export const fullFeatures = {
  identityEnabled: true,
  pointsEnabled: true,
  modesEntryEnabled: true,
  quickV2Enabled: true,
  dailyV2Enabled: true,
  bo3Enabled: true,
  bo3RecoveryEnabled: true,
  dailyEnabled: true,
  matchingEnabled: true,
} as const
