export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}
