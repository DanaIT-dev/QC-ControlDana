const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(['not_affected', 'affected', 'fixed', 'under_investigation']);
const JUSTIFICATIONS = new Set([
  'component_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);

export function releaseStatement(assessment) {
  const errors = [];
  if (!assessment?.cve) {
    errors.push('statement has no CVE');
  }
  if (!DIGEST.test(assessment?.productDigest ?? '')) {
    errors.push('product digest is not a sha256 digest');
  }
  if (
    assessment?.baseImageDigest &&
    assessment.productDigest &&
    assessment.productDigest === assessment.baseImageDigest
  ) {
    errors.push('product digest must be the final image digest, not the base image digest');
  }
  if (assessment?.copiedFromBase === true) {
    errors.push('a base-image statement cannot be copied onto the final image');
  }
  if (!STATUSES.has(assessment?.status)) {
    errors.push('status is unsupported');
  }
  if (assessment?.status === 'not_affected') {
    if (assessment.runtimePathChecked !== true) {
      errors.push('NOT_AFFECTED requires a runtime path check on the final image');
    }
    if (!JUSTIFICATIONS.has(assessment.justification)) {
      errors.push('NOT_AFFECTED is missing a VEX justification');
    }
  }
  for (const field of [
    'impactStatement',
    'evidence',
    'assessedAt',
    'assessor',
    'nextReview',
    'remediationCondition',
  ]) {
    if (!String(assessment?.[field] ?? '').trim()) {
      errors.push(`${field} is required`);
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  const statement = {
    vulnerability: { name: assessment.cve },
    products: [{ '@id': `${assessment.repository}@${assessment.productDigest}` }],
    status: assessment.status,
    impact_statement: assessment.impactStatement,
    timestamp: assessment.assessedAt,
    author: assessment.assessor,
    evidence: assessment.evidence,
    next_review: assessment.nextReview,
    remediation_condition: assessment.remediationCondition,
  };
  if (assessment.status === 'not_affected') {
    statement.justification = assessment.justification;
  }
  if (assessment.status === 'affected') {
    statement.action_statement = assessment.remediationCondition;
  }
  return { statement, errors: [] };
}

export function renderReleaseVex(document) {
  const statements = [];
  const errors = [];
  for (const [index, assessment] of (document?.assessments ?? []).entries()) {
    const rendered = releaseStatement(assessment);
    if (rendered.errors.length > 0) {
      errors.push(...rendered.errors.map((error) => `assessment ${index}: ${error}`));
    } else {
      statements.push(rendered.statement);
    }
  }
  if ((document?.assessments ?? []).length === 0) {
    errors.push('release VEX has no assessments');
  }
  return {
    document: {
      '@context': 'https://openvex.dev/ns/v0.2.0',
      '@id': document?.id ?? 'release-bound-openvex',
      author: document?.author ?? 'QC-ControlDana release workflow',
      timestamp: document?.timestamp,
      version: 1,
      statements,
    },
    errors,
  };
}
