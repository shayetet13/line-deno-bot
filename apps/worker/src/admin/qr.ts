import QRCode from 'qrcode';

/**
 * Renders a QR code as inline SVG markup, server-side.
 *
 * Deliberately not a client-side library loaded from a CDN: this page exists
 * to renew LINE account credentials, so it should not depend on a third-party
 * script fetched at runtime — the SVG is generated here, on the same trusted
 * process already holding the session, and shipped as plain markup the page
 * only has to insert.
 */
export function renderQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 1 });
}
