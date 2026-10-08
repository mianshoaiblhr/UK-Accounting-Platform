/** Minimal magic-byte check so a declared content type cannot lie about the bytes. null = no opinion. */
export function sniffMatches(contentType: string, data: Buffer): boolean | null {
  const starts = (sig: number[], off = 0) => sig.every((b, i) => data[off + i] === b);
  switch (contentType) {
    case 'application/pdf': return data.subarray(0, 1024).includes('%PDF-');
    case 'image/png': return starts([0x89, 0x50, 0x4e, 0x47]);
    case 'image/jpeg': return starts([0xff, 0xd8, 0xff]);
    case 'application/zip':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return starts([0x50, 0x4b]);
    default: return null;
  }
}
