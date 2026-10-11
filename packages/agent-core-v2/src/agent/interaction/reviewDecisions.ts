export const ReviewDecision = {
  APPROVE: 'approve',
  REJECT: 'reject',
  REJECT_AND_EXIT: 'reject_and_exit',
  REVISE: 'revise',
} as const;

export type ReviewDecision = (typeof ReviewDecision)[keyof typeof ReviewDecision];

export const PlanReviewDecision = ReviewDecision;
export type PlanReviewDecision = ReviewDecision;

export const SpecReviewDecision = ReviewDecision;
export type SpecReviewDecision = ReviewDecision;

const LEGACY_LABEL_DECISIONS: Readonly<Record<string, ReviewDecision>> = {
  'Reject and Exit': ReviewDecision.REJECT_AND_EXIT,
  Revise: ReviewDecision.REVISE,
  Reject: ReviewDecision.REJECT,
  Approve: ReviewDecision.APPROVE,
};

export function reviewDecisionFromLabel(label: string | undefined): ReviewDecision | undefined {
  if (label === undefined || label.length === 0) return undefined;
  for (const decision of Object.values(ReviewDecision)) {
    if (decision === label) return decision;
  }
  return LEGACY_LABEL_DECISIONS[label];
}

export const REVIEW_DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = {
  approve: 'Approve',
  reject: 'Reject',
  reject_and_exit: 'Reject and Exit',
  revise: 'Revise',
};
