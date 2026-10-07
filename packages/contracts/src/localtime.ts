/**
 * 本地钟面 ↔ 带偏移的绝对时间（ADR-019/022）。
 *
 * 这件事只有一份实现，放在契约包里而不是各自抄一遍。理由是实测出来的：
 * 摘要条曾经拿 `toISOString()`（UTC 的钟面）拼本地偏移，东八区上午 10:00 被写成
 * `02:00+08:00`，「今天」的整段边界凭空挪了 8 小时，查出来是凌晨的日程
 * （D05 写测试时抓到的）。同一个函数在两个地方各写一遍，迟早有一份是错的。
 */

/**
 * 把一个瞬间写成「本地钟面 + 本地偏移」的 RFC3339。
 *
 * 必须先把时间戳平移到本地时区再取 ISO 分量 —— 此时分量才是本地钟面。
 * 直接用 `toISOString()` 拿到的是 UTC 钟面，末尾再补一个 `+08:00` 会得到一个
 * **存在但指向别处**的时间，比格式错误更难查。
 */
export function localInstant(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0');
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
}

/**
 * 本机 IANA 时区名。取不到时**说出一个具体值**而不是空字符串：草稿卡上要显示
 * 时区，写不出 `Asia/Shanghai` 就退到它 —— 写「用户自己看着办」等于把
 * 「我算不出来」伪装成「没有问题」。
 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 两位补零。中文界面里 `8:05` 比 `08:05` 好认，但协议一律要补零。 */
export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
