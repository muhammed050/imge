// Equal-area recursive partition: every photo gets exactly 1 / count of the wall.
export function splitTiles(count, width, height, x = 0, y = 0) {
  if (!count) return [];
  if (count === 1) return [{ x, y, width, height }];
  const first = Math.floor(count / 2), ratio = first / count;
  return width >= height
    ? [...splitTiles(first, width * ratio, height, x, y), ...splitTiles(count - first, width * (1 - ratio), height, x + width * ratio, y)]
    : [...splitTiles(first, width, height * ratio, x, y), ...splitTiles(count - first, width, height * (1 - ratio), x, y + height * ratio)];
}
