/**
 * mirror.js — «Зеркало Модринта».
 * Простой поиск/просмотр каталога Modrinth прямо на нашем сайте: строка
 * поиска + тип проекта + сортировка, карточки со ссылкой на оригинал и
 * прямым скачиванием последнего файла.
 */

const searchInput = document.getElementById('searchInput');
const typeSelect = document.getElementById('typeSelect');
const sortSelect = document.getElementById('sortSelect');
const searchStatus = document.getElementById('searchStatus');
const resultGrid = document.getElementById('resultGrid');

async function runSearch() {
  const query = searchInput.value.trim();
  const type = typeSelect.value;
  const index = sortSelect.value;
  searchStatus.textContent = 'Ищу на Modrinth…';
  searchStatus.classList.remove('error');
  try {
    const facets = encodeURIComponent(JSON.stringify([[`project_type:${type}`]]));
    const data = await api(`/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=24&index=${index}`);
    if (!data.hits || data.hits.length === 0) {
      resultGrid.innerHTML = '';
      searchStatus.textContent = 'Ничего не найдено.';
      return;
    }
    resultGrid.innerHTML = data.hits.map((item) => resultCardHTML(item, `
      <a class="btn btn-ghost" href="https://modrinth.com/${escapeHtml(item.project_type)}/${escapeHtml(item.slug)}" target="_blank" rel="noopener">На Modrinth</a>
      <button class="btn btn-primary dl-btn" data-id="${item.project_id}">Скачать последнее</button>
    `)).join('');
    searchStatus.textContent = `Найдено: ${data.total_hits}`;
  } catch (err) {
    searchStatus.textContent = err.message;
    searchStatus.classList.add('error');
  }
}

const debouncedSearch = debounce(runSearch, 450);
searchInput.addEventListener('input', debouncedSearch);
typeSelect.addEventListener('change', runSearch);
sortSelect.addEventListener('change', runSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

resultGrid.addEventListener('click', async (e) => {
  const btn = e.target.closest('.dl-btn');
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Ищу файл…';
  try {
    const versions = await api(`/project/${btn.dataset.id}/version`);
    const latest = versions.slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
    const file = latest && (latest.files.find((f) => f.primary) || latest.files[0]);
    if (!file) throw new Error('У проекта нет опубликованных файлов.');
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    btn.textContent = 'Ошибка';
    setTimeout(() => { btn.textContent = originalText; }, 1800);
    btn.disabled = false;
    return;
  }
  btn.textContent = originalText;
  btn.disabled = false;
});

runSearch();
