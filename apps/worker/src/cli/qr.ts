import qrcode from 'qrcode-terminal';

/** `qrcode-terminal` ships no types; this is the one call we make. Its callback
 * is invoked synchronously, which is why {@link renderQr} can return a string. */
interface QrGenerator {
  generate(text: string, opts: { small: boolean }, cb: (art: string) => void): void;
}

/** Renders `text` as a QR code drawn with block characters. */
export function renderQr(text: string): string {
  let art = '';
  (qrcode as unknown as QrGenerator).generate(text, { small: true }, (out) => {
    art = out;
  });
  return art;
}
