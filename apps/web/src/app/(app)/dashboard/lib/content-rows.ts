/** The canvas grid's row step: `rowHeight` and the vertical margin passed to react-grid-layout. */
export const CANVAS_ROW_HEIGHT = 12;
export const CANVAS_MARGIN_Y = 14;

/**
 * The fewest grid rows that hold a card `px` tall.
 *
 * react-grid-layout makes an item `h * rowHeight + (h - 1) * margin` pixels tall, so a card
 * sized from its content is at most one row step (26 px) shorter than its cell, never taller.
 * Before UI1 #205 every card took a fixed row count from the registry: short content left an
 * empty card, long content scrolled inside it.
 */
export function rowsForHeight(
  px: number,
  rowHeight = CANVAS_ROW_HEIGHT,
  marginY = CANVAS_MARGIN_Y,
): number {
  if (!Number.isFinite(px) || px <= 0) return 1;
  return Math.max(1, Math.ceil((px + marginY) / (rowHeight + marginY)));
}
