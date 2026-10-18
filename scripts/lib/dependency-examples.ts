import { createHash } from 'node:crypto'
export type DependencyExampleReview = {
  file: string
  sha256: string
  rules: string[]
  reason: string
  sourceUrl: string
}
export function reviewedDependencyExample(
  file: string,
  body: string,
  rule: string,
  reviews: DependencyExampleReview[],
) {
  const review = reviews.find((entry) => entry.file === file)
  return (
    !!review &&
    !!review.reason &&
    !!review.sourceUrl &&
    review.rules.includes(rule) &&
    createHash('sha256').update(body).digest('hex') === review.sha256
  )
}
