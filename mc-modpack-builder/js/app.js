/**
 * app.js — Miha1ych Packer
 * -----------------------------------------------------------------------
 * Вся логика сайта:
 *   1. пользователь идёт по мастеру: категория → загрузчик → ядро рендера
 *      → версия Minecraft (шаги анимированно сменяют друг друга);
 *   2. мы спрашиваем Modrinth API, у каких модов из mods-data.js есть
 *      сборка под этот загрузчик+версию, и рисуем карточки на шаге "Результат";
 *   3. по клику "Скачать ZIP" браузер сам, напрямую, качает .jar-файлы
 *      с cdn.modrinth.com и упаковывает их в архив через JSZip.
 * Сервера у этого сайта нет — он может жить как статика на GitHub Pages.
 * -----------------------------------------------------------------------
 */

const API = 'https://api.modrinth.com/v2';

/** Небольшая обёртка над fetch с человеческими ошибками */
async function api(path) {
  const res = await fetch(API + path);
  if (res.status === 429) {
    throw new Error('Modrinth временно ограничил запросы (слишком часто). Подожди минуту и попробуй снова.');
  }
  if (!res.ok) {
    throw new Error(`Modrinth API вернул ошибку ${res.status} на ${path}`);
  }
  return res.json();
}

function loadersForQuery(loader) {
  // Quilt умеет запускать моды под Fabric, поэтому ищем совместимость по обоим.
  if (loader === 'quilt') return ['quilt', 'fabric'];
  return [loader];
}

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} КБ`;
  return `${mb.toFixed(1)} МБ`;
}

// -------------------------------------------------------------------------
// Состояние приложения
// -------------------------------------------------------------------------
const state = {
  categoryId: null,
  loader: null,
  engine: null,
  gameVersion: null,
  resolved: { engine: null, core: [], optional: [], unavailable: [] },
  selected: new Set(), // project_id модов, отмеченных галочкой
};

// -------------------------------------------------------------------------
// Мастер шагов: анимированная смена карточек + история назад/вперёд
// -------------------------------------------------------------------------
const STEP_LABELS = {
  category: 'Что качаем',
  loader: 'Загрузчик',
  engine: 'Ядро рендера',
  version: 'Версия игры',
  results: 'Результат',
};

let stepsOrder = ['category', 'loader', 'version', 'results'];
let currentStepIndex = 0;

function computeSteps() {
  const cat = state.categoryId ? CATEGORIES[state.categoryId] : null;
  const seq = ['category', 'loader', 'version'];
  if (cat && cat.engines && cat.engines.length) seq.push('engine');
  seq.push('results');
  return seq;
}

function getStepEl(key) {
  return document.querySelector(`.wizard-step[data-step="${key}"]`);
}

function renderProgress() {
  const wrap = document.getElementById('wizardProgress');
  wrap.innerHTML = '';
  stepsOrder.forEach((key, i) => {
    if (i > 0) {
      const line = document.createElement('span');
      line.className = 'wp-line';
      wrap.appendChild(line);
    }
    const dot = document.createElement('span');
    dot.className = 'wp-dot' + (i === currentStepIndex ? ' active' : i < currentStepIndex ? ' done' : '');
    wrap.appendChild(dot);
  });
  const label = document.createElement('span');
  label.className = 'wp-label';
  label.textContent = `Шаг ${currentStepIndex + 1} из ${stepsOrder.length} — ${STEP_LABELS[stepsOrder[currentStepIndex]]}`;
  wrap.appendChild(label);
}

function goToIndex(newIndex, dir) {
  const curKey = stepsOrder[currentStepIndex];
  const nxtKey = stepsOrder[newIndex];
  const cur = getStepEl(curKey);
  const nxt = getStepEl(nxtKey);
  currentStepIndex = newIndex;
  renderProgress();

  if (!cur || cur === nxt) {
    if (nxt) nxt.hidden = false;
    return;
  }

  cur.classList.add(dir === 'fwd' ? 'leave-fwd' : 'leave-back');
  setTimeout(() => {
    cur.hidden = true;
    cur.classList.remove('leave-fwd', 'leave-back');

    nxt.hidden = false;
    nxt.classList.add(dir === 'fwd' ? 'enter-fwd-start' : 'enter-back-start');
    // форсируем reflow, чтобы браузер применил стартовое положение перед анимацией
    void nxt.offsetWidth;
    requestAnimationFrame(() => {
      nxt.classList.remove('enter-fwd-start', 'enter-back-start');
    });

    // Ядро рендера может зависеть от версии/загрузчика — проверяем доступность
    // каждый раз, когда пользователь попадает на этот шаг.
    if (nxtKey === 'engine') {
      checkEngineAvailability().catch((err) => setEngineStatus(err.message, true));
    }
  }, 300);
}

function goNext() {
  stepsOrder = computeSteps();
  if (currentStepIndex < stepsOrder.length - 1) goToIndex(currentStepIndex + 1, 'fwd');
}
function goBack() {
  if (currentStepIndex > 0) goToIndex(currentStepIndex - 1, 'back');
}

document.getElementById('wizardTrack').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="back"], [data-action="next"]');
  if (!btn) return;
  if (btn.dataset.action === 'back') goBack();
  if (btn.dataset.action === 'next') goNext();
});

// -------------------------------------------------------------------------
// Шаг 1 — категории
// -------------------------------------------------------------------------
function renderCategories() {
  const grid = document.getElementById('categoryGrid');
  grid.innerHTML = '';
  Object.values(CATEGORIES).forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'option-card';
    btn.innerHTML = `
      <span class="option-icon">${cat.emoji}</span>
      <span class="option-title">${cat.title}</span>
      <span class="option-tagline">${cat.tagline}</span>
    `;
    btn.addEventListener('click', () => {
      state.categoryId = cat.id;
      grid.querySelectorAll('.option-card').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.querySelector('[data-step-for="category"]').disabled = false;
      renderEngines();
    });
    grid.appendChild(btn);
  });
}

// -------------------------------------------------------------------------
// Шаг 2 — загрузчик
// -------------------------------------------------------------------------
document.getElementById('loaderGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.option-card');
  if (!btn) return;
  state.loader = btn.dataset.loader;
  document.querySelectorAll('#loaderGrid .option-card').forEach((b) => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.querySelector('[data-step-for="loader"]').disabled = false;

  // версия и ядро зависят от загрузчика — сбрасываем прошлый выбор
  const versionSelect = document.getElementById('versionSelect');
  versionSelect.disabled = true;
  versionSelect.innerHTML = '<option value="">Загружаю список версий…</option>';
  state.gameVersion = null;
  document.getElementById('versionNextBtn').disabled = true;
  resetEngineSelection();
  loadGameVersions().catch((err) => {
    versionSelect.innerHTML = `<option value="">Не удалось загрузить версии</option>`;
    setResolveStatus(err.message, true);
  });
});

// -------------------------------------------------------------------------
// Шаг 3 — версия Minecraft (список тянем динамически из Modrinth,
// поэтому он никогда не устареет; снапшоты не показываем — под них модов нет)
// -------------------------------------------------------------------------
let allGameVersions = [];

async function loadGameVersions() {
  if (allGameVersions.length === 0) {
    allGameVersions = await api('/tag/game_version');
  }
  renderVersionOptions();
}

function renderVersionOptions() {
  const versionSelect = document.getElementById('versionSelect');
  const list = allGameVersions.filter((v) => v.version_type === 'release');

  versionSelect.innerHTML = '<option value="">Выбери версию…</option>' +
    list.map((v) => `<option value="${v.version}">${v.version}</option>`).join('');
  versionSelect.disabled = false;
}

document.getElementById('versionSelect').addEventListener('change', (e) => {
  state.gameVersion = e.target.value || null;
  document.getElementById('versionNextBtn').disabled = !state.gameVersion;
  // версия могла изменить доступность ядер — просим перепроверить на шаге ядра
  resetEngineSelection();
});

document.getElementById('versionNextBtn').addEventListener('click', () => {
  stepsOrder = computeSteps();
  const nextKey = stepsOrder[currentStepIndex + 1];
  if (nextKey === 'engine') {
    // проверка доступности ядер запустится сама при появлении шага (см. goToIndex)
    goNext();
  } else {
    // для категорий без ядра рендера сразу подбираем моды и уходим к результату
    resolveMods().catch((err) => setResolveStatus(err.message, true));
  }
});

// -------------------------------------------------------------------------
// Шаг 4 — ядро рендера (обязателен только для категорий с engines)
// -------------------------------------------------------------------------
function renderEngines() {
  const cat = CATEGORIES[state.categoryId];
  const grid = document.getElementById('engineGrid');
  if (!cat || !cat.engines) { grid.innerHTML = ''; return; }
  grid.innerHTML = '';
  cat.engines.forEach((engine) => {
    const btn = document.createElement('button');
    btn.className = 'option-card';
    btn.dataset.engine = engine.id;
    btn.innerHTML = `
      <span class="option-title">${engine.title}</span>
      <span class="option-tagline">${engine.tagline}</span>
    `;
    btn.addEventListener('click', () => {
      if (btn.disabled || btn.classList.contains('disabled')) return;
      state.engine = engine.id;
      grid.querySelectorAll('.option-card').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('resolveBtn').disabled = false;
    });
    grid.appendChild(btn);
  });
}

function resetEngineSelection() {
  state.engine = null;
  const grid = document.getElementById('engineGrid');
  grid.querySelectorAll('.option-card').forEach((b) => b.classList.remove('selected'));
  const resolveBtn = document.getElementById('resolveBtn');
  if (resolveBtn) resolveBtn.disabled = true;
  setEngineStatus('');
}

function setEngineStatus(text, isError = false) {
  const el = document.getElementById('engineStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** Проверяет, есть ли у каждого ядра сборка под выбранный загрузчик+версию,
 *  и блокирует недоступные варианты прямо на карточках. */
async function checkEngineAvailability() {
  const cat = CATEGORIES[state.categoryId];
  if (!cat || !cat.engines || !cat.engines.length) return;

  const grid = document.getElementById('engineGrid');
  const loaders = loadersForQuery(state.loader);
  const loadersParam = encodeURIComponent(JSON.stringify(loaders));
  const versionParam = encodeURIComponent(JSON.stringify([state.gameVersion]));

  cat.engines.forEach((engine) => {
    const card = grid.querySelector(`[data-engine="${engine.id}"]`);
    card.classList.add('checking');
    card.disabled = false;
    card.classList.remove('disabled');
    card.querySelector('.option-tagline').textContent = engine.tagline;
  });
  setEngineStatus(`Проверяю доступность под ${state.loader} ${state.gameVersion}…`);

  const availability = await Promise.all(cat.engines.map(async (engine) => {
    for (const slug of engine.slugs) {
      try {
        const versions = await api(`/project/${slug}/version?loaders=${loadersParam}&game_versions=${versionParam}`);
        if (versions && versions.length > 0) return true;
      } catch (e) {
        // пробуем следующий альтернативный slug молча
      }
    }
    return false;
  }));

  let anyAvailable = false;
  cat.engines.forEach((engine, i) => {
    const card = grid.querySelector(`[data-engine="${engine.id}"]`);
    const available = availability[i];
    card.classList.remove('checking');
    if (available) {
      anyAvailable = true;
      return;
    }
    card.disabled = true;
    card.classList.add('disabled');
    card.classList.remove('selected');
    card.querySelector('.option-tagline').textContent = `Нет сборки под ${state.loader} ${state.gameVersion}`;
    if (state.engine === engine.id) {
      state.engine = null;
      document.getElementById('resolveBtn').disabled = true;
    }
  });

  setEngineStatus(anyAvailable ? '' : `Ни одно ядро рендера не собрано под ${state.loader} ${state.gameVersion} — попробуй другую версию или загрузчик.`, !anyAvailable);
}

function setResolveStatus(text, isError = false) {
  const el = document.getElementById('resolveStatus');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// -------------------------------------------------------------------------
// Подбор совместимых модов
// -------------------------------------------------------------------------
document.getElementById('resolveBtn').addEventListener('click', () => {
  resolveMods().catch((err) => setResolveStatus(err.message, true));
});

async function resolveOne(candidate, loadersParam, versionParam, metaBySlug) {
  for (const slug of candidate.slugs) {
    try {
      const versions = await api(`/project/${slug}/version?loaders=${loadersParam}&game_versions=${versionParam}`);
      if (versions && versions.length > 0) {
        const sorted = versions.slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
        return {
          slug,
          meta: metaBySlug[slug] || { title: slug, icon_url: null },
          version: sorted[0],
          note: candidate.note,
        };
      }
    } catch (e) {
      // пробуем следующий альтернативный slug молча
    }
  }
  return null;
}

async function resolveMods() {
  const category = CATEGORIES[state.categoryId];
  const resolveBtn = document.getElementById('resolveBtn');
  resolveBtn.disabled = true;
  setResolveStatus('Спрашиваю Modrinth, что совместимо…');

  const engineCandidate = (category.engines || []).find((e) => e.id === state.engine) || null;
  const engineOptionalCandidates = (category.engineOptional && state.engine && category.engineOptional[state.engine]) || [];
  const optionalCandidates = [...category.optional, ...engineOptionalCandidates];
  const allCandidates = [...(engineCandidate ? [engineCandidate] : []), ...category.core, ...optionalCandidates];
  const allSlugs = [...new Set(allCandidates.flatMap((c) => c.slugs))];

  // Один запрос за метаданными (иконки/названия) всех кандидатов разом.
  const metaList = await api(`/projects?ids=${encodeURIComponent(JSON.stringify(allSlugs))}`);
  const metaBySlug = {};
  metaList.forEach((p) => { metaBySlug[p.slug] = p; });

  const loaders = loadersForQuery(state.loader);
  const loadersParam = encodeURIComponent(JSON.stringify(loaders));
  const versionParam = encodeURIComponent(JSON.stringify([state.gameVersion]));

  const [engineResult, coreResults, optionalResults] = await Promise.all([
    engineCandidate ? resolveOne(engineCandidate, loadersParam, versionParam, metaBySlug) : Promise.resolve(null),
    Promise.all(category.core.map((c) => resolveOne(c, loadersParam, versionParam, metaBySlug))),
    Promise.all(optionalCandidates.map((c) => resolveOne(c, loadersParam, versionParam, metaBySlug))),
  ]);

  const unavailable = [];
  const core = [];
  const optional = [];

  if (engineCandidate && !engineResult) {
    unavailable.push({ slug: engineCandidate.slugs[0], meta: metaBySlug[engineCandidate.slugs[0]] || { title: engineCandidate.title } });
  }
  category.core.forEach((candidate, i) => {
    if (coreResults[i]) core.push(coreResults[i]);
    else unavailable.push({ slug: candidate.slugs[0], meta: metaBySlug[candidate.slugs[0]] || { title: candidate.slugs[0] } });
  });
  optionalCandidates.forEach((candidate, i) => {
    if (optionalResults[i]) optional.push(optionalResults[i]);
    else unavailable.push({ slug: candidate.slugs[0], meta: metaBySlug[candidate.slugs[0]] || { title: candidate.slugs[0] } });
  });

  state.resolved = { engine: engineResult, core, optional, unavailable };
  state.selected = new Set([
    ...(engineResult ? [engineResult.version.project_id] : []),
    ...core.map((m) => m.version.project_id),
  ]);

  renderResults();
  setResolveStatus(`Готово: найдено ${core.length + optional.length + (engineResult ? 1 : 0)} из ${allCandidates.length} модов.`);
  resolveBtn.disabled = false;
  goNext();
}

// -------------------------------------------------------------------------
// Рендер результатов
// -------------------------------------------------------------------------
function modCardHTML(mod, checked, index = 0) {
  const icon = mod.meta.icon_url
    ? `<img class="mod-icon" src="${mod.meta.icon_url}" alt="">`
    : `<div class="mod-icon placeholder">🧩</div>`;
  const file = mod.version.files.find((f) => f.primary) || mod.version.files[0];
  const size = file ? formatSize(file.size) : '';
  // Карточки результата влетают по очереди, а не все разом — задержка
  // растёт с индексом в своей группе (см. .stagger-in / fadeInUp в CSS).
  const delay = Math.min(index * 35, 350);
  return `
    <label class="mod-card stagger-in ${checked ? 'checked' : ''}" data-project-id="${mod.version.project_id}" style="animation-delay:${delay}ms">
      <input type="checkbox" class="mod-check" ${checked ? 'checked' : ''}>
      ${icon}
      <div class="mod-info">
        <div class="mod-title">${mod.meta.title || mod.slug}</div>
        <div class="mod-note">${mod.note || ''}${size ? ` · ${size}` : ''}</div>
      </div>
    </label>
  `;
}

function renderResults() {
  document.getElementById('resultsCategoryTitle').textContent = CATEGORIES[state.categoryId].title;

  const engineGroup = document.getElementById('engineResultGroup');
  const engineGrid = document.getElementById('engineModGrid');
  if (state.resolved.engine) {
    engineGroup.hidden = false;
    engineGrid.innerHTML = modCardHTML(state.resolved.engine, true);
  } else {
    engineGroup.hidden = true;
  }

  const coreGrid = document.getElementById('coreModsGrid');
  const optGrid = document.getElementById('optionalModsGrid');
  const unavailGroup = document.getElementById('unavailableGroup');
  const unavailGrid = document.getElementById('unavailableModsGrid');

  coreGrid.innerHTML = state.resolved.core.map((m, i) => modCardHTML(m, true, i)).join('') || '<p class="hint">Ничего не найдено.</p>';
  optGrid.innerHTML = state.resolved.optional.map((m, i) => modCardHTML(m, false, i)).join('') || '<p class="hint">Нет дополнительных модов.</p>';

  if (state.resolved.unavailable.length) {
    unavailGroup.hidden = false;
    unavailGrid.innerHTML = state.resolved.unavailable.map((m, i) => `
      <div class="mod-card unavailable stagger-in" style="animation-delay:${Math.min(i * 35, 350)}ms">
        <div class="mod-icon placeholder">🚫</div>
        <div class="mod-info">
          <div class="mod-title">${m.meta.title || m.slug}</div>
          <div class="mod-note">Нет сборки под ${state.loader} ${state.gameVersion}</div>
        </div>
      </div>
    `).join('');
  } else {
    unavailGroup.hidden = true;
  }

  document.querySelectorAll('.mod-card:not(.unavailable)').forEach((card) => {
    // Карточка — это <label>, клик по ней нативно переключает вложенный
    // чекбокс ровно один раз и порождает событие "change" — слушаем именно
    // его, а не click, иначе клик мимо инпута переключит чекбокс дважды.
    const input = card.querySelector('input');
    input.addEventListener('change', () => {
      const projectId = card.dataset.projectId;
      if (input.checked) state.selected.add(projectId);
      else state.selected.delete(projectId);
      card.classList.toggle('checked', input.checked);
      // маленький "поп" при каждом переключении — класс временный, чтобы
      // анимация переигрывалась и при повторном клике на ту же карточку
      card.classList.remove('check-pop');
      void card.offsetWidth; // форсируем reflow перед повторным добавлением класса
      card.classList.add('check-pop');
      updateDownloadButton();
    });
  });

  updateDownloadButton();
}

function updateDownloadButton() {
  document.getElementById('selectedCount').textContent = state.selected.size;
  document.getElementById('downloadBtn').disabled = state.selected.size === 0;
}

// -------------------------------------------------------------------------
// Скачивание и сборка ZIP
// -------------------------------------------------------------------------
document.getElementById('downloadBtn').addEventListener('click', () => {
  buildZip().catch((err) => {
    document.getElementById('downloadStatus').textContent = 'Ошибка: ' + err.message;
  });
});

/** Резолвит required-зависимость мода (например Fabric API) в конкретный файл */
async function resolveDependencyFile(dep) {
  if (dep.version_id) {
    return api(`/version/${dep.version_id}`);
  }
  if (dep.project_id) {
    const loaders = loadersForQuery(state.loader);
    const versions = await api(`/project/${dep.project_id}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([state.gameVersion]))}`);
    if (versions.length) {
      return versions.slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
    }
  }
  return null;
}

async function buildZip() {
  const allResolved = [...(state.resolved.engine ? [state.resolved.engine] : []), ...state.resolved.core, ...state.resolved.optional];
  const selectedMods = allResolved.filter((m) => state.selected.has(m.version.project_id));
  if (selectedMods.length === 0) return;

  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const downloadStatus = document.getElementById('downloadStatus');
  const downloadBtn = document.getElementById('downloadBtn');
  progressWrap.hidden = false;
  downloadBtn.disabled = true;
  progressFill.style.width = '0%';
  downloadStatus.textContent = 'Ищу зависимости (Fabric API и т.п.)…';

  // Собираем итоговый список файлов: сами моды + их required-зависимости.
  const includedProjectIds = new Set(selectedMods.map((m) => m.version.project_id));
  const filesToDownload = []; // { filename, url, isDependency, title }

  selectedMods.forEach((m) => {
    const file = m.version.files.find((f) => f.primary) || m.version.files[0];
    if (file) filesToDownload.push({ filename: file.filename, url: file.url, isDependency: false, title: m.meta.title || m.slug });
  });

  // required-зависимости, максимум 2 уровня вглубь
  let frontier = selectedMods.map((m) => m.version);
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const version of frontier) {
      const deps = (version.dependencies || []).filter((d) => d.dependency_type === 'required');
      for (const dep of deps) {
        const pid = dep.project_id;
        if (!pid || includedProjectIds.has(pid)) continue;
        includedProjectIds.add(pid);
        try {
          const depVersion = await resolveDependencyFile(dep);
          if (depVersion) {
            const file = depVersion.files.find((f) => f.primary) || depVersion.files[0];
            if (file) {
              filesToDownload.push({ filename: file.filename, url: file.url, isDependency: true, title: dep.file_name || pid });
              nextFrontier.push(depVersion);
            }
          }
        } catch (e) {
          // если зависимость не резолвится — просто пропускаем, не валим всю сборку
        }
      }
    }
    frontier = nextFrontier;
  }

  // Качаем файлы и кладём в zip
  const zip = new JSZip();
  let done = 0;
  const failed = [];

  for (const f of filesToDownload) {
    downloadStatus.textContent = `Скачиваю ${f.filename} (${done + 1}/${filesToDownload.length})…`;
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      zip.file(f.filename, blob);
    } catch (e) {
      failed.push(f);
    }
    done++;
    progressFill.style.width = `${Math.round((done / filesToDownload.length) * 90)}%`;
  }

  // Манифест внутри архива — что это и откуда
  const manifestLines = [
    `Miha1ych Packer — сборка "${CATEGORIES[state.categoryId].title}"`,
    `Загрузчик: ${state.loader}`,
    state.engine ? `Ядро рендера: ${state.engine}` : null,
    `Версия Minecraft: ${state.gameVersion}`,
    `Собрано: ${new Date().toISOString()}`,
    '',
    'Состав:',
    ...filesToDownload.filter((f) => !failed.includes(f)).map((f) => `- ${f.filename}${f.isDependency ? ' (зависимость)' : ''}`),
  ].filter((line) => line !== null);
  if (failed.length) {
    manifestLines.push('', 'Не удалось скачать (скачай вручную с modrinth.com):', ...failed.map((f) => `- ${f.filename}`));
  }
  zip.file('_MihaPacker_README.txt', manifestLines.join('\n'));

  downloadStatus.textContent = 'Упаковываю архив…';
  const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
    progressFill.style.width = `${90 + Math.round(meta.percent * 0.1)}%`;
  });

  const filename = `miha1ych-packer-${state.categoryId}-${state.loader}${state.engine ? '-' + state.engine : ''}-${state.gameVersion}.zip`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  progressFill.style.width = '100%';
  downloadStatus.textContent = failed.length
    ? `Готово, но ${failed.length} файл(ов) не скачались — см. _MihaPacker_README.txt в архиве.`
    : `Готово! Скачано ${filesToDownload.length - failed.length} файлов.`;
  downloadBtn.disabled = false;
}

// -------------------------------------------------------------------------
// Инициализация
// -------------------------------------------------------------------------
renderCategories();
renderEngines();
stepsOrder = computeSteps();
renderProgress();
