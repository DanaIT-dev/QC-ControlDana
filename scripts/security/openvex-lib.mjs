const STATUSES = new Set(['not_affected', 'affected', 'fixed', 'under_investigation']);
const JUSTIFICATIONS = new Set([
  'component_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);
const DECISIONS = new Set(['FIXED', 'NOT_AFFECTED', 'AFFECTED_BLOCKING', 'ACCEPTED_TEMPORARILY']);
const DIGEST = /@sha256:[a-f0-9]{64}$/;

export function decisionToVexStatus(status) {
  if (status === 'NOT_AFFECTED') {
    return 'not_affected';
  }
  if (status === 'FIXED') {
    return 'fixed';
  }
  if (status === 'AFFECTED_BLOCKING' || status === 'ACCEPTED_TEMPORARILY') {
    return 'affected';
  }
  return '';
}

export function validateOpenVex(document) {
  const errors = [];
  if (!document || !Array.isArray(document.statements)) {
    return ['OpenVEX document has no statements'];
  }
  for (const [index, statement] of document.statements.entries()) {
    const label = `statement ${index}`;
    if (!STATUSES.has(statement.status)) {
      errors.push(`${label} has an unsupported status`);
    }
    if (!statement.impact_statement || String(statement.impact_statement).trim().length < 20) {
      errors.push(`${label} is missing an impact statement`);
    }
    if (statement.status === 'not_affected' && !JUSTIFICATIONS.has(statement.justification)) {
      errors.push(`${label} not_affected is missing a VEX justification`);
    }
    const products = statement.products ?? [];
    if (products.length === 0) {
      errors.push(`${label} has no product`);
    }
    for (const product of products) {
      if (!DIGEST.test(product?.['@id'] ?? '')) {
        errors.push(`${label} product is not bound to a sha256 digest`);
      }
    }
    if (!statement.vulnerability?.name) {
      errors.push(`${label} has no vulnerability id`);
    }
  }
  return errors;
}

export function validateDecisions(decisions) {
  const errors = [];
  for (const [index, statement] of (decisions.statements ?? []).entries()) {
    if (!DECISIONS.has(statement.status)) {
      errors.push(`decision ${index} has an unsupported status`);
    }
    if (statement.status === 'NOT_AFFECTED' && !JUSTIFICATIONS.has(statement.justification)) {
      errors.push(`decision ${index} NOT_AFFECTED is missing a justification`);
    }
    if (statement.status === 'ACCEPTED_TEMPORARILY') {
      if (!statement.impact || (!statement.nextReview && !decisions.nextReview)) {
        errors.push(`decision ${index} temporary acceptance is missing impact or review date`);
      }
      if (/unauthenticated remote code execution/i.test(statement.impact ?? '')) {
        errors.push(`decision ${index} cannot accept unauthenticated remote code execution`);
      }
    }
    if (!statement.evidence) {
      errors.push(`decision ${index} is missing evidence`);
    }
  }
  return errors;
}

export function productId(repository, digest) {
  const name = repository.split('/').at(-1);
  const value = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
  return `pkg:oci/${name}@${value}`;
}
