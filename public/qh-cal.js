/* QuiltHosting shared month-calendar component (no dependencies).
 *
 * qhRenderCalendar(container, {
 *   year, month,            // month is 1-12
 *   events,                 // [{id, title, start_at, ...}]
 *   onEventClick(ev),       // optional
 *   onMonthChange(y, m),    // optional — called after prev/next/today
 * })
 */
(function () {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  function elc(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  window.qhRenderCalendar = function (container, opts) {
    const { year, month, events = [], onEventClick, onMonthChange } = opts;
    container.replaceChildren();
    container.classList.add("qh-cal");

    // Header: ‹ Month YYYY › + Today
    const head = elc("div", "qh-cal-head");
    const nav = elc("div", "qh-cal-nav");
    const prev = elc("button", "secondary", "‹");
    prev.setAttribute("aria-label", "Previous month");
    const next = elc("button", "secondary", "›");
    next.setAttribute("aria-label", "Next month");
    const today = elc("button", "secondary", "Today");
    const title = elc("div", "qh-cal-title", MONTHS[month - 1] + " " + year);
    const go = (y, m) => onMonthChange && onMonthChange(y, m);
    prev.addEventListener("click", () => go(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1));
    next.addEventListener("click", () => go(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1));
    today.addEventListener("click", () => {
      const now = new Date();
      go(now.getFullYear(), now.getMonth() + 1);
    });
    nav.append(prev, next, today);
    head.append(title, nav);
    container.appendChild(head);

    // Events bucketed by local calendar day
    const byDay = {};
    for (const ev of events) {
      const d = new Date(ev.start_at);
      if (isNaN(d)) continue;
      if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(ev);
    }

    const grid = elc("div", "qh-cal-grid");
    for (const wd of WEEKDAYS) grid.appendChild(elc("div", "qh-cal-wd", wd));

    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const now = new Date();
    const isThisMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

    for (let i = 0; i < first.getDay(); i++) grid.appendChild(elc("div", "qh-cal-day empty"));

    for (let day = 1; day <= daysInMonth; day++) {
      const cell = elc("div", "qh-cal-day");
      if (isThisMonth && day === now.getDate()) cell.classList.add("today");
      cell.appendChild(elc("div", "qh-cal-date", String(day)));
      for (const ev of byDay[day] || []) {
        const chip = elc("button", "qh-cal-ev");
        const t = new Date(ev.start_at);
        const hh = t.getHours() % 12 || 12;
        const mm = t.getMinutes();
        const ampm = t.getHours() >= 12 ? "p" : "a";
        chip.textContent = hh + (mm ? ":" + String(mm).padStart(2, "0") : "") + ampm + " " + ev.title;
        chip.title = ev.title;
        if (onEventClick) chip.addEventListener("click", () => onEventClick(ev));
        cell.appendChild(chip);
      }
      grid.appendChild(cell);
    }
    container.appendChild(grid);

    if (!events.length) {
      container.appendChild(elc("p", "muted qh-cal-empty", "No events this month."));
    }
  };

  /* Island entry point for the server-rendered site (public/qh-site.js).
   * Emits the BEM classes public/qh-site.css styles (.qh-cal__head,
   * .qh-cal grid, .qh-cal__dow, .qh-cal__day, .qh-cal__num, .qh-cal__event)
   * — distinct from qhRenderCalendar's classes, which admin/portal/guild.html
   * style themselves.
   *
   * qhCal.render(container, events, onClick, opts?)
   *   events   [{id, title, start_at, ...}] — only this month's are drawn
   *   onClick  (ev) => void, optional
   *   opts     { year, month (1-12), onMonthChange(y, m) } — optional; the
   *            month defaults to the first event's month, else today.
   */
  window.qhCal = window.qhCal || {};
  window.qhCal.render = function (container, events, onClick, opts) {
    events = Array.isArray(events) ? events : [];
    opts = opts || {};
    let year = opts.year, month = opts.month;
    if (!year || !month) {
      const seed = events.length ? new Date(events[0].start_at) : new Date();
      const d = isNaN(seed) ? new Date() : seed;
      year = d.getFullYear(); month = d.getMonth() + 1;
    }
    container.replaceChildren();

    const head = elc("div", "qh-cal__head");
    head.appendChild(elc("h3", "qh-cal__title", MONTHS[month - 1] + " " + year));
    if (opts.onMonthChange) {
      const nav = elc("div", "qh-cal__nav");
      const mk = (label, aria, y, m) => {
        const b = elc("button", "qh-btn qh-btn--secondary", label);
        b.type = "button";
        b.setAttribute("aria-label", aria);
        b.addEventListener("click", () => opts.onMonthChange(y, m));
        return b;
      };
      const now = new Date();
      nav.append(
        mk("‹", "Previous month", month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1),
        mk("Today", "This month", now.getFullYear(), now.getMonth() + 1),
        mk("›", "Next month", month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1)
      );
      head.appendChild(nav);
    }
    container.appendChild(head);

    const byDay = {};
    for (const ev of events) {
      const d = new Date(ev.start_at);
      if (isNaN(d) || d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
      (byDay[d.getDate()] = byDay[d.getDate()] || []).push(ev);
    }

    const grid = elc("div", "qh-cal");
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-label", MONTHS[month - 1] + " " + year);
    for (const wd of WEEKDAYS) grid.appendChild(elc("div", "qh-cal__dow", wd));
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    const prevDays = new Date(year, month - 1, 0).getDate();
    const now = new Date();
    const isThisMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
    for (let i = first.getDay() - 1; i >= 0; i--) {
      const other = elc("div", "qh-cal__day qh-cal__day--other");
      other.appendChild(elc("span", "qh-cal__num", String(prevDays - i)));
      grid.appendChild(other);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const cell = elc("div", "qh-cal__day");
      if (isThisMonth && day === now.getDate()) cell.classList.add("qh-cal__day--today");
      cell.appendChild(elc("span", "qh-cal__num", String(day)));
      for (const ev of byDay[day] || []) {
        const t = new Date(ev.start_at);
        const hh = t.getHours() % 12 || 12;
        const mm = t.getMinutes();
        const label = hh + (mm ? ":" + String(mm).padStart(2, "0") : "") +
          (t.getHours() >= 12 ? "p" : "a") + " " + ev.title;
        const chip = elc(onClick ? "button" : "span", "qh-cal__event", label);
        if (onClick) { chip.type = "button"; chip.addEventListener("click", () => onClick(ev)); }
        chip.title = ev.title;
        cell.appendChild(chip);
      }
      grid.appendChild(cell);
    }
    const tail = (7 - ((first.getDay() + daysInMonth) % 7)) % 7;
    for (let i = 1; i <= tail; i++) {
      const other = elc("div", "qh-cal__day qh-cal__day--other");
      other.appendChild(elc("span", "qh-cal__num", String(i)));
      grid.appendChild(other);
    }
    container.appendChild(grid);
    if (!Object.keys(byDay).length) {
      container.appendChild(elc("p", "qh-empty", "No events this month."));
    }
  };
})();
