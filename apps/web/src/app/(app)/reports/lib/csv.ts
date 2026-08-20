/** Client-side CSV export — no backend endpoint exists for this yet (mirrors apps/web/src/app/(app)/stocktakes/utils.ts). */
export function exportRowsToCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number>>,
): void {
  const escape = (cell: string) => {
    if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
    return cell;
  };
  const csv = [headers, ...rows]
    .map((r) => r.map((cell) => escape(String(cell))).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
