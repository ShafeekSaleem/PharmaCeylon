function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderTestReceiptHtml(input: { printerName: string; printedAt: Date; appVersion: string }): string {
  const row = (label: string, value: string) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font: 12px/1.4 Consolas, monospace; margin: 0; padding: 4mm; color: #000; }
  h1 { font-size: 14px; text-align: center; margin: 0 0 2mm; }
  p { text-align: center; margin: 0 0 2mm; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.5mm 0; vertical-align: top; }
  td:last-child { text-align: right; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
</style>
</head>
<body>
<h1>Curalio POS</h1>
<p>TEST RECEIPT — NOT A SALE</p>
<hr>
<table>
${row("Printer", input.printerName)}
${row("Printed", input.printedAt.toLocaleString())}
${row("App version", input.appVersion)}
</table>
<hr>
<p>If you can read this, the printer works.</p>
</body>
</html>`;
}
