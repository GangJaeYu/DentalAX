/*
 * 이 파일이 하는 일: [F. 운영 지표] 지출·월별 요약 화면입니다. (실장 이상만)
 *
 *   #/expenses                  월별 요약 (이번 달 합계, 전월 대비, 분류별 비중, 12개월 추이, 많이 쓴 곳)
 *   #/expenses?tab=list         지출 내역 (달·분류·결제 수단·검색, 합계, 추가·수정·삭제, CSV 내보내기)
 *   #/expenses?tab=categories   분류 관리 (색, 자동 분류 키워드, 보관)
 *   [CSV 가져오기]              카드 내역 파일/붙여넣기 → 미리보기(분류 자동 추천·중복 표시·직접 고치기) → 저장
 *
 *   - 환자 진료비 같은 매출은 다루지 않습니다. 병원이 쓴 돈(지출)만 기록합니다.
 *   - 차트는 그림 대신 SVG로 직접 그려 밝은·어두운 화면 모두에서 app.css 색을 따릅니다.
 */
import { html, useState, useEffect, useRef, fmtDate, fmtDot, fmtMoney, fmtMoneyShort, fmtNumber, toQuery, todayStr, cx } from '../lib.js';
import { api, readFileAsText } from '../api.js';
import { setQuery } from '../router.js';
import { can, toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Seg, Modal, Field, Input, Textarea, Select, Checkbox, SearchInput, FormGrid,
  useApi, useForm, Loading, ErrorState, EmptyState, DataTable, Pagination, Menu, Stat, Callout, PiiBanner, useAI, AiButton,
} from '../ui/index.js';
import { MonthNav, fmtYm, useVendors } from './equipment.js';

const METHODS = ['카드', '계좌이체', '현금', '자동이체', '기타'];
const PRESET_COLORS = ['#3b82f6', '#8b5cf6', '#0ea5e9', '#f59e0b', '#14b8a6', '#64748b', '#ec4899', '#84cc16', '#ef4444', '#f97316', '#94a3b8', '#22c55e', '#a855f7', '#06b6d4'];
const SAMPLE_CSV = ['이용일자,가맹점명,이용금액', '2026.10.02,한빛덴탈,"352,000"', '2026.10.03,하늘기공소,"1,280,000"', '2026.10.05,모퉁이카페,"38,500"', '2026.10.07,다이소,"12,000"', '2026.10.08,검색광고 충전,"300,000"'].join('\n');

const thisYm = () => todayStr().slice(0, 7);

function CategoryPill({ name, color }) {
  return html`<span class="fx-cat-pill"><span class="fx-swatch" style=${{ background: color || 'var(--text-3)' }}></span>${name || '분류 없음'}</span>`;
}

function Amount({ value }) {
  return html`<span class=${cx('fx-amount', value < 0 && 'neg')}>${value < 0 ? '−' : ''}${fmtNumber(Math.abs(value))}원</span>`;
}

/** 증감 표시: 지출이 늘면 빨강(▲), 줄면 초록(▼) */
function Change({ diff, pct }) {
  if (!diff) return html`<span class="muted">변화 없음</span>`;
  const up = diff > 0;
  return html`<span class=${up ? 'fx-change-up' : 'fx-change-down'}>
    <${Icon} name=${up ? 'trending-up' : 'trending-down'} size=${13} /> ${up ? '+' : '−'}${fmtMoneyShort(Math.abs(diff))}${pct != null ? ` (${Math.abs(pct)}%)` : ''}
  </span>`;
}

