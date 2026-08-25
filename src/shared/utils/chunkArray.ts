/** Split an array into consecutive chunks of at most `size` elements. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return arr.length === 0 ? [] : [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
