export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Remove control characters, collapse whitespace and cap length. */
export function sanitizeText(input: string, max = 500): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Keep only filename-safe characters. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'image';
  const cleaned = base.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').replace(/^\.+/, '');
  return (cleaned || 'image').slice(0, 60);
}

/** Returns an error message, or null when the file is acceptable. */
export function validateUpload(file: { type: string; size: number }): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) return 'Please upload a PNG, JPG or WebP image.';
  if (file.size > MAX_UPLOAD_BYTES) return 'That image is larger than 10 MB. Try a smaller one.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

export function slug(input: string, fallback = 'item'): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return s || fallback;
}
