/** Highest already-claimed collision index for this minute across the project.
 * -1 means no claim yet; a device without a stored counter has claimed index 0.
 * Pure calculation shared by the renderer preview and the authoritative claim.
 */
export function priorMaxCollision(
  timestamp: string,
  lastTimestampByDevice: Record<string, string> = {},
  collisionByDevice: Record<string, number> = {},
): number {
  let previous = -1;
  for (const [device, claimedAt] of Object.entries(lastTimestampByDevice)) {
    if (claimedAt === timestamp) previous = Math.max(previous, collisionByDevice[device] || 0);
  }
  return previous;
}
