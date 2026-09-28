'use strict';
// Builds the printable week report. main.js calls window.renderReport(data) and prints the page to PDF.

(function () {
  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)'];
  const OTHER = 'var(--series-other)';
  const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h2 = (n) => `${Number(n).toFixed(2)}h`;
  const h1 = (n) => `${Number(n).toFixed(1)}h`;
  const clip = (text, max) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text));

  // Rectangle with rounded top corners only (data end), square at the baseline
  function topRounded(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
  }
  // Rectangle with rounded right corners only (data end of a horizontal bar)
  function rightRounded(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, h / 2, w));
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }

  function niceMax(value) {
    const steps = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100];
    return steps.find((s) => s >= value) || Math.ceil(value / 20) * 20;
  }

  // Colour follows the sprint: fixed order by the week's hours, max 7 colours, the rest folds into "Other"
  function colourMap(categories) {
    const map = new Map();
    categories.forEach((c, i) => map.set(c.name, i < SERIES.length ? SERIES[i] : OTHER));
    return map;
  }

  function legend(categories, colours) {
    const shown = categories.slice(0, SERIES.length);
    const rest = categories.length - shown.length;
    return `<div class="legend">${shown.map((c) => `<span><i style="background:${colours.get(c.name)}"></i>${esc(c.name)}</span>`).join('')}${rest > 0 ? `<span><i style="background:${OTHER}"></i>Other (${rest})</span>` : ''}</div>`;
  }

  // Stacked columns: one per day, segments per sprint, 8h target line
  function dayChart(report, colours) {
    const days = report.days.filter((d) => d.isWorkday || d.total > 0);
    const W = 720; const H = 230; const left = 34; const right = 70; const top = 18; const bottom = 30;
    const plotW = W - left - right; const plotH = H - top - bottom;
    const max = niceMax(Math.max(report.target, ...days.map((d) => d.total)) * 1.08);
    const y = (v) => top + plotH - (v / max) * plotH;
    const band = plotW / days.length;
    const barW = Math.min(24, band * 0.5);
    const tickStep = max <= 12 ? 2 : max <= 24 ? 4 : 10;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hours per day, stacked by ${esc(report.groupLabel)}">`;
    for (let v = 0; v <= max; v += tickStep) {
      svg += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
      svg += `<text class="tick" x="${left - 6}" y="${y(v) + 3}" text-anchor="end">${v}h</text>`;
    }
    days.forEach((d, i) => {
      const cx = left + band * i + band / 2;
      const x = cx - barW / 2;
      let base = 0;
      // same stacking order every day (the week's order), so each sprint sits at the same level
      const order = new Map(report.categories.map((c, ci) => [c.name, ci]));
      const segs = [...d.groups].sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
      segs.forEach((g, gi) => {
        const y0 = y(base);
        const y1 = y(base + g.hours);
        const isTop = gi === segs.length - 1;
        const gap = gi > 0 ? 2 : 0; // 2px surface gap between stacked segments
        const h = Math.max(0, y0 - y1 - gap);
        const colour = colours.get(g.name) || OTHER;
        svg += isTop
          ? `<path d="${topRounded(x, y1, barW, h, 4)}" fill="${colour}"/>`
          : `<rect x="${x}" y="${y1}" width="${barW}" height="${h}" fill="${colour}"/>`;
        base += g.hours;
      });
      if (d.total > 0) svg += `<text class="val" x="${cx}" y="${y(d.total) - 5}" text-anchor="middle">${esc(h1(d.total))}</text>`;
      svg += `<text class="tick" x="${cx}" y="${H - bottom + 16}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    // Daily target
    svg += `<line x1="${left}" x2="${W - right + 4}" y1="${y(report.target)}" y2="${y(report.target)}" stroke="var(--text-secondary)" stroke-width="1"/>`;
    svg += `<text class="target-lbl" x="${W - right + 8}" y="${y(report.target) + 3}">${esc(report.target)}h target</text>`;
    return `${svg}</svg>`;
  }

  // Horizontal bars, one colour (a single series needs no legend)
  function barChart(rows, width, labelWidth, ariaLabel) {
    const rowH = 30; const barH = 14; const top = 4; const right = 52;
    const H = top + rows.length * rowH + 4;
    const plotW = width - labelWidth - right;
    const max = Math.max(...rows.map((r) => r.hours), 0.01);
    let svg = `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
    svg += `<line x1="${labelWidth}" x2="${labelWidth}" y1="${top}" y2="${H - 4}" stroke="var(--axis)" stroke-width="1"/>`;
    rows.forEach((r, i) => {
      const yMid = top + i * rowH + rowH / 2;
      const w = Math.max(2, (r.hours / max) * plotW);
      svg += `<text class="lbl" x="${labelWidth - 8}" y="${r.sub ? yMid - 2 : yMid + 4}" text-anchor="end">${esc(r.label)}</text>`;
      if (r.sub) svg += `<text class="lbl-sub" x="${labelWidth - 8}" y="${yMid + 10}" text-anchor="end">${esc(r.sub)}</text>`;
      svg += `<path d="${rightRounded(labelWidth, yMid - barH / 2, w, barH, 4)}" fill="${r.colour || 'var(--series-1)'}"/>`;
      svg += `<text class="val" x="${labelWidth + w + 6}" y="${yMid + 4}">${esc(h2(r.hours))}</text>`;
    });
    return `${svg}</svg>`;
  }

  function foldRows(rows, limit, makeOther) {
    if (rows.length <= limit) return rows;
    const kept = rows.slice(0, limit - 1);
    const rest = rows.slice(limit - 1);
    return [...kept, makeOther(rest)];
  }

  function logTable(report) {
    if (!report.log.length) return '<p class="empty">No worklogs in this week.</p>';
    const byDay = new Map();
    for (const e of report.log) {
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day).push(e);
    }
    let bodies = '';
    for (const [day, items] of byDay) {
      const info = report.days.find((d) => d.date === day);
      const total = items.reduce((sum, e) => sum + e.hours, 0);
      // one <tbody> per day keeps a day's rows together across page breaks
      bodies += `<tbody class="day"><tr class="day-row"><td colspan="4">${esc(info ? info.label : day)}</td><td class="num">${esc(h2(total))}</td></tr>`;
      for (const e of items) {
        bodies += `<tr>
          <td class="mono">${esc(e.time || '')}</td>
          <td class="mono">${esc(e.key)}</td>
          <td>${esc(e.summary)}${e.comment ? `<span class="cmt">${esc(e.comment)}</span>` : ''}</td>
          <td>${esc(e.category)}</td>
          <td class="num">${esc(h2(e.hours))}</td>
        </tr>`;
      }
      bodies += '</tbody>';
    }
    return `<table>
      <thead><tr><th>Start</th><th>Ticket</th><th>Summary / comment</th><th>${esc(report.groupLabel)}</th><th class="num">Hours</th></tr></thead>
      ${bodies}
      <tbody><tr class="day-row total-row"><td colspan="4">Week total</td><td class="num">${esc(h2(report.weekTotal))}</td></tr></tbody>
    </table>`;
  }

  window.renderReport = function renderReport(data) {
    const report = { ...data.report, groupLabel: data.groupLabel };
    const colours = colourMap(report.categories);
    const workdays = report.days.filter((d) => d.isWorkday && !d.isFuture);
    const onTarget = workdays.filter((d) => d.total >= report.target).length;
    const missing = report.missingDays.reduce((s, d) => s + d.missing, 0);
    const created = new Date(data.createdAt);
    const createdText = `${created.toLocaleDateString('en-GB')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`;

    const sprintRows = foldRows(report.categories.map((c) => ({ label: clip(c.name, 22), hours: c.hours, colour: 'var(--series-1)' })), 8,
      (rest) => ({ label: `Other (${rest.length})`, hours: rest.reduce((s, r) => s + r.hours, 0), colour: OTHER }));
    const ticketRows = foldRows(report.tickets.map((t) => ({ label: t.key, sub: clip(t.summary, 24), hours: t.hours })), 10,
      (rest) => ({ label: `Other (${rest.length})`, sub: 'tickets', hours: rest.reduce((s, r) => s + r.hours, 0), colour: OTHER }));

    document.getElementById('report').innerHTML = `
      <header class="top">
        <div>
          <h1>Week ${esc(report.weekNumber)} · ${esc(report.weekLabel)}</h1>
          <div class="sub">${esc(report.me.displayName)}${report.demo ? ' · demo data' : ''}</div>
        </div>
        <div class="meta">Jira Week Hours<br>Created ${esc(createdText)}</div>
      </header>

      <div class="tiles">
        <div class="tile"><div class="label">Hours logged</div><div class="value">${esc(h2(report.weekTotal))} <small>of ${esc(report.weekTarget)}h</small></div></div>
        <div class="tile"><div class="label">Workdays on target</div><div class="value ${workdays.length && onTarget === workdays.length ? 'good' : ''}">${onTarget} <small>of ${workdays.length}</small></div></div>
        <div class="tile"><div class="label">Hours missing</div><div class="value ${missing > 0 ? 'warn' : 'good'}">${esc(h2(missing))}</div></div>
      </div>

      <section class="chart">
        <h2>Hours per day</h2>
        <p class="desc">Stacked by ${esc(report.groupLabel.toLowerCase())}; the line marks the daily target.</p>
        ${report.categories.length ? legend(report.categories, colours) : ''}
        ${dayChart(report, colours)}
      </section>

      <div class="charts-row">
        <section class="chart">
          <h2>Hours per ${esc(report.groupLabel.toLowerCase())}</h2>
          <p class="desc">Whole week</p>
          ${sprintRows.length ? barChart(sprintRows, 348, 130, `Hours per ${report.groupLabel}`) : '<p class="empty">Nothing logged.</p>'}
        </section>
        <section class="chart">
          <h2>Hours per ticket</h2>
          <p class="desc">Whole week</p>
          ${ticketRows.length ? barChart(ticketRows, 348, 150, 'Hours per ticket') : '<p class="empty">Nothing logged.</p>'}
        </section>
      </div>

      <section class="table">
        <h2>Worklog</h2>
        <p class="desc" style="margin:0;color:var(--text-secondary);font-size:11px">Every entry as recorded in Jira, with its comment.</p>
        ${logTable(report)}
      </section>

      <footer>Source: Jira worklogs of ${esc(report.me.displayName)}, read-only. Generated by Jira Week Hours.</footer>`;
  };
}());
