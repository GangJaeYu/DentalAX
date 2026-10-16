/*
 * 이 파일이 하는 일: [E2. 멸균기 기록] 화면입니다. 멸균기를 돌릴 때마다 태블릿에서 빠르게 기록합니다.
 *
 *   #/sterilization              오늘 기록 (빠른 입력 + 그날 기록 목록)
 *   #/sterilization?tab=month    월별 기록 (표, 멸균기별 보기, A4 기록부 인쇄 — 서명 칸 포함)
 *
 *   - 환자 정보는 적지 않습니다. 적재물은 "기구 파우치 25개" 처럼 물건만 적습니다.
 *   - 빠른 입력 기본값: 오늘 날짜, 그 멸균기의 다음 회차, 지난번에 쓴 프로그램과 온도·압력·시간
 *   - 지시계(CI·BI·보위딕) 중 하나라도 불합격이면 화면 맨 위와 대시보드에 경고가 뜨고,
 *     재멸균·장비 점검·사용 보류 같은 조치를 기록하면 경고가 풀립니다.
 *   - BI(생물학적 지시계)는 배양 뒤 결과가 나오므로 "대기"로 저장했다가 나중에 [합격]/[불합격]을 누릅니다.
 */
import { html, useState, useEffect, fmtDate, fmtDot, fmtNumber, fmtTime, toQuery, todayStr, cx } from '../lib.js';
import { api } from '../api.js';
import { setQuery } from '../router.js';
import { toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, IconButton, Badge, Icon, Tabs, Modal, Field, Input, Textarea, Select,
  useApi, useForm, Loading, ErrorState, EmptyState, Menu, Stat, Callout, DataTable, PrintDoc, printModal,
} from '../ui/index.js';
import { ChoiceGroup, MonthNav, usePeople, fmtYm } from './equipment.js';

const PROGRAMS = ['일반', '파우치', '고속', '기타'];
const RESULT = {
  pass: { label: '합격', color: 'green' },
  fail: { label: '불합격', color: 'red' },
  pending: { label: '대기', color: 'amber' },
  na: { label: '해당 없음', color: 'gray' },
};
const LOAD_CHIPS = ['기구 파우치 25개', '핸드피스 8개', '기본 기구 세트 12개', '외과 기구 세트 2개 + 파우치 10개', '스케일러 팁 파우치 20개'];
const RECOMMENDED = [
  '해당 묶음(적재물)은 사용하지 말고 따로 보관 — 결과 확인 전까지 사용 보류',
  '같은 묶음을 다시 멸균(재멸균)하고 지시계 결과 확인',
  '멸균기 점검: 도어 개스킷·필터·급수 상태 확인, 반복되면 업체 AS 요청 (장비·점검에 기록)',
];
const ACTION_CHIPS = ['해당 묶음 사용 보류 후 재멸균, 재멸균 결과 합격 확인', '멸균기 업체 점검 요청 (장비·점검에 기록)', 'BI 재검사 예정, 결과 확인 전 사용 보류'];

/** 기록 하나의 지시계 결과 배지 (해당 없음은 숨김) */
function ResultBadges({ log }) {
  const items = [
    ['CI', log.ciResult],
    ['BI', log.biResult],
    ['보위딕', log.bowieDick],
  ].filter(([, r]) => r && r !== 'na');
  return html`<span class="fx-badges">
    ${items.map(([k, r]) => html`<${Badge} color=${RESULT[r].color} title=${`${k}: ${RESULT[r].label}`}>${k} ${RESULT[r].label}</${Badge}>`)}
  </span>`;
}

function valuesText(l) {
  return [
    l.temperature != null ? `${fmtNumber(l.temperature, 1)}℃` : null,
    l.pressure != null ? `${fmtNumber(l.pressure, 1)}kPa` : null,
    l.durationMin != null ? `${l.durationMin}분` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const toNum = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(/,/g, '')));

// 마지막으로 고른 멸균기를 이 기기에 기억 (다음에 열 때 같은 멸균기로 시작)
function rememberSterilizer(id) {
  try {
    localStorage.setItem('dx-ster-last', String(id));
  } catch {
    /* 저장이 막혀 있어도 괜찮음 */
  }
}
function lastSterilizer() {
  try {
    return Number(localStorage.getItem('dx-ster-last')) || null;
  } catch {
    return null;
  }
}

