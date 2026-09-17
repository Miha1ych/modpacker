/**
 * virus-check.js — «Проверка на вирусы».
 * Только через файл: пользователь загружает свой .jar, весь разбор
 * (см. js/jar-analyzer.js) происходит локально в браузере, без Modrinth
 * и без какого-либо сервера — файл никуда не отправляется.
 */

const jarDropzone = document.getElementById('jarDropzone');
const jarFileInput = document.getElementById('jarFileInput');
const jarFileStatus = document.getElementById('jarFileStatus');
const jarReportSection = document.getElementById('jarReportSection');

jarDropzone.addEventListener('dragover', (e) => { e.preventDefault(); jarDropzone.classList.add('dragover'); });
jarDropzone.addEventListener('dragleave', () => jarDropzone.classList.remove('dragover'));
jarDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  jarDropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) handleJarFile(e.dataTransfer.files[0]);
});
jarFileInput.addEventListener('change', () => {
  if (jarFileInput.files[0]) handleJarFile(jarFileInput.files[0]);
});

const RISK_INFO = {
  critical: { icon: '⛔', cls: 'risk-critical', title: 'Высокий риск — похоже на вредоносный файл', sub: 'Найдены явные красные флаги (запуск процессов, вебхуки, кража токенов и т.п.). Настоятельно не рекомендуем ставить этот мод.' },
  medium:   { icon: '⚠️', cls: 'risk-medium', title: 'Есть подозрительные признаки', sub: 'Ничего однозначно критичного, но код делает то, что обычному моду на оптимизацию/удобство обычно не нужно. Стоит проверить вручную.' },
  low:      { icon: '🔎', cls: 'risk-low', title: 'Найдены незначительные особенности', sub: 'В основном обычные для модов вещи (сеть, файлы). Явных признаков вредоносности нет, но и это не гарантия на 100%.' },
  clean:    { icon: '✅', cls: 'risk-clean', title: 'Явных признаков вредоносного кода не найдено', sub: 'Локальный анализ ничего подозрительного не нашёл. Это не полноценный антивирус, но хороший знак.' },
};

async function handleJarFile(file) {
  if (!file.name.toLowerCase().endsWith('.jar') && !file.name.toLowerCase().endsWith('.zip')) {
    jarFileStatus.textContent = 'Это не похоже на .jar файл.';
    jarFileStatus.classList.add('error');
    return;
  }
  jarFileStatus.textContent = 'Разбираю архив и байткод классов…';
  jarFileStatus.classList.remove('error');
  jarReportSection.hidden = true;
  jarReportSection.innerHTML = '';

  try {
    const report = await analyzeJar(file, (p) => {
      jarFileStatus.textContent = `Разбираю классы… ${Math.round(p * 100)}%`;
    });
    jarFileStatus.textContent = `Готово: разобрано ${report.processedClasses} из ${report.totalClasses} классов.`;
    renderJarReport(report);
  } catch (err) {
    jarFileStatus.textContent = 'Не получилось разобрать файл: ' + err.message;
    jarFileStatus.classList.add('error');
  }
}

function renderJarReport(report) {
  const risk = RISK_INFO[report.risk];

  const metaHtml = report.meta ? `
    <div class="trust-grid">
      <div class="trust-item">
        <div class="trust-item-label">Название</div>
        <div class="trust-item-value">${escapeHtml(report.meta.name || report.meta.id || '—')}</div>
      </div>
      <div class="trust-item">
        <div class="trust-item-label">Загрузчик</div>
        <div class="trust-item-value">${escapeHtml(report.meta.loader || '—')}</div>
      </div>
      <div class="trust-item">
        <div class="trust-item-label">Версия</div>
        <div class="trust-item-value">${escapeHtml(report.meta.version || '—')}</div>
      </div>
      <div class="trust-item">
        <div class="trust-item-label">Автор</div>
        <div class="trust-item-value">${escapeHtml(report.meta.authors || '—')}</div>
      </div>
    </div>
  ` : '<p class="hint">Не нашли стандартных метаданных мода (fabric.mod.json / mods.toml / quilt.mod.json) — возможно, это не обычный мод-джар.</p>';

  const findingsHtml = report.findings.length
    ? report.findings.map((f) => `
        <div class="finding-row sev-${f.severity}">
          <span class="finding-sev sev-${f.severity}"></span>
          <div class="finding-body">
            <div class="finding-label">${escapeHtml(f.label)}${f.count > 1 ? `<span class="finding-count">× ${f.count}</span>` : ''}</div>
            ${f.detail ? `<div class="finding-detail">${escapeHtml(f.detail)}</div>` : ''}
          </div>
        </div>
      `).join('')
    : '<p class="hint">Ничего не найдено — ни одного совпадения с известными подозрительными паттернами.</p>';

  jarReportSection.innerHTML = `
    <div class="risk-banner ${risk.cls}">
      <span class="risk-banner-icon">${risk.icon}</span>
      <div>
        <div class="risk-banner-title">${risk.title}</div>
        <div class="risk-banner-sub">${risk.sub}</div>
      </div>
    </div>

    <h3 class="mods-group-title">Метаданные мода</h3>
    ${metaHtml}

    <h3 class="mods-group-title" style="margin-top:18px;">Файл</h3>
    <div class="file-row">
      <div class="file-name">${escapeHtml(report.fileName)} <span style="color:var(--text-faint); font-weight:400;">· ${formatSize(report.fileSize)}</span></div>
    </div>

    <h3 class="mods-group-title" style="margin-top:18px;">Что нашли (${report.findings.length})</h3>
    ${findingsHtml}

    <p class="hint" style="margin-top:14px;">
      Это автоматический поиск по паттернам в байткоде и строках класса, а не полноценный антивирус и не ИИ —
      он не «понимает» код, а ищет известные тревожные признаки. Отсутствие находок не гарантия безопасности,
      как и одна находка низкой важности — не повод паниковать (сеть и файлы использует большинство модов).
    </p>
  `;
  jarReportSection.hidden = false;
  jarReportSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
