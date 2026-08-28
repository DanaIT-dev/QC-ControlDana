import { ValidationError } from './errors';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function assertSafeHeaderValue(value: string, field = 'subject'): string {
  if (/[\r\n]/.test(value)) {
    throw new ValidationError(field, 'Недопустимые символы в заголовке письма');
  }
  return value;
}

export function buildActUrl(publicAppUrl: string, actId: string, defectItemId?: string): string {
  const base = publicAppUrl.replace(/\/+$/, '');
  const url = new URL(`${base}/acts/${actId}`);
  if (defectItemId) {
    url.searchParams.set('defect', defectItemId);
  }
  return url.toString();
}

export function renderNotificationEmail(input: { title: string; body: string; actUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = assertSafeHeaderValue(input.title);
  const text = `${input.body}\n\nОткрыть акт: ${input.actUrl}`;
  const html = `<p>${escapeHtml(input.body)}</p><p><a href="${escapeHtml(input.actUrl)}">Открыть карточку акта</a></p>`;
  return { subject, text, html };
}
