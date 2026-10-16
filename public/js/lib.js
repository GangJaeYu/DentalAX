/*
 * 이 파일이 하는 일: 모든 화면 파일이 공통으로 불러 쓰는 기본 도구 모음입니다.
 *   - html, render, useState … : 화면을 그리는 Preact + htm (React와 같은 방식)
 *   - fmt…                     : 날짜·금액·숫자를 한국식으로 보기 좋게 바꾸는 함수
 *
 * 화면 파일 맨 위에서 이렇게 불러옵니다:
 *   import { html, useState, useEffect, fmtDate, fmtMoney } from '../lib.js';
 */
export {
  html,
  render,
  h,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useReducer,
  useContext,
  useLayoutEffect,
  useErrorBoundary,
  createContext,
} from '../vendor/preact-htm.js';

/** 여러 클래스 이름을 조건에 따라 합치기: cx('btn', primary && 'btn-primary') */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const pad = (n) => String(n).padStart(2, '0');

/** 오늘 날짜 'YYYY-MM-DD' (이 기기 시간 기준) */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** '2026-10-16' → '10월 16일 (금)' / long=true 이면 '2026년 10월 16일 (금)' */
export function fmtDate(s, { long = false, weekday = true } = {}) {
  if (!s) return '';
  const d = parseDate(s);
  if (isNaN(d)) return s;
  const base = `${long ? d.getFullYear() + '년 ' : ''}${d.getMonth() + 1}월 ${d.getDate()}일`;
  return weekday ? `${base} (${WEEK[d.getDay()]})` : base;
}

/** '2026-10-16' → '2026.10.16' */
export function fmtDot(s) {
  if (!s) return '';
  return String(s).slice(0, 10).replace(/-/g, '.');
}

/** ISO 시각 → '10.16 14:05' (올해가 아니면 연도 포함) */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '.'}${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** '방금 전', '3분 전', '어제' 처럼 상대 시간 */
export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 2) return '어제';
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return fmtDateTime(iso);
}

/** 1234567 → '1,234,567' */
export function fmtNumber(n, digits = 0) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** 1234567 → '1,234,567원' */
export function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return `${fmtNumber(Math.round(Number(n)))}원`;
}

/** 큰 금액을 짧게: 12,340,000 → '1,234만원' */
export function fmtMoneyShort(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 100000000) return `${fmtNumber(v / 100000000, 1)}억원`;
  if (Math.abs(v) >= 10000) return `${fmtNumber(Math.round(v / 10000))}만원`;
  return fmtMoney(v);
}

/** 오늘부터 s까지 남은 날 (음수면 지남) */
export function daysUntil(s) {
  if (!s) return null;
  return Math.round((parseDate(s) - parseDate(todayStr())) / 86400000);
}

/** D-day 글자: 'D-3', 'D-day', 'D+2'(지남) */
export function fmtDday(s) {
  const n = daysUntil(s);
  if (n === null) return '';
  if (n === 0) return 'D-day';
  return n > 0 ? `D-${n}` : `D+${-n}`;
}

/** 파일 크기: 2048 → '2 KB' */
export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 이름 첫 글자 (아바타용) */
export function initials(name) {
  return String(name || '?').trim().slice(-2);
}

/** 주소 뒤의 ?a=1&b=2 를 객체로 */
export function parseQuery(qs) {
  const out = {};
  new URLSearchParams(qs || '').forEach((v, k) => (out[k] = v));
  return out;
}

/** 객체를 ?a=1&b=2 로 (빈 값은 뺌) */
export function toQuery(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** 글자 수 대신 문자 메시지 바이트(EUC-KR 기준: 한글 2바이트, 영문·숫자 1바이트) */
export function smsBytes(s) {
  let n = 0;
  for (const ch of String(s || '')) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

/** 입력 후 잠깐 기다렸다가 실행 (검색창 등) */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
