import { decisionToVexStatus, productId } from './openvex-lib.mjs';

const DANGEROUS =
  /arbitrary code|remote code|authentication bypass|authorization bypass|privilege escalation|unauthenticated|memory corruption/i;

export function imageDigest(pins, imageName) {
  const image =
    pins.images[
      imageName === 'api' ||
      imageName === 'worker' ||
      imageName === 'migrator' ||
      imageName === 'web'
        ? 'node'
        : imageName
    ];
  if (!image) {
    return null;
  }
  if (imageName === 'minio') {
    return image.platforms['linux/arm64'];
  }
  if (
    imageName === 'api' ||
    imageName === 'web' ||
    imageName === 'worker' ||
    imageName === 'migrator'
  ) {
    return image.platforms['linux/amd64'];
  }
  return image.manifestList;
}

export function repositoryFor(pins, imageName) {
  if (imageName === 'api' || imageName === 'worker') {
    return 'sgr-registry-runtime';
  }
  if (imageName === 'web') {
    return 'sgr-registry-web';
  }
  if (imageName === 'migrator') {
    return 'sgr-registry-migrator';
  }
  return pins.images[imageName]?.repository ?? imageName;
}

export function coversFinding(decisions, imageName, finding) {
  const explicit = (decisions.statements ?? []).find(
    (statement) => statement.cve === finding.cve && statement.images.includes(imageName),
  );
  if (explicit) {
    return { kind: 'statement', statement: explicit };
  }
  const title = finding.title ?? '';
  for (const rule of decisions.packageRules ?? []) {
    if (!rule.images.includes(imageName) || !rule.packages.includes(finding.package)) {
      continue;
    }
    if (rule.cves && !rule.cves.includes(finding.cve)) {
      continue;
    }
    if (rule.targetIncludes && !String(finding.target ?? '').includes(rule.targetIncludes)) {
      continue;
    }
    if (!rule.overridesTitleCheck && DANGEROUS.test(title)) {
      continue;
    }
    return { kind: 'rule', statement: rule };
  }
  return null;
}

export function vexStatement(pins, decisions, imageName, finding, cover) {
  const digest = finding.digest ?? imageDigest(pins, imageName);
  const status = decisionToVexStatus(cover.statement.status);
  const statement = {
    vulnerability: { name: finding.cve },
    products: [{ '@id': productId(repositoryFor(pins, imageName), digest) }],
    status,
    impact_statement: cover.statement.impact,
    timestamp: decisions.reviewedAt,
    author: decisions.author,
    role: decisions.role,
    evidence: cover.statement.evidence,
  };
  if (status === 'not_affected') {
    statement.justification = cover.statement.justification;
  }
  if (cover.statement.status === 'ACCEPTED_TEMPORARILY') {
    statement.action_statement = `Temporarily accepted until ${decisions.nextReview}. ${cover.statement.impact}`;
  }
  return statement;
}

export function scanFindings(report) {
  const findings = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity !== 'HIGH' && vulnerability.Severity !== 'CRITICAL') {
        continue;
      }
      findings.push({
        cve: vulnerability.VulnerabilityID,
        package: vulnerability.PkgName,
        installedVersion: vulnerability.InstalledVersion ?? '',
        fixedVersion: vulnerability.FixedVersion ?? '',
        severity: vulnerability.Severity,
        title: vulnerability.Title ?? '',
        target: result.Target ?? '',
      });
    }
  }
  return findings;
}