// ---------------- 기록 입력 양식 (새 기록·수정 공통) ----------------
function SterForm({ meta, people, log, sterilizerId, date, onSterilizerChange, onDateChange, onSaved, onCancel }) {
  const editing = !!log;
  const def = meta.defaults[sterilizerId] || { nextCycle: 1, program: '일반', byProgram: meta.programDefaults, lastLoadDesc: '' };
  const initial = editing
    ? {
        sterilizerId: log.sterilizerId, date: log.date, cycleNo: log.cycleNo, program: log.program,
        temperature: log.temperature ?? '', pressure: log.pressure ?? '', durationMin: log.durationMin ?? '',
        ciResult: log.ciResult, biResult: log.biResult, bowieDick: log.bowieDick,
        loadDesc: log.loadDesc || '', operatorId: log.operatorId ? String(log.operatorId) : '', note: log.note || '',
      }
    : {
        sterilizerId, date, cycleNo: def.nextCycle, program: def.program,
        temperature: def.byProgram[def.program]?.temperature ?? '', pressure: def.byProgram[def.program]?.pressure ?? '', durationMin: def.byProgram[def.program]?.durationMin ?? '',
        ciResult: 'pass', biResult: 'na', bowieDick: def.suggestBowieDick ? 'pass' : 'na',
        loadDesc: '', operatorId: meta.defaultOperatorId ? String(meta.defaultOperatorId) : '', note: '',
      };
  const f = useForm(initial);
  const v = f.values;
  const failed = v.ciResult === 'fail' || v.biResult === 'fail' || v.bowieDick === 'fail';

  // 프로그램을 바꾸면 그 프로그램으로 지난번에 기록한 온도·압력·시간을 채워 줌
  const pickProgram = (p) => {
    f.set('program', p);
    const pv = (meta.defaults[v.sterilizerId] || def).byProgram[p] || meta.programDefaults[p];
    if (pv) {
      f.set('temperature', pv.temperature ?? '');
      f.set('pressure', pv.pressure ?? '');
      f.set('durationMin', pv.durationMin ?? '');
    }
  };

  const save = f.submit(async (val) => {
    const body = {
      date: val.date,
      sterilizerId: Number(val.sterilizerId),
      cycleNo: Number(val.cycleNo),
      program: val.program,
      temperature: toNum(val.temperature),
      pressure: toNum(val.pressure),
      durationMin: toNum(val.durationMin),
      ciResult: val.ciResult,
      biResult: val.biResult,
      bowieDick: val.bowieDick,
      loadDesc: val.loadDesc || null,
      operatorId: val.operatorId ? Number(val.operatorId) : null,
      note: val.note || null,
    };
    const saved = editing ? await api.patch(`/facility/sterilization/logs/${log.id}`, body) : await api.post('/facility/sterilization/logs', body);
    if (saved.failed) toast.warn(`${saved.cycleNo}회차를 불합격으로 저장했습니다. 해당 묶음은 사용하지 말고 조치를 기록해 주세요.`);
    else toast.success(editing ? '수정했습니다.' : `${saved.sterilizerName} ${saved.cycleNo}회차를 기록했습니다.`);
    onSaved(saved);
  });

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(e);
  };
  const step = (n) => f.set('cycleNo', Math.max(1, (Number(v.cycleNo) || 1) + n));

  const resultItems = (withPending) => [
    { value: 'pass', label: '합격', tone: 'pass', icon: 'circle-check' },
    { value: 'fail', label: '불합격', tone: 'fail', icon: 'circle-x' },
    ...(withPending ? [{ value: 'pending', label: '대기', tone: 'pending', icon: 'hourglass' }] : []),
    { value: 'na', label: '안 함', tone: 'none' },
  ];

  return html`<form class="stack" onSubmit=${save} onKeyDown=${onKeyDown} aria-label=${editing ? '멸균 기록 수정' : '멸균 기록 입력'}>
    <section class="fx-form-section">
      <div class="fx-section-title"><${Icon} name="thermometer" size=${14} />멸균기</div>
      <div class="fx-choices" role="radiogroup" aria-label="멸균기">
        ${meta.sterilizers.map(
          (s) => html`<button type="button" role="radio" aria-checked=${Number(v.sterilizerId) === s.id ? 'true' : 'false'} class="fx-choice fx-choice-big"
            onClick=${() => (editing ? f.set('sterilizerId', s.id) : onSterilizerChange(s.id))}>
            <span>${s.name}</span><small>${[s.model, s.status !== '정상' ? s.status : null].filter(Boolean).join(' · ') || ' '}</small>
          </button>`
        )}
      </div>
      <div class="row wrap" style=${{ gap: '16px', alignItems: 'flex-end' }}>
        <${Field} label="날짜" error=${f.errors.date}>
          <${Input} type="date" value=${v.date} max=${todayStr()} style=${{ height: '44px', width: '170px' }}
            onInput=${(e) => (editing ? f.set('date', e.target.value) : e.target.value && onDateChange(e.target.value))} />
        </${Field}>
        <${Field} label="회차 (그날 몇 번째)" error=${f.errors.cycleNo}>
          <div class="fx-stepper">
            <button type="button" aria-label="회차 하나 줄이기" onClick=${() => step(-1)}>−</button>
            <input inputmode="numeric" aria-label="회차" value=${v.cycleNo} onInput=${(e) => f.set('cycleNo', e.target.value.replace(/\D/g, ''))} />
            <button type="button" aria-label="회차 하나 늘리기" onClick=${() => step(1)}>+</button>
          </div>
        </${Field}>
      </div>
    </section>

    <section class="fx-form-section">
      <div class="fx-section-title"><${Icon} name="settings" size=${14} />프로그램·측정값</div>
      <${ChoiceGroup} label="프로그램" value=${v.program} onChange=${pickProgram} items=${PROGRAMS.map((p) => ({ value: p, label: p }))} />
      <div class="fx-measure">
        <${Field} label="온도" error=${f.errors.temperature}>
          <div class="fx-unit-input"><${Input} inputmode="decimal" aria-label="온도(℃)" ...${f.bind('temperature')} /><span>℃</span></div>
        </${Field}>
        <${Field} label="압력 (게이지)" error=${f.errors.pressure}>
          <div class="fx-unit-input"><${Input} inputmode="decimal" aria-label="압력(kPa)" ...${f.bind('pressure')} /><span>kPa</span></div>
        </${Field}>
        <${Field} label="멸균 시간" error=${f.errors.durationMin}>
          <div class="fx-unit-input"><${Input} inputmode="numeric" aria-label="멸균 시간(분)" ...${f.bind('durationMin')} /><span>분</span></div>
        </${Field}>
      </div>
      <p class="hint">멸균기 화면·출력지에 나온 값을 적어 주세요. 압력은 kPa (2.1 bar = 210 kPa).</p>
    </section>

    <section class="fx-form-section">
      <div class="fx-section-title"><${Icon} name="square-check" size=${14} />지시계 결과</div>
      <div class="fx-indicator-row">
        <div class="fx-ind-label">CI<small>화학적 지시계</small></div>
        <${ChoiceGroup} label="CI 결과" value=${v.ciResult} onChange=${(x) => f.set('ciResult', x)} items=${resultItems(false)} />
      </div>
      <div class="fx-indicator-row">
        <div class="fx-ind-label">BI<small>생물학적 지시계</small></div>
        <${ChoiceGroup} label="BI 결과" value=${v.biResult} onChange=${(x) => f.set('biResult', x)} items=${resultItems(true)} />
      </div>
      <div class="fx-indicator-row">
        <div class="fx-ind-label">보위딕<small>진공·증기 침투 시험</small></div>
        <${ChoiceGroup} label="보위딕 결과" value=${v.bowieDick} onChange=${(x) => f.set('bowieDick', x)} items=${resultItems(false)} />
      </div>
      ${v.biResult === 'pending' ? html`<p class="hint">BI는 배양이 끝난 뒤 목록에서 [합격]/[불합격]을 눌러 결과를 넣을 수 있습니다.</p>` : null}
    </section>

    <section class="fx-form-section">
      <div class="fx-section-title"><${Icon} name="package" size=${14} />적재물·담당</div>
      <${Field} label="적재물" error=${f.errors.loadDesc} hint="물건과 개수만 적어 주세요. 환자 이름·차트번호는 적지 않습니다.">
        <${Input} ...${f.bind('loadDesc')} placeholder="예: 기구 파우치 25개" maxlength="200" style=${{ height: '44px' }} />
      </${Field}>
      <div class="row wrap" style=${{ gap: '6px' }}>
        ${!editing && def.lastLoadDesc
          ? html`<button type="button" class="fx-chip" onClick=${() => f.set('loadDesc', def.lastLoadDesc)}><${Icon} name="history" size=${12} />지난번과 같게: ${def.lastLoadDesc}</button>`
          : null}
        ${LOAD_CHIPS.filter((c) => c !== def.lastLoadDesc).map((c) => html`<button type="button" class="fx-chip" aria-pressed=${v.loadDesc === c ? 'true' : 'false'} onClick=${() => f.set('loadDesc', c)}>${c}</button>`)}
      </div>
      <div class="row wrap" style=${{ gap: '12px', alignItems: 'flex-start' }}>
        <${Field} label="담당자" error=${f.errors.operatorId} class="grow">
          <${Select} ...${f.bind('operatorId')} placeholder="기록하는 사람" options=${people.map((p) => ({ value: String(p.id), label: `${p.name}${p.jobTitle ? ` (${p.jobTitle})` : ''}` }))} style=${{ height: '44px' }} />
        </${Field}>
        <${Field} label="메모" error=${f.errors.note} class="grow">
          <${Input} ...${f.bind('note')} placeholder="예: 주간 BI 시험 포함" maxlength="1000" style=${{ height: '44px' }} />
        </${Field}>
      </div>
    </section>

    ${failed
      ? html`<${Callout} kind="danger" title="불합격 결과가 있습니다.">
          저장하면 경고가 뜹니다. 이 묶음은 사용하지 마세요. 저장 뒤 목록에서 [조치 기록]으로 재멸균·점검 내용을 남겨 주세요.
        </${Callout}>`
      : null}

    <div class="fx-save-bar">
      <${Button} type="submit" variant=${failed ? 'danger-solid' : 'primary'} icon="save" loading=${f.busy} disabled=${!v.sterilizerId}>
        ${editing ? '수정 저장' : failed ? '불합격으로 기록' : '기록 저장'}
      </${Button}>
      ${onCancel ? html`<${Button} onClick=${onCancel}>취소</${Button}>` : null}
      <span class="small muted desktop-only">Ctrl + Enter 로도 저장됩니다</span>
    </div>
  </form>`;
}

