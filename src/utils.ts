/** Strip characters above U+FFFF (emoji, future Unicode planes) to avoid rendering issues. */
export function safeText(s: string): string {
  return s.replace(/[\u{10000}-\u{10FFFF}]/gu, "").trim();
}
