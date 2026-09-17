/**
 * common.js — общие мелочи, которые нужны на всех страницах сайта:
 * обёртка над Modrinth API, форматирование размера файла, debounce для
 * строк поиска и безопасная вставка текста в HTML.
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

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} КБ`;
  return `${mb.toFixed(1)} МБ`;
}

function formatCount(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'М';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'К';
  return String(n);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Карточка проекта Modrinth, общая для "Зеркала" и "Проверки на вирусы".
 *  actionsHtml — произвольная разметка кнопок/ссылок под описанием. */
function resultCardHTML(item, actionsHtml = '') {
  const icon = item.icon_url
    ? `<img class="result-icon" src="${escapeHtml(item.icon_url)}" alt="">`
    : `<div class="result-icon placeholder">🧩</div>`;
  const id = item.project_id || item.id || item.slug;
  return `
    <div class="result-card" data-project-id="${escapeHtml(id)}" data-slug="${escapeHtml(item.slug || '')}" data-type="${escapeHtml(item.project_type || '')}">
      <div class="result-head">
        ${icon}
        <div class="result-title-wrap">
          <div class="result-title">${escapeHtml(item.title)}</div>
          <div class="result-author">${escapeHtml(item.author || '')}</div>
        </div>
      </div>
      <div class="result-desc">${escapeHtml(item.description || '')}</div>
      <div class="result-meta">
        <span>⬇ ${formatCount(item.downloads)}</span>
        <span>★ ${formatCount(item.follows)}</span>
      </div>
      ${actionsHtml ? `<div class="result-actions">${actionsHtml}</div>` : ''}
    </div>
  `;
}

function debounce(fn, delay = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/** Сравнивает версии Minecraft вида "1.21.4" или "26.2" по компонентам. */
function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Самая старая версия Minecraft, которую мы показываем в списках выбора
 *  версии (везде, где такой список есть) — всё, что старше, отсекаем. */
const MIN_GAME_VERSION = '1.8.9';

/** Отфильтровывает версии старше MIN_GAME_VERSION.
 *  accessor достаёт строку версии из элемента списка (по умолчанию — v.version). */
function filterModernVersions(list, accessor = (v) => v.version) {
  return list.filter((v) => cmpVersions(accessor(v), MIN_GAME_VERSION) >= 0);
}

/**
 * Заменяет нативный <select> на аккуратный кастомный выпадающий список в
 * стиле "жидкого стекла", который ВСЕГДА открывается вниз. У обычного
 * браузерного <select> при нехватке места снизу список может открыться
 * вверх — этим нельзя управлять через CSS, поэтому рисуем список сами.
 *
 * Сам <select> остаётся в DOM (скрытым) и продолжает быть источником
 * правды: остальной код страницы как и раньше работает с ним через
 * .innerHTML / .disabled / .value и слушает 'change' — переписывать
 * логику на страницах не нужно.
 */
function enhanceSelectAsDropdown(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add('native-select-hidden');
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger glass-input';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const valueSpan = document.createElement('span');
  valueSpan.className = 'custom-select-value';
  trigger.appendChild(valueSpan);
  wrap.appendChild(trigger);

  // Панель со списком опций вешаем не внутрь .custom-select, а прямо в
  // <body> и позиционируем через position: fixed по координатам кнопки.
  // Иначе она обрезается по краю первого же предка с overflow: hidden —
  // а таким предком у нас всегда оказывается .wizard-shell (у него
  // overflow: hidden нужен для анимации шагов мастера), и на шаге версии
  // список получался обрезанным по нижней рамке карточки, что криво.
  const panel = document.createElement('div');
  panel.className = 'custom-select-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  document.body.appendChild(panel);

  function positionPanel() {
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const viewportSpaceBelow = window.innerHeight - rect.bottom - gap;
    panel.style.left = `${rect.left}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.top = `${rect.bottom + gap}px`;
    // Высоту списка ограничиваем свободным местом снизу (но не больше
    // "родного" максимума) — список остаётся аккуратным и не вылезает
    // за нижний край экрана, при этом всегда раскрывается именно вниз.
    panel.style.maxHeight = `${Math.max(120, Math.min(260, viewportSpaceBelow))}px`;
  }

  function renderOptions() {
    panel.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option' + (opt.selected ? ' is-selected' : '') + (!opt.value ? ' is-placeholder' : '');
      item.textContent = opt.textContent;
      item.disabled = opt.disabled;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(opt.selected));
      item.addEventListener('click', () => {
        select.value = opt.value;
        valueSpan.textContent = opt.textContent;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closePanel();
        trigger.focus();
      });
      panel.appendChild(item);
    });
  }

  function syncFromSelect() {
    trigger.disabled = select.disabled;
    const opt = select.options[select.selectedIndex];
    valueSpan.textContent = opt ? opt.textContent : '';
    if (!panel.hidden) renderOptions();
  }

  function openPanel() {
    if (trigger.disabled) return;
    renderOptions();
    positionPanel();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrap.classList.add('is-open');
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
  }
  function closePanel() {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('is-open');
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
  }
  function onOutsideClick(e) {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) closePanel();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { closePanel(); trigger.focus(); }
  }
  function onReposition() {
    if (!panel.hidden) positionPanel();
  }

  trigger.addEventListener('click', () => {
    if (panel.hidden) openPanel(); else closePanel();
  });

  // Страница как и раньше меняет список опций через select.innerHTML и
  // включает/выключает через select.disabled — подхватываем это здесь.
  const mo = new MutationObserver(syncFromSelect);
  mo.observe(select, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  select.addEventListener('change', syncFromSelect);

  syncFromSelect();
}

/**
 * Декодинг-эффект на логотипе шапки (.brand-name / .brand-suffix):
 * при переходе между вкладками текст сначала «шумит» случайными
 * символами и затем проявляется до настоящего слова, как будто
 * расшифровывается. Срабатывает при каждой загрузке страницы —
 * то есть при каждом переключении между разделами сайта.
 */
(function () {
  const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>/\\|{}[]?';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function scrambleReveal(el, frameMs = 35, revealStep = 1.6) {
    if (!el) return;
    const original = el.textContent;
    if (reduceMotion || !original) return;
    const len = original.length;
    let tick = 0;
    el.classList.add('decoding');
    const timer = setInterval(() => {
      tick++;
      const revealCount = Math.min(len, Math.floor(tick * revealStep));
      let out = '';
      for (let i = 0; i < len; i++) {
        if (i < revealCount || original[i] === ' ') {
          out += original[i];
        } else {
          out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
      }
      el.textContent = out;
      if (revealCount >= len) {
        clearInterval(timer);
        el.textContent = original;
        el.classList.remove('decoding');
      }
    }, frameMs);
  }

  function playBrandDecode() {
    scrambleReveal(document.querySelector('.brand-name'));
    scrambleReveal(document.querySelector('.brand-suffix'), 35, 1.6);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', playBrandDecode);
  } else {
    playBrandDecode();
  }
})();
