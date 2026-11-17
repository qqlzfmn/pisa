/** 超长时保留首尾：报告把结论写在末尾，只留开头会把结论切掉 */
export function clip(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  const marker = "\n…\n";
  if (max <= marker.length) return value.slice(0, max);
  const head = Math.ceil((max - marker.length) * 0.6);
  const tail = max - marker.length - head;
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}
