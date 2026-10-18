export type PublicationApproval = {
  candidateSha256?: string
  licenseSha256?: string
  ownerLicenseDecision?: string
  dataRedistributionEvidence?: string
  dependencyReview?: string
  fileReview?: string
  dataPolicySha256?: string
}
export function publicationBlockers(
  approval: PublicationApproval,
  candidate: string,
  license?: string,
  dataPolicy?: string,
) {
  const blockers: string[] = []
  if (!license) blockers.push('project-license-evidence-required')
  if (!approval.dataRedistributionEvidence) blockers.push('data-redistribution-review-required')
  if (!approval.dependencyReview) blockers.push('dependency-license-review-required')
  if (!approval.fileReview || approval.candidateSha256 !== candidate)
    blockers.push('exact-candidate-owner-review-required')
  if (dataPolicy && approval.dataPolicySha256 !== dataPolicy)
    blockers.push('data-scope-owner-review-required')
  if (blockers.some((rule) => /owner-review|required$/.test(rule)))
    blockers.push('OWNER_APPROVAL_REQUIRED')
  return blockers
}
