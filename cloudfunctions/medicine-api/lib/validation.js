"use strict";

const { fail } = require("./errors");

const ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function record(value, label = "payload") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} 必须是对象`);
  }
  return value;
}

function keys(value, allowed, label = "payload") {
  record(value, label);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    fail("INVALID_ARGUMENT", `${label} 包含不支持的字段`, { fields: extra });
}

function string(value, label, { min = 1, max = 200, trim = true } = {}) {
  if (typeof value !== "string")
    fail("INVALID_ARGUMENT", `${label} 必须是字符串`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max) {
    fail("INVALID_ARGUMENT", `${label} 长度必须在 ${min}-${max} 之间`);
  }
  return result;
}

function optionalString(value, label, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  return string(value, label, { min: 0, ...options });
}

function id(value, label = "id") {
  const result = string(value, label, { min: 3, max: 80 });
  if (!ID_RE.test(result)) fail("INVALID_ARGUMENT", `${label} 格式不正确`);
  return result;
}

function requestId(value) {
  const result = string(value, "requestId", { min: 8, max: 128 });
  if (!REQUEST_ID_RE.test(result))
    fail("INVALID_ARGUMENT", "requestId 格式不正确");
  return result;
}

function oneOf(value, label, values) {
  if (!values.includes(value))
    fail("INVALID_ARGUMENT", `${label} 不受支持`, { allowed: values });
  return value;
}

function finiteNumber(
  value,
  label,
  { min = -Infinity, max = Infinity, integer = false } = {},
) {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("INVALID_ARGUMENT", `${label} 必须是有限数字`);
  if (integer && !Number.isInteger(value))
    fail("INVALID_ARGUMENT", `${label} 必须是整数`);
  if (value < min || value > max)
    fail("INVALID_ARGUMENT", `${label} 必须在 ${min}-${max} 之间`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean")
    fail("INVALID_ARGUMENT", `${label} 必须是布尔值`);
  return value;
}

function date(value, label = "日期") {
  const result = string(value, label, { min: 10, max: 10 });
  if (
    !DATE_RE.test(result) ||
    Number.isNaN(Date.parse(`${result}T00:00:00Z`))
  ) {
    fail("INVALID_ARGUMENT", `${label} 格式必须为 YYYY-MM-DD`);
  }
  const [year, month, day] = result.split("-").map(Number);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${label} 不是有效日期`);
  }
  return result;
}

function month(value, label = "月份") {
  const result = string(value, label, { min: 7, max: 7 });
  if (!MONTH_RE.test(result))
    fail("INVALID_ARGUMENT", `${label} 格式必须为 YYYY-MM`);
  return result;
}

function time(value, label = "时间") {
  const result = string(value, label, { min: 5, max: 5 });
  if (!TIME_RE.test(result))
    fail("INVALID_ARGUMENT", `${label} 格式必须为 HH:mm`);
  return result;
}

function isoTimestamp(value, label = "时间戳") {
  const result = string(value, label, { min: 20, max: 35 });
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d\d:\d\d$/.test(result)) {
    fail("INVALID_ARGUMENT", `${label} 必须是带时区的 ISO 8601 时间`);
  }
  return new Date(parsed).toISOString();
}

function expectedVersion(value) {
  return finiteNumber(value, "expectedVersion", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
}

function color(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = string(value, "color", { min: 7, max: 7 });
  if (!HEX_COLOR_RE.test(result))
    fail("INVALID_ARGUMENT", "color 必须是六位十六进制颜色");
  return result.toUpperCase();
}

function uniqueArray(value, label, parser, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value)) fail("INVALID_ARGUMENT", `${label} 必须是数组`);
  if (value.length < min || value.length > max)
    fail("INVALID_ARGUMENT", `${label} 数量必须在 ${min}-${max} 之间`);
  const parsed = value.map((item, index) => parser(item, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length)
    fail("INVALID_ARGUMENT", `${label} 不能包含重复值`);
  return parsed;
}

module.exports = {
  boolean,
  color,
  date,
  expectedVersion,
  finiteNumber,
  id,
  isoTimestamp,
  keys,
  month,
  oneOf,
  optionalString,
  record,
  requestId,
  string,
  time,
  uniqueArray,
};
