/*
 * 이 파일이 하는 일: [C. 행정·서류] 서식 보관함 화면입니다.
 *
 *   - 파일 올리기: 화면 아무 곳에나 파일을 끌어다 놓거나 [파일 올리기]로 고르기 (여러 개 한꺼번에, 1개당 20MB까지)
 *     → 올리기 창에서 분류(자동 추천)·설명을 확인하고 [올리기]
 *   - 분류 탭(서식/계약서/교육 자료/매뉴얼/기타), 검색
 *   - 미리보기(그림·글자 파일), 내려받기, 정보 수정·삭제(올린 사람 또는 실장 이상)
 * 파일은 DB 안에 저장되므로 백업 파일 하나에 함께 들어갑니다.
 */
import { html, useState, useEffect, useRef, fmtBytes, fmtRelative, fmtDateTime, toQuery } from '../lib.js';
import { api, readFileAsBase64 } from '../api.js';
import { setQuery } from '../router.js';
import { toast, confirmDialog } from '../store.js';
import {
  PageHeader, Card, Button, Badge, Icon, IconButton, Tabs, Field, Input, Select, SearchInput, Modal,
  useApi, Loading, ErrorState, EmptyState, Menu, Markdown, Callout,
} from '../ui/index.js';

const CATEGORIES = ['서식', '계약서', '교육 자료', '매뉴얼', '기타'];
const CATEGORY_ICON = { 서식: 'clipboard-list', 계약서: 'key-round', '교육 자료': 'graduation-cap', 매뉴얼: 'book-open', 기타: 'archive' };
const MAX_BYTES = 20 * 1024 * 1024;

/** 확장자 → 파일 모양(색·아이콘) */
function fileType(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'pdf') return { color: 'red', icon: 'file-text' };
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(e)) return { color: 'green', icon: 'file-spreadsheet' };
  if (['doc', 'docx', 'hwp', 'hwpx', 'rtf'].includes(e)) return { color: 'blue', icon: 'file-text' };
  if (['ppt', 'pptx', 'key'].includes(e)) return { color: 'amber', icon: 'chart-column' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return { color: 'purple', icon: 'eye' };
  if (['zip', '7z', 'rar', 'egg', 'alz'].includes(e)) return { color: 'amber', icon: 'archive' };
  return { color: '', icon: 'file-text' };
}
const extOf = (name) => {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
};

function FileTile({ ext }) {
  const t = fileType(ext);
  return html`<div class=${`forms-tile ${t.color}`} aria-hidden="true">
    <${Icon} name=${t.icon} size=${16} />
    <span class="forms-tile-ext">${(ext || 'file').slice(0, 4)}</span>
  </div>`;
}

/** 파일 이름으로 분류 추천 */
function guessCategory(name, fallback) {
  const n = String(name || '');
  if (/계약/.test(n)) return '계약서';
  if (/매뉴얼|절차|가이드|사용법|설명서/.test(n)) return '매뉴얼';
  if (/교육|체크리스트|온보딩|강의|연수/.test(n)) return '교육 자료';
  if (/양식|서식|신청|요청서|기록지|일지|대장|점검표/.test(n)) return '서식';
  return fallback && CATEGORIES.includes(fallback) ? fallback : '기타';
}

