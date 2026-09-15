"use strict";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function chinaParts(input) {
  const shifted = new Date(new Date(input).getTime() + CHINA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function chinaDate(input) {
  const parts = chinaParts(input);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function chinaStartOfDay(input) {
  const parts = chinaParts(input);
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day) - CHINA_OFFSET_MS,
  );
}

function chinaDateTime(date, time = "00:00") {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - CHINA_OFFSET_MS,
  );
}

function addDays(input, days) {
  return new Date(new Date(input).getTime() + days * DAY_MS);
}

function addCalendarDays(date, days) {
  return chinaDate(addDays(chinaDateTime(date), days));
}

function daysBetween(start, end) {
  return Math.floor(
    (chinaStartOfDay(end).getTime() - chinaStartOfDay(start).getTime()) /
      DAY_MS,
  );
}

function endOfMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${pad(lastDay)}`;
}

function compareDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function minDate(...values) {
  const present = values.filter(Boolean);
  return present.length ? present.sort()[0] : null;
}

module.exports = {
  DAY_MS,
  addCalendarDays,
  addDays,
  chinaDate,
  chinaDateTime,
  chinaParts,
  chinaStartOfDay,
  compareDate,
  daysBetween,
  endOfMonth,
  minDate,
};
