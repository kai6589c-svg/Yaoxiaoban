import { RUNTIME_CONFIG } from "../config/runtime";

const OFFSET_MS = RUNTIME_CONFIG.timezoneOffsetMinutes * 60_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parts = (date: string): [number, number, number] => {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const isValidDateKey = (date: string): boolean => {
  const match = DATE_PATTERN.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
};

export const isValidMonthKey = (monthKey: string): boolean => {
  const match = MONTH_PATTERN.exec(monthKey);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
};

export const isValidTimeKey = (time: string): boolean =>
  TIME_PATTERN.test(time);

export const localDateTimeToMs = (date: string, time = "00:00"): number => {
  const [year, month, day] = parts(date);
  const timeMatch = TIME_PATTERN.exec(time);
  if (!timeMatch) throw new Error(`Invalid local time: ${time}`);
  return (
    Date.UTC(year, month - 1, day, Number(timeMatch[1]), Number(timeMatch[2])) -
    OFFSET_MS
  );
};

export const localDateTimeToIso = (date: string, time = "00:00"): string =>
  new Date(localDateTimeToMs(date, time)).toISOString();

export const dateKeyFromMs = (timestampMs: number): string =>
  new Date(timestampMs + OFFSET_MS).toISOString().slice(0, 10);

export const timeKeyFromMs = (timestampMs: number): string =>
  new Date(timestampMs + OFFSET_MS).toISOString().slice(11, 16);

export const todayKey = (nowMs = Date.now()): string => dateKeyFromMs(nowMs);

export const addDays = (date: string, amount: number): string => {
  const [year, month, day] = parts(date);
  return new Date(Date.UTC(year, month - 1, day + amount))
    .toISOString()
    .slice(0, 10);
};

export const daysBetween = (fromDate: string, toDate: string): number => {
  const [fy, fm, fd] = parts(fromDate);
  const [ty, tm, td] = parts(toDate);
  return Math.floor(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
};

export const endOfMonth = (monthKey: string): string => {
  if (!isValidMonthKey(monthKey)) throw new Error(`Invalid month: ${monthKey}`);
  const [yearText, monthText] = monthKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(day).padStart(2, "0")}`;
};

export const dayOfWeek = (date: string): number => {
  const [year, month, day] = parts(date);
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
};

export const startOfLocalDayMs = (timestampMs: number): number =>
  localDateTimeToMs(dateKeyFromMs(timestampMs), "00:00");

export const endOfLocalDayMs = (timestampMs: number): number =>
  localDateTimeToMs(addDays(dateKeyFromMs(timestampMs), 1), "00:00") - 1;

export const formatChineseDate = (
  date: string,
  precision: "day" | "month" = "day",
): string => {
  if (precision === "month") {
    const [year, month] = date.split("-");
    return `${year}年${Number(month)}月`;
  }
  const [year, month, day] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
};

export const formatShortChineseDate = (date: string): string => {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
};

export const formatLocalDateTime = (timestamp: string | number): string => {
  const timestampMs =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const [year, month, day] = dateKeyFromMs(timestampMs).split("-");
  return `${year}/${Number(month)}/${Number(day)} ${timeKeyFromMs(timestampMs)}`;
};

export const formatDose = (quantityMilli: number, unit: string): string => {
  const amount = quantityMilli / 1000;
  return `${Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}${unit}`;
};
