/**
 * 会话列表的时间展示（微信风格）
 *
 * 规则：
 *  - 今天 → HH:mm
 *  - 昨天 → 昨天
 *  - 本周内 → 周X
 *  - 今年 → M月D日
 *  - 更早 → YYYY/M/D
 *
 * 单独成模块是为了能直接测试边界（跨天、跨年、跨周）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 取"日历上的第几天"，而不是简单的毫秒差，避免 23:59 vs 00:01 被算成同一天 */
function dayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatConversationTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';

  const then = new Date(timestamp);
  const today = dayIndex(now);
  const thatDay = dayIndex(timestamp);
  const diff = today - thatDay;

  if (diff === 0) {
    return `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  }
  if (diff === 1) return '昨天';
  // 本周内：需要判断是否在同一个自然周（周一为一周起点）
  if (diff >= 2 && diff < 7) {
    const nowDate = new Date(now);
    const weekStart = dayIndex(now) - ((nowDate.getDay() + 6) % 7);
    if (thatDay >= weekStart) return WEEKDAY_CN[then.getDay()];
  }
  if (then.getFullYear() === new Date(now).getFullYear()) {
    return `${then.getMonth() + 1}月${then.getDate()}日`;
  }
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()}`;
}

/** 会话列表预览：压缩换行，避免一条长消息把列表项撑高 */
export function formatPreview(text: string, maxLen = 40): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}