// ---------------- 조치 기록 창 (불합격 → 경고 해제) ----------------
function ResolveModal({ log, onClose, onSaved }) {
  const f = useForm({ actionNote: '' });
  const save = f.submit(async (v) => {
    const r = await api.post(`/facility/sterilization/logs/${log.id}/resolve`, v);
    toast.success('조치 내용을 기록했습니다.');
    onSaved(r);
  });
  return html`<${Modal}
    open=${true}
    title="불합격 조치 기록"
    onClose=${onClose}
    busy=${f.busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${f.busy} onClick=${save}>조치 완료로 기록</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <div class="small text-2">
        <strong>${log.sterilizerName}</strong> · ${fmtDate(log.date)} · ${log.cycleNo}회차 · <${ResultBadges} log=${log} />
        ${log.loadDesc ? html`<div class="mt-1">적재물: ${log.loadDesc}</div>` : null}
      </div>
      <${Callout} kind="warn" title="권장 조치">
        <ul class="fx-actions-list">${RECOMMENDED.map((r) => html`<li>${r}</li>`)}</ul>
      </${Callout}>
      <${Field} label="한 일" required error=${f.errors.actionNote}>
        <${Textarea} rows=${3} ...${f.bind('actionNote')} placeholder="예: 해당 묶음 사용 보류 후 재멸균, 재멸균 결과 합격 확인" />
      </${Field}>
      <div class="row wrap" style=${{ gap: '6px' }}>
        ${ACTION_CHIPS.map((c) => html`<button type="button" class="fx-chip" onClick=${() => f.set('actionNote', f.values.actionNote ? `${f.values.actionNote}\n${c}` : c)}>${c}</button>`)}
      </div>
    </form>
  </${Modal}>`;
}