/** 금액 입력 글자 → 정수 ('125,000' → 125000, 환불은 '-5000') */
function parseAmount(s) {
  const t = String(s ?? '').replace(/[,원\s]/g, '');
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

// ---------------- 지출 추가·수정 창 ----------------
function ExpenseEditor({ item, cats, vendors, defaultDate, onClose, onSaved }) {
  const activeCats = cats.filter((c) => c.active || (item && c.id === item.categoryId));
  const blank = (keep = {}) => ({
    date: keep.date || defaultDate || todayStr(),
    amount: '',
    categoryId: keep.categoryId || (activeCats[0] && activeCats[0].id) || '',
    payee: '',
    vendorId: '',
    description: '',
    paymentMethod: keep.paymentMethod || '카드',
    memo: '',
  });
  const f = useForm(
    item
      ? {
          date: item.date, amount: fmtNumber(item.amount), categoryId: item.categoryId, payee: item.payee, vendorId: item.vendorId ? String(item.vendorId) : '',
          description: item.description || '', paymentMethod: item.paymentMethod, memo: item.memo || '',
        }
      : blank()
  );
  const v = f.values;
  const amount = parseAmount(v.amount);

  const submitWith = (again) =>
    f.submit(async (val) => {
      const amt = parseAmount(val.amount);
      if (amt === null || amt === 0) {
        f.setErrors({ amount: '금액을 숫자로 입력해 주세요. (환불·취소는 앞에 - 를 붙임)' });
        return;
      }
      const body = {
        date: val.date,
        amount: amt,
        categoryId: Number(val.categoryId),
        payee: val.payee,
        vendorId: val.vendorId ? Number(val.vendorId) : null,
        description: val.description || null,
        paymentMethod: val.paymentMethod,
        memo: val.memo || null,
      };
      const saved = item ? await api.patch(`/expenses/items/${item.id}`, body) : await api.post('/expenses/items', body);
      toast.success(item ? '수정했습니다.' : `${saved.payee} ${fmtMoney(saved.amount)}을 기록했습니다.`);
      if (again) {
        f.setValues(blank(val));
        onSaved(saved, true);
      } else onSaved(saved, false);
    });
  const save = submitWith(false);

  const remove = async () => {
    if (!(await confirmDialog({ title: '이 지출을 삭제할까요?', message: `${fmtDate(item.date)} ${item.payee} ${fmtMoney(item.amount)}\n삭제하면 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/expenses/items/${item.id}`);
      toast.success('삭제했습니다.');
      onSaved(null, false);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return html`<${Modal}
    open=${true}
    size="lg"
    title=${item ? '지출 수정' : '지출 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`
      ${item ? html`<${Button} variant="danger" icon="trash-2" onClick=${remove}>삭제</${Button}><span class="grow"></span>` : null}
      <${Button} onClick=${onClose}>취소</${Button}>
      ${!item ? html`<${Button} onClick=${submitWith(true)} disabled=${f.busy}>저장하고 하나 더</${Button}>` : null}
      <${Button} variant="primary" loading=${f.busy} onClick=${save}>저장</${Button}>
    `}
  >
    <form class="stack" onSubmit=${save}>
      <${FormGrid}>
        <${Field} label="날짜" required error=${f.errors.date}><${Input} type="date" ...${f.bind('date')} /></${Field}>
        <${Field} label="금액(원)" required error=${f.errors.amount} hint=${amount ? `${amount < 0 ? '환불·취소 ' : ''}${fmtMoney(Math.abs(amount))}` : '환불·취소는 앞에 - 를 붙여 주세요.'}>
          <${Input} inputmode="numeric" ...${f.bind('amount')} placeholder="예: 125000" style=${{ fontWeight: 650 }} />
        </${Field}>
      </${FormGrid}>
      <${Field} label="분류" required error=${f.errors.categoryId}>
        <div class="fx-cat-grid" role="radiogroup" aria-label="분류">
          ${activeCats.map(
            (c) => html`<button type="button" role="radio" class="fx-cat-btn" aria-checked=${Number(v.categoryId) === c.id ? 'true' : 'false'} onClick=${() => f.set('categoryId', c.id)}>
              <span class="fx-swatch" style=${{ background: c.color }}></span>${c.name}
            </button>`
          )}
        </div>
      </${Field}>
      <${FormGrid}>
        <${Field} label="지급처 (가맹점·업체)" required error=${f.errors.payee}>
          <${Input} ...${f.bind('payee')} placeholder="예: 한빛덴탈" maxlength="100" />
        </${Field}>
        ${vendors.length
          ? html`<${Field} label="거래처 연결 (선택)">
              <${Select}
                value=${v.vendorId}
                onChange=${(e) => {
                  const id = e.target.value;
                  f.set('vendorId', id);
                  const vd = vendors.find((x) => String(x.id) === id);
                  if (vd && !v.payee) f.set('payee', vd.name);
                }}
                placeholder="연결 안 함"
                options=${vendors.map((x) => ({ value: String(x.id), label: x.name }))}
              />
            </${Field}>`
          : html`<${Field} label="내용"><${Input} ...${f.bind('description')} placeholder="예: 인상재·레진" maxlength="200" /></${Field}>`}
        ${vendors.length ? html`<${Field} label="내용" full><${Input} ...${f.bind('description')} placeholder="예: 인상재·레진" maxlength="200" /></${Field}>` : null}
      </${FormGrid}>
      <${Field} label="결제 수단">
        <${Seg} label="결제 수단" value=${v.paymentMethod} onChange=${(m) => f.set('paymentMethod', m)} items=${METHODS.map((m) => ({ value: m, label: m }))} />
      </${Field}>
      <${Field} label="메모" hint="환자 이름·진료 내용은 적지 마세요."><${Input} ...${f.bind('memo')} maxlength="1000" /></${Field}>
    </form>
  </${Modal}>`;
}

// ---------------- CSV·카드 내역 가져오기 ----------------
function ImportModal({ cats, onClose, onDone }) {
  const [step, setStep] = useState('input');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [method, setMethod] = useState('');
  const [aiNote, setAiNote] = useState(null);
  const fileRef = useRef();
  const ai = useAI('expenses.categorize');
  const activeCats = cats.filter((c) => c.active);

  const loadFile = async (file) => {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast.error('파일이 너무 큽니다. 3MB 이하의 CSV 파일을 골라 주세요.');
    try {
      const t = await readFileAsText(file);
      setText(t);
      setFileName(file.name);
    } catch (e) {
      toast.error(e.message || '파일을 읽지 못했습니다.');
    }
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const r = await api.post('/expenses/import/preview', { text });
      setPreview(r);
      setRows(r.rows.map((x, i) => ({ ...x, key: i })));
      setAiNote(null);
      ai.reset();
      setStep('preview');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const update = (key, patch) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const okRows = rows.filter((r) => !r.error);
  const chosen = rows.filter((r) => r.include && !r.error);
  const sum = chosen.reduce((s, r) => s + r.amount, 0);
  const allOn = okRows.length > 0 && okRows.every((r) => r.include);

  // AI 분류 추천: 오류 없는 줄의 가맹점·적요만 보냄 (금액·날짜는 보내지 않음)
  const runAi = async () => {
    const targets = okRows.slice(0, 100);
    if (!targets.length) return;
    setAiNote(null);
    const r = await ai.run({ items: targets.map((t) => `${t.payee}${t.description ? ` ${t.description}` : ''}`.slice(0, 200)) });
    if (!r) return;
    const list = Array.isArray(r.data) ? r.data : [];
    let changed = 0;
    setRows((all) => {
      const next = [...all];
      for (const s of list) {
        const target = targets[s.index];
        const cat = activeCats.find((c) => c.name === s.category);
        if (!target || !cat) continue;
        const i = next.findIndex((x) => x.key === target.key);
        if (next[i].categoryId !== cat.id) changed++;
        next[i] = { ...next[i], categoryId: cat.id, suggestedBy: 'ai' };
      }
      return next;
    });
    setAiNote({ count: list.length, changed, demo: r.demo, pii: r.pii && r.pii.message, notice: r.notice, more: okRows.length > 100 });
  };

  const commit = async () => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const body = chosen.map((r) => ({
        date: r.date,
        categoryId: r.categoryId,
        payee: r.payee,
        description: r.description || null,
        amount: r.amount,
        paymentMethod: method || r.paymentMethod,
      }));
      const res = await api.post('/expenses/import/commit', { rows: body });
      toast.success(`${res.inserted}건(합계 ${fmtMoney(res.sum)})을 저장했습니다.`);
      const months = [...new Set(chosen.map((r) => r.date.slice(0, 7)))].sort();
      onDone(months[months.length - 1]);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const suggestBadge = (r) =>
    r.suggestedBy === 'ai'
      ? html`<${Badge} color="purple" title="AI 추천">AI</${Badge}>`
      : r.suggestedBy === 'rule'
        ? html`<${Badge} color="blue" title=${`키워드 "${r.keyword}" 로 추천`}>규칙</${Badge}>`
        : r.suggestedBy === 'file'
          ? html`<${Badge} title="파일에 적힌 분류">파일</${Badge}>`
          : null;

  const footer =
    step === 'input'
      ? html`<${Button} onClick=${onClose}>취소</${Button}>
          <${Button} variant="primary" iconRight="arrow-right" loading=${busy} disabled=${text.trim().length < 5} onClick=${runPreview}>미리보기</${Button}>`
      : html`<${Button} icon="arrow-left" onClick=${() => setStep('input')}>다시 입력</${Button}>
          <span class="grow"></span>
          <span class="small text-2 num">${chosen.length}건 · 합계 ${fmtMoney(sum)}</span>
          <${Button} variant="primary" icon="save" loading=${busy} disabled=${!chosen.length} onClick=${commit}>${chosen.length}건 저장</${Button}>`;

  return html`<${Modal} open=${true} size="xl" title="CSV·카드 내역 가져오기" onClose=${onClose} busy=${busy} footer=${footer}>
    ${step === 'input'
      ? html`<div class="stack">
          <${Callout} kind="info" title="이렇게 준비해 주세요.">
            카드사·은행 홈페이지에서 이용 내역을 <strong>엑셀/CSV로 내려받아</strong> 올리거나, 엑셀에서 표를 복사해 아래에 붙여넣으세요.
            첫 줄(머리글)에 <strong>날짜(이용일자)</strong>, <strong>가맹점(또는 적요)</strong>, <strong>금액(이용금액)</strong> 칸이 있으면 됩니다. 카드번호 칸은 지우고 올려 주세요.
          </${Callout}>
          <div
            class=${cx('fx-dropzone', over && 'is-over')}
            onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave=${() => setOver(false)}
            onDrop=${(e) => { e.preventDefault(); setOver(false); loadFile(e.dataTransfer.files[0]); }}
          >
            <div class="icon-box blue"><${Icon} name="file-spreadsheet" size=${18} /></div>
            <div class="grow">
              <div class="strong">${fileName || 'CSV 파일을 여기로 끌어 놓거나 골라 주세요'}</div>
              <div class="small muted">${fileName ? `${fmtNumber(text.split(/\r?\n/).filter((l) => l.trim()).length)}줄을 읽었습니다.` : '한글 엑셀 CSV(EUC-KR)도 자동으로 읽습니다.'}</div>
            </div>
            <input ref=${fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" tabindex="-1" onChange=${(e) => loadFile(e.target.files[0])} />
            <${Button} icon="upload" onClick=${() => fileRef.current && fileRef.current.click()}>파일 고르기</${Button}>
          </div>
          <${Field} label="또는 붙여넣기" hint="엑셀에서 복사한 표(탭으로 나뉨)도 그대로 붙여넣으면 됩니다.">
            <${Textarea} rows=${8} value=${text} onInput=${(e) => { setText(e.target.value); setFileName(''); }} placeholder=${SAMPLE_CSV} style=${{ fontFamily: 'var(--mono)', fontSize: '12.5px' }} />
          </${Field}>
          <div class="row"><button type="button" class="fx-chip" onClick=${() => { setText(SAMPLE_CSV); setFileName(''); }}><${Icon} name="wand-sparkles" size=${12} />예시 넣어 보기</button></div>
        </div>`
      : html`<div class="stack">
          <div class="fx-counts">
            <${Badge}>전체 ${preview.counts.total}줄</${Badge}>
            <${Badge} color="blue">저장할 줄 ${chosen.length}</${Badge}>
            ${preview.counts.suggested ? html`<${Badge} color="green">자동 분류 ${preview.counts.suggested}</${Badge}>` : null}
            ${preview.counts.duplicates ? html`<${Badge} color="amber">중복 의심 ${preview.counts.duplicates}</${Badge}>` : null}
            ${preview.counts.errors ? html`<${Badge} color="red">읽지 못한 줄 ${preview.counts.errors}</${Badge}>` : null}
            ${preview.headerless ? html`<span class="small muted">머리글이 없어 "날짜, 가맹점, 금액" 순서로 읽었습니다.</span>` : null}
          </div>
          <div class="row wrap" style=${{ gap: '10px' }}>
            <${Checkbox} label="모두 선택" checked=${allOn} onChange=${(c) => setRows((list) => list.map((r) => (r.error ? r : { ...r, include: c })))} />
            <${Select} size="sm" aria-label="결제 수단 한꺼번에" value=${method} onChange=${(e) => setMethod(e.target.value)} placeholder="결제 수단: 파일대로(기본 카드)" options=${METHODS.map((m) => ({ value: m, label: `결제 수단: 모두 ${m}` }))} style=${{ width: '220px' }} />
            <span class="grow"></span>
          </div>
          <div class="stack sm">
            <${PiiBanner} compact />
            <div class="row wrap" style=${{ gap: '8px' }}>
              <${AiButton} size="sm" loading=${ai.busy} disabled=${!okRows.length} onClick=${runAi}>AI로 분류 추천</${AiButton}>
              <span class="small muted">가맹점·적요 글자만 AI에 보냅니다. 금액·날짜는 보내지 않습니다.</span>
            </div>
            ${ai.error ? html`<${Callout} kind=${ai.error.data && ai.error.data.pii ? 'warn' : 'danger'}>${ai.error.message}</${Callout}>` : null}
            ${aiNote
              ? html`<${Callout} kind="success" icon="sparkles">
                  AI가 ${aiNote.count}건을 추천해 ${aiNote.changed}건의 분류를 바꿨습니다. (보라색 "AI" 표시) 저장 전에 한 번 확인해 주세요.
                  ${aiNote.demo ? html` <${Badge} color="amber">데모 예시</${Badge}>` : null}
                  ${aiNote.more ? html`<div class="small">한 번에 100줄까지 추천합니다. 나머지는 규칙 추천을 확인해 주세요.</div>` : null}
                  ${aiNote.pii ? html`<div class="small">${aiNote.pii}</div>` : null}
                  ${aiNote.notice ? html`<div class="small">${aiNote.notice}</div>` : null}
                </${Callout}>`
              : null}
          </div>
          <div class="table-wrap" style=${{ maxHeight: '46vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <table class="table table-compact fx-import-table">
              <caption class="sr-only">가져올 지출 미리보기</caption>
              <thead>
                <tr><th class="center">저장</th><th>날짜</th><th>가맹점·적요</th><th class="right">금액</th><th>분류</th><th>상태</th></tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r) => html`<tr key=${r.key} class=${cx(r.error && 'is-error', !r.error && !r.include && 'is-off')}>
                    <td class="center"><input type="checkbox" aria-label=${`${r.line}번째 줄 저장`} checked=${!!r.include} disabled=${!!r.error} onChange=${(e) => update(r.key, { include: e.target.checked })} /></td>
                    <td class="num nowrap">${r.date ? fmtDot(r.date) : html`<span class="danger-text">${r.rawDate || '(빈칸)'}</span>`}</td>
                    <td>
                      <div class="ellipsis" style=${{ maxWidth: '260px' }}>${r.payee || html`<span class="muted">(빈칸)</span>`}</div>
                      ${r.description ? html`<div class="small muted ellipsis" style=${{ maxWidth: '260px' }}>${r.description}</div>` : null}
                    </td>
                    <td class="right">${r.amount !== null && r.amount !== undefined ? html`<${Amount} value=${r.amount} />` : html`<span class="danger-text">${r.rawAmount || '(빈칸)'}</span>`}</td>
                    <td>
                      <div class="row nowrap" style=${{ gap: '6px' }}>
                        <${Select} size="sm" aria-label=${`${r.line}번째 줄 분류`} value=${String(r.categoryId || '')} disabled=${!!r.error}
                          onChange=${(e) => update(r.key, { categoryId: Number(e.target.value), suggestedBy: null })}
                          options=${activeCats.map((c) => ({ value: String(c.id), label: c.name }))} />
                        ${suggestBadge(r)}
                      </div>
                    </td>
                    <td class="small">
                      ${r.error
                        ? html`<span class="danger-text">${r.line}번째 줄: ${r.error}</span>`
                        : r.duplicate
                          ? html`<${Badge} color="amber" title="같은 날짜·금액·지급처가 이미 저장되어 있습니다">중복 의심</${Badge}>`
                          : r.amount < 0
                            ? html`<${Badge} color="green">환불·취소</${Badge}>`
                            : html`<span class="muted">새 지출</span>`}
                    </td>
                  </tr>`
                )}
              </tbody>
            </table>
          </div>
        </div>`}
  </${Modal}>`;
}

// ---------------- 12개월 추이 차트 (SVG) ----------------
function TrendChart({ trend, month, average, onPick }) {
  const W = 640;
  const H = 270;
  const padL = 54;
  const padR = 8;
  const padT = 18;
  const padB = 28;
  const max = Math.max(...trend.map((t) => t.total), average, 1);
  // 눈금을 보기 좋은 단위(백만원 단위 등)로 맞춤
  const rough = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) || rough;
  const top = step * 4;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const band = (W - padL - padR) / trend.length;
  const bw = Math.min(30, band * 0.58);
  const label = (v) => (v >= 10000 ? `${fmtNumber(Math.round(v / 10000))}만` : fmtNumber(v));
  const desc = `최근 12개월 지출 추이. ${trend.map((t) => `${Number(t.month.slice(5))}월 ${fmtMoneyShort(t.total)}`).join(', ')}.`;
  return html`<div>
    <svg class="fx-chart" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${desc}>
      ${[0, 1, 2, 3, 4].map(
        (i) => html`<g key=${i}>
          <line class="fx-grid-line" x1=${padL} x2=${W - padR} y1=${y(step * i)} y2=${y(step * i)} />
          <text class="fx-axis" x=${padL - 6} y=${y(step * i) + 4} text-anchor="end">${label(step * i)}</text>
        </g>`
      )}
      ${trend.map((t, i) => {
        const x = padL + band * i + (band - bw) / 2;
        const h = Math.max(t.total > 0 ? 2 : 0, y(0) - y(Math.max(0, t.total)));
        const cur = t.month === month;
        const m = Number(t.month.slice(5));
        return html`<g key=${t.month}>
          <rect
            class=${cx('fx-col', cur && 'is-current', t.partial && 'is-partial')}
            x=${x} y=${y(0) - h} width=${bw} height=${h} rx="3"
            tabindex="0"
            role="button"
            aria-label=${`${fmtYm(t.month)} ${fmtMoney(t.total)}${t.partial ? ' (진행 중)' : ''} — 이 달 보기`}
            onClick=${() => onPick(t.month)}
            onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(t.month))}
          ><title>${fmtYm(t.month)}: ${fmtMoney(t.total)}${t.partial ? ' (이번 달, 진행 중)' : ''}</title></rect>
          ${cur && t.total > 0 ? html`<text class="fx-val" x=${x + bw / 2} y=${y(0) - h - 5} text-anchor="middle">${label(t.total)}</text>` : null}
          <text class=${cx('fx-axis', cur && 'is-current')} x=${x + bw / 2} y=${H - 8} text-anchor="middle">${m === 1 ? `${t.month.slice(2, 4)}.1월` : `${m}월`}</text>
        </g>`;
      })}
      ${average > 0
        ? html`<g>
            <line class="fx-avg" x1=${padL} x2=${W - padR} y1=${y(average)} y2=${y(average)} />
            <text class="fx-avg-label" x=${W - padR} y=${y(average) - 4} text-anchor="end">평균 ${label(average)}</text>
          </g>`
        : null}
    </svg>
    <div class="fx-legend">
      <span><i></i>고른 달</span><span><i class="soft"></i>다른 달 (누르면 이동)</span><span><i class="line"></i>12개월 평균 (진행 중인 달 제외)</span>
    </div>
  </div>`;
}

// ---------------- 월별 요약 탭 ----------------
function SummaryTab({ month, onMonth, onAdd, onImport }) {
  const { data: s, loading, error, reload } = useApi(`/expenses/summary?month=${month}`);
  if (error && !s) return html`<${Card}><${ErrorState} error=${error} onRetry=${reload} /></${Card}>`;
  if (!s) return html`<${Card}><${Loading} rows=${8} /></${Card}>`;
  const top = s.byCategory.filter((c) => c.total > 0);
  const maxCat = top.length ? Math.max(...top.map((c) => c.total)) : 1;
  const totalPos = top.reduce((a, c) => a + c.total, 0) || 1;

  return html`<div class="stack lg" aria-busy=${loading ? 'true' : 'false'}>
    <div class="grid fx-stat-grid">
      <${Stat} label=${`${fmtYm(s.month)} 지출`} icon="wallet" value=${fmtNumber(s.total)} unit="원" hint=${`${s.count}건${s.isCurrent ? ' · 진행 중' : ''}`} />
      <${Stat} label="전월 대비" icon=${s.change > 0 ? 'trending-up' : 'trending-down'} value=${s.compareBase ? `${s.change > 0 ? '+' : s.change < 0 ? '−' : ''}${fmtMoneyShort(Math.abs(s.change))}` : '—'}
        hint=${s.compareBase ? `${s.compareLabel}보다 ${s.changePct !== null ? `${Math.abs(s.changePct)}% ` : ''}${s.change > 0 ? '많음' : s.change < 0 ? '적음' : '같음'}` : '지난달 기록 없음'} />
      <${Stat} label="12개월 평균" icon="chart-column" value=${s.average12 ? fmtMoneyShort(s.average12) : '—'} hint=${s.average12 ? `평균보다 ${fmtMoneyShort(Math.abs(s.total - s.average12))} ${s.total > s.average12 ? '많음' : '적음'}` : '비교할 기록 부족'} />
      <${Stat} label="가장 큰 분류" icon="tag" value=${top.length ? top[0].name : '—'} hint=${top.length ? `${top[0].share}% · ${fmtMoneyShort(top[0].total)}` : '기록 없음'} />
    </div>

    <div class="grid grid-2">
      <${Card} title="분류별 지출" icon="tag" sub=${fmtYm(s.month)}>
        ${top.length
          ? html`<div class="stack">
              <div class="fx-share-bar" role="img" aria-label=${`분류별 비중: ${top.map((c) => `${c.name} ${c.share}%`).join(', ')}`}>
                ${top.map((c) => html`<span key=${c.id} style=${{ width: `${(c.total / totalPos) * 100}%`, background: c.color }} title=${`${c.name} ${c.share}%`}></span>`)}
              </div>
              <ul class="fx-bars">
                ${top.map(
                  (c) => html`<li key=${c.id}>
                    <span class="fx-bar-name"><span class="fx-swatch" style=${{ background: c.color }}></span>${c.name}</span>
                    <span class="fx-bar-track" aria-hidden="true"><span class="fx-bar-fill" style=${{ width: `${(c.total / maxCat) * 100}%`, background: c.color }}></span></span>
                    <span class="fx-bar-val"><span class="strong">${fmtMoneyShort(c.total)}</span><small>${c.share}%</small></span>
                  </li>`
                )}
              </ul>
            </div>`
          : html`<${EmptyState} compact icon="wallet" title=${`${fmtYm(s.month)} 지출 기록이 없습니다`} desc="지출을 직접 넣거나 카드 내역 CSV를 가져와 보세요."
              action=${html`<div class="row wrap" style=${{ justifyContent: 'center' }}><${Button} variant="primary" icon="plus" onClick=${onAdd}>지출 추가</${Button}><${Button} icon="file-up" onClick=${onImport}>CSV 가져오기</${Button}></div>`} />`}
      </${Card}>
      <${Card} title="12개월 추이" icon="chart-column" sub="막대를 누르면 그 달로 이동">
        <${TrendChart} trend=${s.trend} month=${s.month} average=${s.average12} onPick=${onMonth} />
      </${Card}>
    </div>

    <div class="grid grid-2">
      <${Card} title="분류별 비교" sub=${`${fmtYm(s.prevMonth)}과 비교`} flush>
        <div class="table-wrap">
          <table class="table table-compact">
            <caption class="sr-only">분류별 이번 달·지난달 지출 비교</caption>
            <thead><tr><th>분류</th><th class="right">${Number(s.month.slice(5))}월</th><th class="right">비중</th><th class="right">${Number(s.prevMonth.slice(5))}월</th><th class="right">증감</th></tr></thead>
            <tbody>
              ${s.byCategory
                .filter((c) => c.total || c.prevTotal)
                .map(
                  (c) => html`<tr key=${c.id}>
                    <td><${CategoryPill} name=${c.name} color=${c.color} /></td>
                    <td class="right num">${fmtNumber(c.total)}</td>
                    <td class="right num muted">${c.share}%</td>
                    <td class="right num muted">${fmtNumber(c.prevTotal)}</td>
                    <td class="right small nowrap"><${Change} diff=${c.total - c.prevTotal} /></td>
                  </tr>`
                )}
              <tr>
                <td class="strong">합계</td>
                <td class="right num strong">${fmtNumber(s.total)}</td>
                <td class="right num muted">100%</td>
                <td class="right num muted">${fmtNumber(s.prevTotal)}</td>
                <td class="right small nowrap"><${Change} diff=${s.total - s.prevTotal} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        ${s.isCurrent ? html`<p class="small muted" style=${{ padding: '10px 16px' }}>이번 달은 아직 진행 중이라 지난달 "한 달 전체"보다 적게 보일 수 있습니다. 위 "전월 대비"는 같은 기간끼리 비교한 값입니다.</p>` : null}
      </${Card}>
      <div class="stack">
        <${Card} title="많이 쓴 곳" icon="building-2" sub="지급처별 합계">
          ${s.topPayees.length
            ? html`<ol class="fx-rank">
                ${s.topPayees.map(
                  (p, i) => html`<li key=${p.payee}>
                    <span class="fx-rank-no">${i + 1}</span>
                    <span class="grow ellipsis">${p.payee}</span>
                    <span class="small muted">${p.count}건</span>
                    <${Amount} value=${p.total} />
                  </li>`
                )}
              </ol>`
            : html`<p class="muted small">기록이 없습니다.</p>`}
        </${Card}>
        <${Card} title="큰 지출 5건" icon="receipt">
          ${s.largest.length
            ? html`<ol class="fx-rank">
                ${s.largest.map(
                  (x, i) => html`<li key=${x.id}>
                    <span class="fx-rank-no">${i + 1}</span>
                    <span class="grow" style=${{ minWidth: 0 }}>
                      <span class="ellipsis" style=${{ display: 'block' }}>${x.payee}</span>
                      <span class="small muted">${fmtDate(x.date)} · ${x.categoryName}</span>
                    </span>
                    <${Amount} value=${x.amount} />
                  </li>`
                )}
              </ol>`
            : html`<p class="muted small">기록이 없습니다.</p>`}
        </${Card}>
      </div>
    </div>
  </div>`;
}

// ---------------- 지출 내역 탭 ----------------
function ListTab({ route, month, cats, refresh, onEdit, onAdd, onImport }) {
  const q = route.query;
  const [search, setSearch] = useState(q.q || '');
  const allMonths = q.all === '1';
  const params = { month: allMonths ? '' : month, categoryId: q.cat || '', method: q.method || '', q: q.q || '', sort: q.sort || '' };
  const page = Number(q.page) || 1;
  const { data, loading, error, reload } = useApi(`/expenses/items${toQuery({ ...params, page, size: 50 })}`);

  useEffect(() => {
    if (refresh) reload();
  }, [refresh]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search, page: '' });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const exportCsv = async () => {
    try {
      await api.download(`/expenses/export.csv${toQuery(params)}`, `지출_${params.month || '전체'}.csv`);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const filtered = !!(q.cat || q.method || q.q);
  const columns = [
    { key: 'date', label: '날짜', render: (x) => html`<span class="num nowrap">${allMonths ? fmtDot(x.date) : fmtDate(x.date)}</span>` },
    { key: 'category', label: '분류', render: (x) => html`<${CategoryPill} name=${x.categoryName} color=${x.categoryColor} />` },
    {
      key: 'payee',
      label: '지급처',
      render: (x) => html`<div style=${{ minWidth: '140px' }}>
        <div class="row" style=${{ gap: '6px' }}><span class="strong">${x.payee}</span>${x.vendorName ? html`<${Badge} color="blue" title="거래처와 연결됨">거래처</${Badge}>` : null}</div>
        ${x.description ? html`<div class="small muted">${x.description}</div>` : null}
      </div>`,
    },
    { key: 'paymentMethod', label: '결제', render: (x) => html`<span class="small text-2 nowrap">${x.paymentMethod}</span>` },
    { key: 'memo', label: '메모', render: (x) => (x.memo ? html`<span class="small muted ellipsis" style=${{ display: 'inline-block', maxWidth: '180px' }} title=${x.memo}>${x.memo}</span>` : '') },
    { key: 'amount', label: '금액', align: 'right', render: (x) => html`<${Amount} value=${x.amount} />` },
  ];

  return html`
    <div class="row wrap fx-filters">
      <${Select} size="sm" aria-label="분류" value=${q.cat || ''} onChange=${(e) => setQuery({ cat: e.target.value, page: '' })} placeholder="모든 분류" options=${cats.map((c) => ({ value: String(c.id), label: c.name }))} style=${{ width: '150px' }} />
      <${Select} size="sm" aria-label="결제 수단" value=${q.method || ''} onChange=${(e) => setQuery({ method: e.target.value, page: '' })} placeholder="모든 결제 수단" options=${METHODS} style=${{ width: '150px' }} />
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="지급처·내용·메모 검색" style=${{ maxWidth: '240px' }} />
      <${Select} size="sm" aria-label="정렬" value=${q.sort || ''} onChange=${(e) => setQuery({ sort: e.target.value, page: '' })}
        options=${[{ value: '', label: '최근 날짜 순' }, { value: 'date_asc', label: '오래된 날짜 순' }, { value: 'amount', label: '큰 금액 순' }, { value: 'amount_asc', label: '작은 금액 순' }]} style=${{ width: '140px' }} />
      <${Checkbox} label="모든 달" checked=${allMonths} onChange=${(c) => setQuery({ all: c ? '1' : '', page: '' })} />
      <span class="grow"></span>
      <${Button} size="sm" icon="download" onClick=${exportCsv} disabled=${!data || !data.total}>CSV 내보내기</${Button}>
    </div>
    <${Card}
      flush
      title=${allMonths ? '전체 기간 지출' : `${fmtYm(month)} 지출`}
      sub=${data ? `${fmtNumber(data.total)}건` : ''}
      actions=${data ? html`<span class="small text-2">합계</span><span class="fx-big-amount" style=${{ fontSize: '17px' }}>${fmtMoney(data.sum)}</span>` : null}
    >
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        onRowClick=${onEdit}
        caption="지출 목록"
        empty=${{
          icon: 'wallet',
          title: filtered ? '조건에 맞는 지출이 없습니다' : `${allMonths ? '' : fmtYm(month) + ' '}지출 기록이 없습니다`,
          desc: filtered ? '필터나 검색어를 바꿔 보세요.' : '지출을 직접 넣거나 카드 내역 CSV를 가져와 보세요.',
          action: filtered
            ? html`<${Button} onClick=${() => { setSearch(''); setQuery({ cat: '', method: '', q: '', page: '' }); }}>필터 지우기</${Button}>`
            : html`<div class="row wrap" style=${{ justifyContent: 'center' }}><${Button} variant="primary" icon="plus" onClick=${onAdd}>지출 추가</${Button}><${Button} icon="file-up" onClick=${onImport}>CSV 가져오기</${Button}></div>`,
        }}
      />
      ${data ? html`<${Pagination} page=${data.page} size=${data.size} total=${data.total} onChange=${(p) => setQuery({ page: p })} />` : null}
    </${Card}>
  `;
}

// ---------------- 분류 관리 탭 ----------------
function CategoryEditor({ cat, onClose, onSaved }) {
  const f = useForm(cat ? { name: cat.name, color: cat.color, keywords: cat.keywords || '' } : { name: '', color: PRESET_COLORS[11], keywords: '' });
  const save = f.submit(async (v) => {
    const saved = cat ? await api.patch(`/expenses/categories/${cat.id}`, v) : await api.post('/expenses/categories', v);
    toast.success(cat ? '분류를 수정했습니다.' : '분류를 추가했습니다.');
    onSaved(saved);
  });
  return html`<${Modal}
    open=${true}
    title=${cat ? '분류 수정' : '분류 추가'}
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>${cat ? '저장' : '추가'}</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${Field} label="분류 이름" required error=${f.errors.name}><${Input} ...${f.bind('name')} maxlength="30" placeholder="예: 교육비" /></${Field}>
      <${Field} label="색" error=${f.errors.color}>
        <div class="fx-colors">
          ${PRESET_COLORS.map((c) => html`<button type="button" class="fx-color" style=${{ background: c }} aria-label=${`색 ${c}`} aria-pressed=${f.values.color === c ? 'true' : 'false'} onClick=${() => f.set('color', c)}></button>`)}
          <input type="color" class="fx-color-input" aria-label="직접 색 고르기" value=${f.values.color} onInput=${(e) => f.set('color', e.target.value)} />
        </div>
      </${Field}>
      <${Field} label="자동 분류 키워드" error=${f.errors.keywords} hint="쉼표로 나눠 적어 주세요. 카드 내역을 가져올 때 가맹점·적요에 이 글자가 있으면 이 분류로 추천합니다.">
        <${Textarea} rows=${3} ...${f.bind('keywords')} placeholder="예: 세미나, 학회, 교육" />
      </${Field}>
    </form>
  </${Modal}>`;
}

function CategoriesTab({ catsApi }) {
  const { data: cats, loading, error, reload } = catsApi;
  const [editing, setEditing] = useState(null);
  const toggle = async (c) => {
    try {
      await api.patch(`/expenses/categories/${c.id}`, { active: !c.active });
      toast.success(c.active ? '보관했습니다. 새 지출에서는 고를 수 없습니다.' : '다시 사용합니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async (c) => {
    if (!(await confirmDialog({ title: `"${c.name}" 분류를 삭제할까요?`, message: '쓰인 적 없는 분류만 삭제할 수 있습니다.', danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/expenses/categories/${c.id}`);
      toast.success('삭제했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return html`
    <${Callout} kind="info" class="fx-mb">
      분류의 <strong>키워드</strong>는 카드 내역을 가져올 때 자동 분류에 쓰입니다. 예: 재료비에 "덴탈"이 있으면 "한빛덴탈" 결제를 재료비로 추천합니다.
    </${Callout}>
    <${Card} flush title="지출 분류" sub=${cats ? `${cats.length}개` : ''} actions=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => setEditing({})}>분류 추가</${Button}>`}>
      ${error && !cats
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : !cats
          ? html`<${Loading} rows=${6} />`
          : !cats.length
            ? html`<${EmptyState} icon="tag" title="분류가 없습니다" action=${html`<${Button} variant="primary" icon="plus" onClick=${() => setEditing({})}>분류 추가</${Button}>`} />`
            : html`<div class="list">
                ${cats.map(
                  (c) => html`<div class=${cx('list-item', !c.active && 'fx-dim-item')} key=${c.id}>
                    <span class="fx-swatch lg" style=${{ background: c.color }} aria-hidden="true"></span>
                    <div class="grow">
                      <div class="row" style=${{ gap: '6px' }}><span class="list-title">${c.name}</span>${!c.active ? html`<${Badge}>보관됨</${Badge}>` : null}</div>
                      <div class="list-meta ellipsis">${c.keywords ? `키워드: ${c.keywords}` : '키워드 없음 — 자동 분류에 쓰이지 않음'}</div>
                    </div>
                    <span class="small muted nowrap">${fmtNumber(c.count)}건</span>
                    <${Button} size="sm" icon="pencil" onClick=${() => setEditing(c)}>수정</${Button}>
                    <${Menu} items=${[
                      { label: c.active ? '보관하기' : '다시 사용', icon: 'archive', onClick: () => toggle(c) },
                      !c.count && '-',
                      !c.count && { label: '삭제', icon: 'trash-2', danger: true, onClick: () => remove(c) },
                    ].filter(Boolean)} />
                  </div>`
                )}
              </div>`}
    </${Card}>
    ${editing ? html`<${CategoryEditor} cat=${editing.id ? editing : null} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); }} />` : null}
  `;
}

// ---------------- 화면 ----------------
export default function ExpensesPage({ route }) {
  const q = route.query;
  const tab = ['list', 'categories'].includes(q.tab) ? q.tab : 'summary';
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month || '') ? q.month : thisYm();
  const catsApi = useApi(can('manager') ? '/expenses/categories' : null);
  const [editor, setEditor] = useState(null); // { item } 또는 { item: null }
  const [importing, setImporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [vendorsOn, setVendorsOn] = useState(false);
  const vendors = useVendors(vendorsOn);

  // 거래처 기능(재고 모듈)이 있는지 한 번 확인한 뒤에만 거래처 목록을 부름
  useEffect(() => {
    if (!can('manager')) return;
    api
      .get('/expenses/items?size=10&month=1900-01')
      .then((d) => setVendorsOn(!!d.vendorsAvailable))
      .catch(() => {});
  }, []);

  if (!can('manager')) {
    return html`<${PageHeader} title="지출·월별 요약" /><${Card}><${EmptyState} icon="lock" title="실장 이상만 볼 수 있는 화면입니다" desc="병원 경영 정보라 원장님·실장님만 볼 수 있습니다." /></${Card}>`;
  }

  const cats = catsApi.data || [];
  const changed = () => {
    setRefresh((n) => n + 1);
    catsApi.reload();
  };
  const openAdd = () => setEditor({ item: null });
  const openImport = () => setImporting(true);

  return html`
    <${PageHeader}
      title="지출·월별 요약"
      desc="병원에서 쓴 돈(지출)만 기록합니다. 환자 진료비 같은 매출은 다루지 않습니다."
      actions=${html`
        <${Button} icon="file-up" onClick=${openImport} disabled=${!cats.length}>CSV 가져오기</${Button}>
        <${Button} variant="primary" icon="plus" onClick=${openAdd} disabled=${!cats.length}>지출 추가</${Button}>
      `}
    />
    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ tab: t === 'summary' ? '' : t, page: '' })}
      items=${[
        { value: 'summary', label: '월별 요약', icon: 'chart-column' },
        { value: 'list', label: '지출 내역', icon: 'list' },
        { value: 'categories', label: '분류 관리', icon: 'tag' },
      ]}
    />
    ${tab !== 'categories' && !(tab === 'list' && q.all === '1')
      ? html`<div class="fx-filters"><${MonthNav} value=${month} onChange=${(m) => setQuery({ month: m === thisYm() ? '' : m, page: '' })} /></div>`
      : null}
    ${catsApi.error && !catsApi.data
      ? html`<${Card}><${ErrorState} error=${catsApi.error} onRetry=${catsApi.reload} /></${Card}>`
      : tab === 'summary'
        ? html`<${SummaryTab} key=${`${month}-${refresh}`} month=${month} onMonth=${(m) => setQuery({ month: m === thisYm() ? '' : m })} onAdd=${openAdd} onImport=${openImport} />`
        : tab === 'list'
          ? html`<${ListTab} route=${route} month=${month} cats=${cats} refresh=${refresh} onEdit=${(item) => setEditor({ item })} onAdd=${openAdd} onImport=${openImport} />`
          : html`<${CategoriesTab} catsApi=${catsApi} />`}
    ${editor && cats.length
      ? html`<${ExpenseEditor}
          item=${editor.item}
          cats=${cats}
          vendors=${vendors}
          defaultDate=${month === thisYm() ? todayStr() : `${month}-01`}
          onClose=${() => setEditor(null)}
          onSaved=${(saved, again) => {
            if (!again) setEditor(null);
            changed();
          }}
        />`
      : null}
    ${importing
      ? html`<${ImportModal}
          cats=${cats}
          onClose=${() => setImporting(false)}
          onDone=${(lastMonth) => {
            setImporting(false);
            changed();
            if (lastMonth) setQuery({ month: lastMonth === thisYm() ? '' : lastMonth });
          }}
        />`
      : null}
  `;
}
