export const JSON_BODY_MAX_BYTES = 64 * 1024;

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()';

export function isMultipartUploadRoute(url: string): boolean {
  return /(?:^|\/)(?:acts|defects|proposals)\/:?[^/]+\/attachments\/?$/.test(url);
}