/** 공통: 기록 한 줄에 대한 동작(수정·삭제·BI 결과·조치) */
function useLogActions(reloadAll) {
  const [editLog, setEditLog] = useState(null);
  const [resolveLog, setResolveLog] = useState(null);
  const setBi = async (l, result) => {
    try {
      await api.post(`/facility/sterilization/logs/${l.id}/bi`, { result });
      if (result === 'fail') toast.warn('BI 불합격으로 기록했습니다. 해당 묶음 사용을 멈추고 조치를 기록해 주세요.');
      else toast.success('BI 합격으로 기록했습니다.');
      reloadAll();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async (l) => {
    if (!(await confirmDialog({ title: '이 멸균 기록을 삭제할까요?', message: `${l.sterilizerName} · ${fmtDate(l.date)} · ${l.cycleNo}회차\n삭제하면 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/facility/sterilization/logs/${l.id}`);
      toast.success('삭제했습니다.');
      reloadAll();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const menu = (l) => [
    l.canEdit && { label: '수정', icon: 'pencil', onClick: () => setEditLog(l) },
    l.failed && !l.resolved && { label: '조치 기록', icon: 'clipboard-list', onClick: () => setResolveLog(l) },
    l.biResult === 'pending' && { label: 'BI 합격', icon: 'circle-check', onClick: () => setBi(l, 'pass') },
    l.biResult === 'pending' && { label: 'BI 불합격', icon: 'circle-x', onClick: () => setBi(l, 'fail') },
    l.canEdit && '-',
    l.canEdit && { label: '삭제', icon: 'trash-2', danger: true, onClick: () => remove(l) },
  ].filter(Boolean);
  return { editLog, setEditLog, resolveLog, setResolveLog, setBi, menu };
}

function LogModals({ actions, meta, people, onDone }) {
  const { editLog, setEditLog, resolveLog, setResolveLog } = actions;
  return html`
    ${editLog && meta
      ? html`<${Modal} open=${true} size="lg" title=${`멸균 기록 수정 — ${editLog.sterilizerName} ${editLog.cycleNo}회차`} onClose=${() => setEditLog(null)}>
          <${SterForm} meta=${meta} people=${people} log=${editLog} onCancel=${() => setEditLog(null)} onSaved=${() => { setEditLog(null); onDone(); }} />
        </${Modal}>`
      : null}
    ${resolveLog ? html`<${ResolveModal} log=${resolveLog} onClose=${() => setResolveLog(null)} onSaved=${() => { setResolveLog(null); onDone(); }} />` : null}
  `;
}

// ---------------- 맨 위 경고: 미해결 불합격, BI 대기 ----------------
function Alerts({ meta, actions }) {
  if (!meta) return null;
  return html`
    ${meta.unresolved.length
      ? html`<${Callout} kind="danger" class="fx-mb" title=${`멸균 불합격 ${meta.unresolved.length}건 — 조치가 필요합니다.`}>
          <div class="stack sm mt-1">
            ${meta.unresolved.map(
              (l) => html`<div class="row wrap" style=${{ gap: '8px' }} key=${l.id}>
                <span class="strong">${l.sterilizerName} · ${fmtDate(l.date)} · ${l.cycleNo}회차</span>
                <${ResultBadges} log=${l} />
                ${l.loadDesc ? html`<span class="small text-2">${l.loadDesc}</span>` : null}
                <span class="grow"></span>
                <${Button} size="sm" variant="danger-solid" icon="clipboard-list" onClick=${() => actions.setResolveLog(l)}>조치 기록</${Button}>
              </div>`
            )}
            <div class="small">
              권장 조치:
              <ul class="fx-actions-list">${RECOMMENDED.map((r) => html`<li>${r}</li>`)}</ul>
            </div>
          </div>
        </${Callout}>`
      : null}
    ${meta.pendingBi.length
      ? html`<${Callout} kind="warn" icon="hourglass" class="fx-mb" title=${`BI 결과 확인 대기 ${meta.pendingBi.length}건`}>
          <div class="stack sm mt-1">
            ${meta.pendingBi.map(
              (l) => html`<div class="row wrap" style=${{ gap: '8px' }} key=${l.id}>
                <span>${l.sterilizerName} · ${fmtDate(l.date)} · ${l.cycleNo}회차</span>
                <span class="grow"></span>
                <${Button} size="sm" icon="circle-check" onClick=${() => actions.setBi(l, 'pass')}>BI 합격</${Button}>
                <${Button} size="sm" variant="danger" icon="circle-x" onClick=${() => actions.setBi(l, 'fail')}>BI 불합격</${Button}>
              </div>`
            )}
          </div>
        </${Callout}>`
      : null}
  `;
}

// ---------------- 오늘 기록 탭 ----------------
function TodayTab({ metaApi, people, actions, date, setDate, refresh }) {
  const { data: meta } = metaApi;
  const [sid, setSid] = useState(null);
  const logsApi = useApi(`/facility/sterilization/logs?date=${date}`);
  const [stamp, setStamp] = useState(0);

  // 멸균기 기본 선택: 이 기기에서 마지막에 쓴 멸균기 → 없으면 첫 번째
  useEffect(() => {
    if (meta && !sid && meta.sterilizers.length) {
      const last = lastSterilizer();
      setSid(meta.sterilizers.some((s) => s.id === last) ? last : meta.sterilizers[0].id);
    }
  }, [meta]);

  // 수정·삭제·BI 입력 뒤에는 목록을 다시 불러옴
  useEffect(() => {
    if (refresh) logsApi.reload();
  }, [refresh]);

  const afterSave = async () => {
    await Promise.all([metaApi.reload(), logsApi.reload()]);
    setStamp((n) => n + 1); // 양식을 새로 그려 다음 회차·지난 값으로 채움
  };

  if (!meta) return null;
  if (!meta.sterilizers.length) {
    return html`<${Card}>
      <${EmptyState} icon="thermometer" title="등록된 멸균기가 없습니다" desc="장비·점검에서 분류를 '멸균기'로 정해 장비를 등록하면 여기서 기록할 수 있습니다."
        action=${html`<a class="btn btn-primary" href="#/equipment"><${Icon} name="wrench" size=${16} />장비·점검으로</a>`} />
    </${Card}>`;
  }
  const logs = logsApi.data ? logsApi.data.rows : null;
  const isToday = date === todayStr();

  return html`<div class="fx-ster-grid">
    <${Card} title=${isToday ? '빠른 기록' : `${fmtDate(date)} 기록 추가`} icon="plus" sub=${meta.date === date ? '' : '불러오는 중…'}>
      ${sid && meta.date === date
        ? html`<${SterForm}
            key=${`${sid}-${date}-${stamp}`}
            meta=${meta}
            people=${people}
            sterilizerId=${sid}
            date=${date}
            onSterilizerChange=${(id) => { setSid(id); rememberSterilizer(id); }}
            onDateChange=${setDate}
            onSaved=${afterSave}
          />`
        : html`<${Loading} rows=${8} />`}
    </${Card}>
    <${Card}
      title=${isToday ? '오늘 기록' : `${fmtDate(date)} 기록`}
      sub=${logs ? `${logs.length}건` : ''}
      flush
      actions=${!isToday ? html`<${Button} size="sm" variant="ghost" onClick=${() => setDate(todayStr())}>오늘로</${Button}>` : null}
    >
      ${logsApi.error && !logs
        ? html`<${ErrorState} error=${logsApi.error} onRetry=${logsApi.reload} compact />`
        : !logs
          ? html`<${Loading} rows=${5} />`
          : !logs.length
            ? html`<${EmptyState} compact icon="thermometer" title=${isToday ? '오늘 기록이 아직 없습니다' : '이 날은 기록이 없습니다'} desc="멸균기를 돌린 뒤 왼쪽에서 바로 기록해 주세요." />`
            : html`<div>
                ${logs.map(
                  (l) => html`<div class=${cx('fx-log-row', l.failed && !l.resolved && 'is-fail')} key=${l.id}>
                    <div class="fx-cycle" aria-label=${`${l.cycleNo}회차`}><b>${l.cycleNo}</b><small>회차</small></div>
                    <div class="grow">
                      <div class="row wrap" style=${{ gap: '6px' }}>
                        <span class="strong">${l.sterilizerName}</span>
                        <${Badge}>${l.program}</${Badge}>
                        <${ResultBadges} log=${l} />
                        ${l.failed && l.resolved ? html`<${Badge} color="blue" title=${l.actionNote}>조치됨</${Badge}>` : null}
                      </div>
                      <div class="fx-values mt-1">${valuesText(l) || '측정값 없음'}</div>
                      <div class="small muted mt-1">
                        ${[l.loadDesc, l.operatorName, fmtTime(l.createdAt)].filter(Boolean).join(' · ')}
                      </div>
                      ${l.note ? html`<div class="small text-2 mt-1">메모: ${l.note}</div>` : null}
                      ${l.failed && l.resolved ? html`<div class="small mt-1"><span class="strong">조치:</span> ${l.actionNote}</div>` : null}
                      ${l.biResult === 'pending'
                        ? html`<div class="row wrap mt-2" style=${{ gap: '6px' }}>
                            <span class="small warning-text strong">BI 배양 중</span>
                            <${Button} size="sm" icon="circle-check" onClick=${() => actions.setBi(l, 'pass')}>합격</${Button}>
                            <${Button} size="sm" variant="danger" icon="circle-x" onClick=${() => actions.setBi(l, 'fail')}>불합격</${Button}>
                          </div>`
                        : null}
                      ${l.failed && !l.resolved
                        ? html`<div class="mt-2"><${Button} size="sm" variant="danger-solid" icon="clipboard-list" onClick=${() => actions.setResolveLog(l)}>조치 기록</${Button}></div>`
                        : null}
                    </div>
                    <${Menu} items=${actions.menu(l)} label=${`${l.cycleNo}회차 메뉴`} />
                  </div>`
                )}
              </div>`}
    </${Card}>
  </div>`;
}

// ---------------- 인쇄용 월간 기록부 ----------------
function PrintSheet({ month, sterilizerName, rows, summary, onClose }) {
  const short = (r) => (r === 'na' ? '-' : RESULT[r].label);
  return html`<${Modal}
    open=${true}
    size="xl"
    printKeep
    title="멸균기 운전 기록부 — 인쇄 미리보기"
    onClose=${onClose}
    footer=${html`<${Button} onClick=${onClose}>닫기</${Button}><${Button} variant="primary" icon="printer" onClick=${printModal}>인쇄 / PDF 저장</${Button}>`}
  >
    <${PrintDoc} title="멸균기 운전 기록부" meta=${`${fmtYm(month)}\n${sterilizerName}`}>
      <div class="fx-print-summary">
        <span>총 ${summary.count}회</span><span>기록한 날 ${summary.days}일</span><span>BI 시험 ${summary.biTests}회</span>
        <span>불합격 ${summary.failed}회</span>
      </div>
      ${rows.length
        ? html`<div class="table-wrap">
            <table class="table fx-print-table">
              <thead>
                <tr>
                  <th>날짜</th><th>멸균기</th><th>회차</th><th>프로그램</th><th>온도(℃)</th><th>압력(kPa)</th><th>시간(분)</th>
                  <th>CI</th><th>BI</th><th>보위딕</th><th>적재물</th><th>담당자</th><th>서명</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (l) => html`<tr key=${l.id}>
                    <td class="num">${fmtDot(l.date).slice(5)}</td>
                    <td>${l.sterilizerName.replace('고압증기멸균기 ', '')}</td>
                    <td class="num">${l.cycleNo}</td>
                    <td>${l.program}</td>
                    <td class="num">${l.temperature ?? ''}</td>
                    <td class="num">${l.pressure ?? ''}</td>
                    <td class="num">${l.durationMin ?? ''}</td>
                    <td class=${l.ciResult === 'fail' ? 'strong' : ''}>${short(l.ciResult)}</td>
                    <td class=${l.biResult === 'fail' ? 'strong' : ''}>${short(l.biResult)}</td>
                    <td class=${l.bowieDick === 'fail' ? 'strong' : ''}>${short(l.bowieDick)}</td>
                    <td class="fx-wrap">${l.loadDesc || ''}${l.failed && l.actionNote ? ` [조치: ${l.actionNote}]` : ''}</td>
                    <td>${l.operatorName || ''}</td>
                    <td class="fx-sign"></td>
                  </tr>`
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="muted">이 달에는 기록이 없습니다.</p>`}
      <p class="small muted mt-2">※ CI: 화학적 지시계, BI: 생물학적 지시계, 보위딕: 진공·증기 침투 시험. 이 기록부에는 환자 정보를 적지 않습니다.</p>
      <div class="fx-sign-row">
        <div>작성자 <span class="line"></span></div>
        <div>확인(실장) <span class="line"></span></div>
        <div>원장 <span class="line"></span></div>
      </div>
    </${PrintDoc}>
  </${Modal}>`;
}

// ---------------- 월별 기록 탭 ----------------
function MonthTab({ route, metaApi, actions, refresh }) {
  const q = route.query;
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : todayStr().slice(0, 7);
  const sterilizerId = q.sid || '';
  const { data, loading, error, reload } = useApi(`/facility/sterilization/logs${toQuery({ month, sterilizerId })}`);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (refresh) reload();
  }, [refresh]);
  const meta = metaApi.data;
  const sterName = sterilizerId && meta ? (meta.sterilizers.find((s) => String(s.id) === sterilizerId) || {}).name || '멸균기' : '전체 멸균기';

  const columns = [
    { key: 'date', label: '날짜', render: (l) => html`<span class="num nowrap">${fmtDate(l.date)}</span>` },
    { key: 'sterilizerName', label: '멸균기', render: (l) => html`<span class="nowrap">${l.sterilizerName}</span>` },
    { key: 'cycleNo', label: '회차', align: 'right', render: (l) => html`<span class="num">${l.cycleNo}</span>` },
    { key: 'program', label: '프로그램' },
    { key: 'values', label: '온도·압력·시간', render: (l) => html`<span class="fx-values nowrap">${valuesText(l)}</span>` },
    { key: 'results', label: '지시계', render: (l) => html`<${ResultBadges} log=${l} />` },
    { key: 'loadDesc', label: '적재물', render: (l) => html`<span class="small">${l.loadDesc || ''}</span>` },
    { key: 'operatorName', label: '담당자', render: (l) => html`<span class="nowrap">${l.operatorName || ''}</span>` },
    { key: 'm', label: html`<span class="sr-only">메뉴</span>`, class: 'actions', render: (l) => html`<span onClick=${(e) => e.stopPropagation()}><${Menu} items=${actions.menu(l)} /></span>` },
  ];
  const s = data && data.summary;

  return html`
    <div class="row wrap between fx-filters">
      <div class="row wrap" style=${{ gap: '10px' }}>
        <${MonthNav} value=${month} onChange=${(m) => setQuery({ month: m })} />
        <${Select} size="sm" aria-label="멸균기" value=${sterilizerId} onChange=${(e) => setQuery({ sid: e.target.value })} placeholder="전체 멸균기"
          options=${meta ? meta.sterilizers.map((x) => ({ value: String(x.id), label: x.name })) : []} style=${{ width: '190px' }} />
      </div>
      <${Button} icon="printer" disabled=${!data} onClick=${() => setPrinting(true)}>기록부 인쇄</${Button}>
    </div>
    ${s
      ? html`<div class="grid fx-stat-grid fx-mb">
          <${Stat} label="멸균 횟수" icon="thermometer" value=${s.count} unit="회" hint=${`기록한 날 ${s.days}일`} />
          <${Stat} label="BI 시험" icon="square-check" value=${s.biTests} unit="회" hint=${s.biPending ? `결과 대기 ${s.biPending}건` : '결과 모두 입력됨'} />
          <${Stat} label="불합격" icon="circle-alert" value=${s.failed} unit="회" color=${s.unresolved ? 'danger' : undefined} hint=${s.failed ? (s.unresolved ? `조치 필요 ${s.unresolved}건` : '모두 조치함') : '이상 없음'} />
          <${Stat} label="하루 평균" icon="activity" value=${s.days ? fmtNumber(s.count / s.days, 1) : 0} unit="회" />
        </div>`
      : null}
    <${Card} flush>
      <${DataTable}
        columns=${columns}
        rows=${data && data.rows}
        loading=${loading}
        error=${error}
        onRetry=${reload}
        compact
        caption=${`${fmtYm(month)} 멸균 기록`}
        rowClass=${(l) => (l.failed ? 'fx-fail-row' : '')}
        empty=${{ icon: 'thermometer', title: `${fmtYm(month)}에는 기록이 없습니다`, desc: '다른 달을 고르거나 [오늘 기록] 탭에서 기록해 주세요.' }}
      />
    </${Card}>
    ${printing && data ? html`<${PrintSheet} month=${month} sterilizerName=${sterName} rows=${data.rows} summary=${data.summary} onClose=${() => setPrinting(false)} />` : null}
  `;
}

export default function SterilizationPage({ route }) {
  const tab = route.query.tab === 'month' ? 'month' : 'today';
  // 기록할 날짜 (보통 오늘). 날짜마다 "다음 회차"가 달라서 기본값을 날짜별로 불러옴
  const [date, setDate] = useState(todayStr());
  const metaApi = useApi(`/facility/sterilization/meta?date=${date}`);
  const people = usePeople();
  // 수정·삭제 등 뒤에 목록들을 새로 고치라는 신호 (숫자가 바뀌면 각 탭이 다시 불러옴)
  const [refresh, setRefresh] = useState(0);
  const reloadAll = () => {
    metaApi.reload();
    setRefresh((n) => n + 1);
  };
  const actions = useLogActions(reloadAll);

  return html`
    <${PageHeader}
      title="멸균기 기록"
      desc="멸균기를 돌릴 때마다 회차·온도·지시계 결과를 기록합니다. 환자 정보는 적지 않습니다."
    />
    ${metaApi.error && !metaApi.data
      ? html`<${Card}><${ErrorState} error=${metaApi.error} onRetry=${metaApi.reload} /></${Card}>`
      : !metaApi.data
        ? html`<${Card}><${Loading} rows=${8} /></${Card}>`
        : html`
          <${Alerts} meta=${metaApi.data} actions=${actions} />
          <${Tabs}
            value=${tab}
            onChange=${(t) => setQuery({ tab: t === 'today' ? '' : t })}
            items=${[
              { value: 'today', label: '오늘 기록', icon: 'thermometer' },
              { value: 'month', label: '월별 기록·인쇄', icon: 'calendar-days' },
            ]}
          />
          ${tab === 'today'
            ? html`<${TodayTab} metaApi=${metaApi} people=${people} actions=${actions} date=${date} setDate=${setDate} refresh=${refresh} />`
            : html`<${MonthTab} route=${route} metaApi=${metaApi} actions=${actions} refresh=${refresh} />`}
          <${LogModals} actions=${actions} meta=${metaApi.data} people=${people} onDone=${reloadAll} />
        `}
  `;
}