// ---------------- 올리기 창 ----------------
function UploadModal({ files, defaultCategory, onClose, onDone }) {
  const [items, setItems] = useState(() =>
    files.map((f, i) => ({
      key: i,
      file: f,
      category: guessCategory(f.name, defaultCategory),
      description: '',
      state: f.size > MAX_BYTES ? 'error' : f.size === 0 ? 'error' : 'ready',
      error: f.size > MAX_BYTES ? '20MB를 넘는 파일은 올릴 수 없습니다.' : f.size === 0 ? '빈 파일입니다.' : '',
    }))
  );
  const [busy, setBusy] = useState(false);
  const ready = items.filter((x) => x.state === 'ready' || x.state === 'failed');
  const set = (key, patch) => setItems((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  /** 한 개씩 차례로 올림 (큰 파일 여러 개를 한 번에 보내 서버가 버거워지지 않게) */
  const upload = async () => {
    if (!ready.length) return;
    setBusy(true);
    let ok = 0;
    for (const it of ready) {
      set(it.key, { state: 'uploading', error: '' });
      try {
        const data = await readFileAsBase64(it.file);
        await api.post('/documents/files', { name: it.file.name, mime: it.file.type, data, category: it.category, description: it.description });
        set(it.key, { state: 'done' });
        ok++;
      } catch (e) {
        set(it.key, { state: 'failed', error: e.message });
      }
    }
    setBusy(false);
    if (ok) {
      toast.success(`${ok}개 파일을 올렸습니다.`);
      onDone(ok === ready.length);
    }
  };

  return html`<${Modal}
    open=${true}
    size="lg"
    title=${`파일 올리기 (${files.length}개)`}
    onClose=${onClose}
    busy=${busy}
    footer=${html`
      <${Button} onClick=${onClose} disabled=${busy}>닫기</${Button}>
      <${Button} variant="primary" icon="upload" loading=${busy} disabled=${!ready.length} onClick=${upload}>${ready.length ? `${ready.length}개 올리기` : '올릴 파일 없음'}</${Button}>
    `}
  >
    <div class="stack">
      <${Callout} kind="warn" icon="shield-check">환자 개인정보(이름·연락처·주민번호·차트번호·진료 내용)가 담긴 파일은 올리지 마세요.</${Callout}>
      <div>
        ${items.map(
          (it) => html`<div class="forms-upload-item" key=${it.key}>
            <${FileTile} ext=${extOf(it.file.name)} />
            <div style=${{ minWidth: 0 }}>
              <div class="strong ellipsis" title=${it.file.name}>${it.file.name}</div>
              <div class="small muted row" style=${{ gap: '6px' }}>
                <span class="num">${fmtBytes(it.file.size)}</span>
                ${it.state === 'uploading' ? html`<span class="row" style=${{ gap: '4px' }}><span class="spinner"></span>올리는 중…</span>` : null}
                ${it.state === 'done' ? html`<span class="success-text row" style=${{ gap: '3px' }}><${Icon} name="circle-check" size=${13} />완료</span>` : null}
                ${it.error ? html`<span class="danger-text">${it.error}</span>` : null}
              </div>
            </div>
            <${Select}
              value=${it.category}
              disabled=${busy || it.state === 'done' || it.state === 'error'}
              onChange=${(e) => set(it.key, { category: e.target.value })}
              options=${CATEGORIES}
              aria-label=${`${it.file.name} 분류`}
            />
            ${it.state !== 'error' && it.state !== 'done'
              ? html`<div class="forms-desc"><${Input} size="sm" value=${it.description} disabled=${busy} onInput=${(e) => set(it.key, { description: e.target.value })} placeholder="설명 (선택) 예: 2026년 개정판, 원장님 확인 완료" maxlength="500" aria-label=${`${it.file.name} 설명`} /></div>`
              : null}
          </div>`
        )}
      </div>
    </div>
  </${Modal}>`;
}

// ---------------- 정보 수정 창 ----------------
function EditModal({ file, onClose, onSaved }) {
  const ext = extOf(file.name);
  const [name, setName] = useState(ext ? file.name.slice(0, -(ext.length + 1)) : file.name);
  const [category, setCategory] = useState(file.category);
  const [description, setDescription] = useState(file.description);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!name.trim()) return toast.warn('파일 이름을 입력해 주세요.');
    setBusy(true);
    try {
      await api.patch(`/documents/files/${file.id}`, { name: ext ? `${name.trim()}.${ext}` : name.trim(), category, description });
      toast.success('수정했습니다.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal}
    open=${true}
    title="파일 정보 수정"
    onClose=${onClose}
    busy=${busy}
    footer=${html`<${Button} onClick=${onClose}>취소</${Button}><${Button} variant="primary" loading=${busy} onClick=${save}>저장</${Button}>`}
  >
    <form class="stack" onSubmit=${save}>
      <${Field} label="파일 이름" required hint=${ext ? `확장자(.${ext})는 바뀌지 않습니다.` : null}>
        <${Input} value=${name} onInput=${(e) => setName(e.target.value)} maxlength="190" />
      </${Field}>
      <${Field} label="분류">
        <${Select} value=${category} onChange=${(e) => setCategory(e.target.value)} options=${CATEGORIES} />
      </${Field}>
      <${Field} label="설명">
        <${Input} value=${description} onInput=${(e) => setDescription(e.target.value)} maxlength="500" placeholder="어떤 파일인지 짧게" />
      </${Field}>
    </form>
  </${Modal}>`;
}

// ---------------- 미리보기 창 ----------------
/** 아주 간단한 CSV 읽기 (따옴표 안의 쉼표 처리) — 미리보기용 */
function parseCsv(text, sep = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= 200) break;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function PreviewModal({ file, onClose, onDownload }) {
  const isImage = file.previewable === 'image';
  const text = useApi(isImage ? null : `/documents/files/${file.id}/preview`);
  const [imgError, setImgError] = useState(false);
  let body;
  if (isImage) {
    body = imgError
      ? html`<${ErrorState} compact error=${{ message: '그림을 불러오지 못했습니다. 내려받아서 열어 주세요.' }} />`
      : html`<img class="forms-preview-img" src=${`/api/documents/files/${file.id}/preview`} alt=${file.name} onError=${() => setImgError(true)} />`;
  } else if (text.error) body = html`<${ErrorState} compact error=${text.error} onRetry=${text.reload} />`;
  else if (!text.data) body = html`<${Loading} />`;
  else {
    const t = text.data;
    if (t.ext === 'md') body = html`<div class="forms-preview-text" style=${{ fontFamily: 'var(--font)', whiteSpace: 'normal' }}><${Markdown} text=${t.text} /></div>`;
    else if (t.ext === 'csv' || t.ext === 'tsv') {
      const rows = parseCsv(t.text, t.ext === 'tsv' ? '\t' : ',');
      body = rows.length
        ? html`<div class="table-wrap" style=${{ maxHeight: '60vh', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <table class="table table-compact">
              <thead><tr>${rows[0].map((c) => html`<th>${c}</th>`)}</tr></thead>
              <tbody>${rows.slice(1).map((r) => html`<tr>${rows[0].map((_, j) => html`<td>${r[j] || ''}</td>`)}</tr>`)}</tbody>
            </table>
          </div>`
        : html`<p class="muted">내용이 없습니다.</p>`;
    } else body = html`<pre class="forms-preview-text">${t.text || '(내용 없음)'}</pre>`;
    if (t.truncated) body = html`${body}<p class="small muted mt-2">파일이 길어 앞부분만 보여 줍니다. 전체는 내려받아 확인하세요.</p>`;
  }
  return html`<${Modal}
    open=${true}
    size="lg"
    title=${file.name}
    onClose=${onClose}
    footer=${html`<${Button} onClick=${onClose}>닫기</${Button}><${Button} variant="primary" icon="download" onClick=${onDownload}>내려받기</${Button}>`}
  >
    ${body}
  </${Modal}>`;
}

// ---------------- 화면 ----------------
export default function FormsPage({ route }) {
  const q = route.query;
  const tab = CATEGORIES.includes(q.category) ? q.category : '';
  const [search, setSearch] = useState(q.q || '');
  const { data, loading, error, reload } = useApi(`/documents/files${toQuery({ category: tab, q: q.q || '' })}`);
  const [picked, setPicked] = useState(null); // 올리기 창에 넘길 파일들
  const [editing, setEditing] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef();
  const dragDepth = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.q || '') !== search) setQuery({ q: search });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const openPicker = () => inputRef.current && inputRef.current.click();
  const takeFiles = (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    if (files.length > 20) {
      toast.warn('한 번에 20개까지 올릴 수 있습니다. 앞의 20개만 골랐습니다.');
      files.length = 20;
    }
    setPicked(files);
  };

  const download = async (f) => {
    try {
      await api.download(`/documents/files/${f.id}/download`, f.name);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async (f) => {
    if (!(await confirmDialog({ title: '이 파일을 삭제할까요?', message: `"${f.name}" 파일을 지우면 되돌릴 수 없습니다.`, danger: true, confirmText: '삭제' }))) return;
    try {
      await api.del(`/documents/files/${f.id}`);
      toast.success('삭제했습니다.');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  // 화면 어디에 끌어다 놓아도 올리기 창이 열리게
  const dragProps = {
    onDragEnter: (e) => {
      if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
      e.preventDefault();
      dragDepth.current++;
      setDragOver(true);
    },
    onDragOver: (e) => {
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragOver(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      takeFiles(e.dataTransfer && e.dataTransfer.files);
    },
  };

  const counts = (data && data.counts) || {};
  const filtered = !!(tab || q.q);

  return html`<div ...${dragProps}>
    <${PageHeader}
      title="서식 보관함"
      desc="자주 쓰는 양식·계약서·교육 자료를 한곳에 모아 두고 누구나 내려받아 씁니다."
      actions=${html`<${Button} variant="primary" icon="upload" onClick=${openPicker}>파일 올리기</${Button}>`}
    />
    <input type="file" multiple ref=${inputRef} hidden onChange=${(e) => { takeFiles(e.target.files); e.target.value = ''; }} aria-label="올릴 파일 고르기" />

    <button type="button" class=${`forms-drop ${dragOver ? 'over' : ''}`} onClick=${openPicker}>
      <span class="icon-box blue"><${Icon} name=${dragOver ? 'download' : 'upload'} size=${20} /></span>
      <span class="grow">
        <span class="forms-drop-title" style=${{ display: 'block' }}>${dragOver ? '여기에 놓으면 올리기 창이 열립니다' : '파일을 여기로 끌어다 놓거나 눌러서 고르세요'}</span>
        <span class="small muted">여러 개를 한꺼번에 올릴 수 있습니다 · 1개당 20MB까지 · 환자 개인정보가 담긴 파일은 올리지 마세요</span>
      </span>
      <span class="btn btn-soft btn-sm desktop-only" aria-hidden="true">파일 고르기</span>
    </button>

    <${Tabs}
      value=${tab}
      onChange=${(t) => setQuery({ category: t })}
      items=${[
        { value: '', label: '전체', count: data ? data.totalAll : 0 },
        ...CATEGORIES.map((c) => ({ value: c, label: c, icon: CATEGORY_ICON[c], count: counts[c] || 0 })),
      ]}
    />
    <div class="row wrap" style=${{ marginBottom: '12px' }}>
      <${SearchInput} value=${search} onInput=${setSearch} placeholder="파일 이름·설명 검색" style=${{ maxWidth: '320px' }} />
      <div class="grow"></div>
      ${data ? html`<span class="small muted">전체 ${data.totalAll}개 · ${fmtBytes(data.totalBytes)}</span>` : null}
    </div>

    <${Card} flush>
      ${error && !data
        ? html`<${ErrorState} error=${error} onRetry=${reload} />`
        : loading && !data
          ? html`<${Loading} rows=${5} />`
          : !data.rows.length
            ? html`<${EmptyState}
                icon="folder-open"
                title=${filtered ? '조건에 맞는 파일이 없습니다' : '아직 올린 파일이 없습니다'}
                desc=${filtered ? '검색어나 분류를 바꿔 보세요.' : '연차 신청서, 근로계약서 양식처럼 자주 쓰는 파일을 올려 두세요.'}
                action=${filtered
                  ? html`<${Button} icon="x" onClick=${() => { setSearch(''); setQuery({ q: '', category: '' }); }}>필터 지우기</${Button}>`
                  : html`<${Button} variant="primary" icon="upload" onClick=${openPicker}>파일 올리기</${Button}>`}
              />`
            : html`<div class="list">
                ${data.rows.map(
                  (f) => html`<div class="list-item docs-row" key=${f.id}>
                    <button
                      type="button"
                      class="docs-row-link"
                      onClick=${() => (f.previewable ? setPreviewing(f) : download(f))}
                      title=${f.previewable ? '미리보기' : '내려받기'}
                    >
                      <${FileTile} ext=${f.ext} />
                      <span class="grow">
                        <span class="row wrap" style=${{ gap: '6px' }}>
                          <span class="list-title ellipsis">${f.name}</span>
                          <${Badge}>${f.category}</${Badge}>
                        </span>
                        ${f.description ? html`<span class="docs-excerpt ellipsis" style=${{ display: 'block' }}>${f.description}</span>` : null}
                        <span class="list-meta row wrap" style=${{ gap: '6px' }}>
                          <span>${f.uploaderName}</span><span>·</span><span title=${fmtDateTime(f.createdAt)}>${fmtRelative(f.createdAt)}</span>
                        </span>
                      </span>
                      <span class="small muted num forms-size">${fmtBytes(f.size)}</span>
                    </button>
                    <div class="forms-row-actions">
                      ${f.previewable ? html`<${IconButton} icon="eye" size="sm" label=${`${f.name} 미리보기`} onClick=${() => setPreviewing(f)} />` : null}
                      <${IconButton} icon="download" size="sm" label=${`${f.name} 내려받기`} onClick=${() => download(f)} />
                      ${f.canEdit
                        ? html`<${Menu}
                            label=${`${f.name} 메뉴`}
                            items=${[
                              { label: '정보 수정', icon: 'pencil', onClick: () => setEditing(f) },
                              '-',
                              { label: '삭제', icon: 'trash-2', danger: true, onClick: () => remove(f) },
                            ]}
                          />`
                        : null}
                    </div>
                  </div>`
                )}
              </div>`}
    </${Card}>

    ${picked
      ? html`<${UploadModal}
          files=${picked}
          defaultCategory=${tab}
          onClose=${() => {
            setPicked(null);
            reload();
          }}
          onDone=${(all) => {
            reload();
            if (all) setPicked(null);
          }}
        />`
      : null}
    ${editing ? html`<${EditModal} file=${editing} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); }} />` : null}
    ${previewing ? html`<${PreviewModal} file=${previewing} onClose=${() => setPreviewing(null)} onDownload=${() => download(previewing)} />` : null}
  </div>`;
}
