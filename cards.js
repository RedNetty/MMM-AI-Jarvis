/* MagicMirror² Module: MMM-AI-Jarvis – rich cards
 *
 * The animated cards IRIS shows for data: weather, markets, facts, news,
 * answers, definitions, world clocks, countdowns, sunrise/sunset and the
 * morning briefing. Loaded by the module through getScripts().
 *
 * Motion is quick and purposeful: numbers count up, charts draw themselves,
 * lists cascade in, weather icons move like the weather. Everything is CSS
 * transforms/opacity or SVG stroke animation, so it stays smooth on a Pi.
 */
/* global window, document */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  // ─── DOM helpers ─────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    for (const c of children) node.appendChild(c);
    return node;
  }

  function head(label, meta) {
    const row = el("div", "jv-card-head");
    const l = el("span", "jv-card-label", label);
    const m = el("span", "jv-card-meta", meta);
    row.append(l, m);
    return { row, label: l, meta: m };
  }

  /** Stagger children's entrance: each gets a growing animation delay. */
  function cascade(nodes, stepMs = 70, startMs = 120) {
    nodes.forEach((n, i) => {
      n.classList.add("jv-rise");
      n.style.animationDelay = `${startMs + i * stepMs}ms`;
    });
  }

  // ─── Motion ──────────────────────────────────────────────────────────

  const easeOut = (t) => 1 - (1 - t) ** 3;

  /**
   * Count a number up (or down) to its new value. Keeps the text's own
   * prefix, suffix and decimals ("€89.17", "65°", "1,024").
   */
  function countUp(node, to, { from = 0, ms = 900, text = null } = {}) {
    const target = text ?? String(node.textContent);
    const m = /^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/.exec(target);
    if (!m || !Number.isFinite(to)) {
      node.textContent = target;
      return;
    }
    const [, prefix, digits, suffix] = m;
    const decimals = (digits.split(".")[1] ?? "").length;
    const grouped = digits.includes(",");
    const fmt = (v) => {
      const fixed = Math.abs(v).toFixed(decimals);
      const [i, f] = fixed.split(".");
      const int = grouped ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : i;
      return `${v < 0 ? "-" : ""}${int}${f ? `.${f}` : ""}`;
    };
    cancelAnimationFrame(node._countRaf);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      node.textContent = `${prefix}${fmt(from + (to - from) * easeOut(t))}${suffix}`;
      if (t < 1) node._countRaf = requestAnimationFrame(step);
      else node.textContent = target;
    };
    node._countRaf = requestAnimationFrame(step);
  }

  /** A smooth path through points (Catmull-Rom → cubic Bézier). */
  function smoothPath(points) {
    if (points.length < 2) return "";
    let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  let gradientId = 0;

  /**
   * A chart line that draws itself, with a fading area underneath.
   * @param {number[]} values
   * @param {{ width?: number, height?: number, color?: string, pad?: number, baseline?: number|null }} [o]
   */
  function sparkline(values, { width = 300, height = 64, color = "#fff", pad = 4, baseline = null } = {}) {
    const vals = values.filter(Number.isFinite);
    const box = svg("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "jv-spark" });
    if (vals.length < 2) return box;
    const lo = Math.min(...vals, baseline ?? Infinity);
    const hi = Math.max(...vals, baseline ?? -Infinity);
    const span = hi - lo || 1;
    const x = (i) => pad + (i / (vals.length - 1)) * (width - pad * 2);
    const y = (v) => pad + (1 - (v - lo) / span) * (height - pad * 2);
    const pts = vals.map((v, i) => [x(i), y(v)]);
    const line = smoothPath(pts);
    const id = `jvg${++gradientId}`;
    box.append(
      svg("defs", {}, [
        svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, [
          svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.32 }),
          svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }),
        ]),
      ]),
    );
    if (baseline !== null) {
      box.append(svg("line", { x1: pad, x2: width - pad, y1: y(baseline), y2: y(baseline), class: "jv-spark-base" }));
    }
    box.append(
      svg("path", { d: `${line} L${pts.at(-1)[0]},${height} L${pts[0][0]},${height} Z`, fill: `url(#${id})`, class: "jv-spark-area" }),
      svg("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1, class: "jv-spark-line" }),
      svg("circle", { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 3.2, fill: color, class: "jv-spark-dot" }),
    );
    return box;
  }

  // ─── Weather icons ───────────────────────────────────────────────────

  /** "sun" | "moon" | "partly" | "partly-night" | "cloud" | "rain" | "snow" | "storm" | "fog" */
  function weatherKind(condition, isDay = true) {
    const c = String(condition ?? "").toLowerCase();
    if (/thunder|storm|lightning/.test(c)) return "storm";
    if (/snow|sleet|flurr|ice|hail/.test(c)) return "snow";
    if (/rain|drizzle|shower/.test(c)) return "rain";
    if (/fog|mist|haze|smoke/.test(c)) return "fog";
    if (/partly|mainly|few|scattered|mostly clear/.test(c)) return isDay === false ? "partly-night" : "partly";
    if (/overcast|cloud/.test(c)) return "cloud";
    return isDay === false ? "moon" : "sun";
  }

  /** An animated weather icon made of a few shapes. */
  function weatherIcon(condition, isDay) {
    const kind = weatherKind(condition, isDay);
    const icon = el("div", `jv-wx jv-wx--${kind}`);
    const sun = () => {
      const s = el("span", "jv-wx-sun");
      const rays = el("span", "jv-wx-rays");
      for (let i = 0; i < 8; i++) rays.appendChild(el("i"));
      s.appendChild(rays);
      return s;
    };
    const cloud = (extra = "") => el("span", `jv-wx-cloud ${extra}`);
    switch (kind) {
      case "sun":
        icon.append(sun());
        break;
      case "moon":
        icon.append(el("span", "jv-wx-moon"), el("span", "jv-wx-star jv-wx-star--1"), el("span", "jv-wx-star jv-wx-star--2"));
        break;
      case "partly":
        icon.append(sun(), cloud("is-front"));
        break;
      case "partly-night":
        icon.append(el("span", "jv-wx-moon is-small"), cloud("is-front"));
        break;
      case "cloud":
        icon.append(cloud("is-back"), cloud("is-front"));
        break;
      case "rain":
      case "snow": {
        icon.append(cloud("is-front"));
        const fall = el("span", "jv-wx-fall");
        for (let i = 0; i < (kind === "rain" ? 5 : 6); i++) {
          const p = el("i", kind === "rain" ? "jv-wx-drop" : "jv-wx-flake");
          p.style.left = `${14 + i * 15}%`;
          p.style.animationDelay = `${(i * 0.37) % 1.1}s`;
          fall.appendChild(p);
        }
        icon.append(fall);
        break;
      }
      case "storm": {
        icon.append(cloud("is-front is-dark"));
        const bolt = svg("svg", { viewBox: "0 0 24 32", class: "jv-wx-bolt" }, [svg("polygon", { points: "13,0 3,18 11,18 8,32 21,11 13,11 17,0" })]);
        icon.append(bolt);
        break;
      }
      case "fog":
        for (let i = 0; i < 3; i++) icon.append(el("span", `jv-wx-mist jv-wx-mist--${i + 1}`));
        break;
      default:
        break;
    }
    return icon;
  }

  // ─── Formatting ──────────────────────────────────────────────────────

  function timeLabel(iso, ctx, withMinutes = false) {
    const d = new Date(iso);
    const opts = withMinutes ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" };
    return d.toLocaleTimeString(ctx.locale, opts).replace(/\s?([AP])M$/i, (m, a) => (withMinutes ? ` ${a}M` : a.toLowerCase()));
  }

  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const min = Math.round(ms / 60000);
    if (min < 60) return `${Math.max(1, min)}m`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  }

  function money(v, currency = "USD", type = "") {
    if (!Number.isFinite(v)) return "–";
    const digits = v >= 10000 ? 0 : v >= 1 ? 2 : 4;
    if (type === "INDEX") return new Intl.NumberFormat("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    } catch {
      return v.toFixed(digits);
    }
  }

  const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);

  // ─── Cards ───────────────────────────────────────────────────────────

  const CARDS = {};

  // Weather: animated icon, temperature counting up, an hourly chart that draws itself.
  CARDS.weather = {
    build(e) {
      e.head = head("Weather", "");
      e.body = el("div", "jv-wxcard");
      e.el.append(e.head.row, e.body);
    },
    update(e, d, ctx) {
      e.head.label.textContent = d.label ? `Weather · ${d.label}` : "Weather";
      e.head.meta.textContent = d.location || "";
      const scope = d.scope ?? {};
      const cur = d.current;
      const temp = cur ? cur.temperature : scope.high;
      const condition = cur?.condition || scope.condition || "";
      const isDay = cur?.isDay ?? (d.label && /tonight|evening/i.test(d.label) ? false : true);

      const top = el("div", "jv-wx-top");
      top.append(weatherIcon(condition, isDay));
      const main = el("div", "jv-wx-main");
      const big = el("div", "jv-wx-temp", `${round(temp) ?? "–"}°`);
      main.append(big, el("div", "jv-wx-cond", condition ? condition[0].toUpperCase() + condition.slice(1) : ""));
      const facts = [];
      if (cur && cur.feelsLike !== null && Math.abs(cur.feelsLike - cur.temperature) >= 2) facts.push(`Feels ${round(cur.feelsLike)}°`);
      if (scope.high !== null && scope.high !== undefined) facts.push(`H ${round(scope.high)}°  L ${round(scope.low)}°`);
      if (scope.precipChance !== null && scope.precipChance !== undefined) facts.push(`${round(scope.precipChance)}% rain`);
      main.append(el("div", "jv-wx-facts", facts.join("  ·  ")));
      top.append(main);
      e.body.replaceChildren(top);
      countUp(big, round(temp), { from: round(temp) - 12, ms: 800 });

      const hours = (d.hours ?? []).filter((h) => Number.isFinite(h.temperature));
      if (hours.length >= 3) e.body.append(hourlyChart(hours, ctx));
    },
  };

  function hourlyChart(hours, ctx) {
    const wrap = el("div", "jv-hourly");
    const W = 300;
    const H = 58;
    const temps = hours.map((h) => h.temperature);
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);
    const span = hi - lo || 1;
    const x = (i) => 10 + (i / (hours.length - 1)) * (W - 20);
    const y = (v) => 14 + (1 - (v - lo) / span) * (H - 26);
    const pts = temps.map((v, i) => [x(i), y(v)]);
    const chart = svg("svg", { viewBox: `0 0 ${W} ${H + 18}`, class: "jv-hourly-svg" });

    // Rain chance as bars rising from the bottom.
    hours.forEach((h, i) => {
      const p = Math.max(0, Math.min(100, h.precipChance ?? 0));
      if (p < 5) return;
      const bh = (p / 100) * 18;
      const bar = svg("rect", { x: x(i) - 4, y: H + 18 - bh, width: 8, height: bh, rx: 2, class: "jv-hourly-rain" });
      bar.style.animationDelay = `${300 + i * 40}ms`;
      chart.appendChild(bar);
    });
    chart.append(svg("path", { d: smoothPath(pts), fill: "none", pathLength: 1, class: "jv-hourly-line" }));
    // Temperatures at a few points, so the chart reads at a glance.
    const every = hours.length > 8 ? 3 : 2;
    hours.forEach((h, i) => {
      if (i % every !== 0 && i !== hours.length - 1) return;
      const dot = svg("circle", { cx: pts[i][0], cy: pts[i][1], r: 2.4, class: "jv-hourly-dot" });
      const label = svg("text", { x: pts[i][0], y: pts[i][1] - 6, class: "jv-hourly-temp" });
      label.textContent = `${Math.round(h.temperature)}°`;
      dot.style.animationDelay = label.style.animationDelay = `${500 + i * 45}ms`;
      chart.append(dot, label);
    });
    wrap.appendChild(chart);
    const axis = el("div", "jv-hourly-axis");
    hours.forEach((h, i) => {
      if (i % every === 0 || i === hours.length - 1) {
        const t = el("span", "", i === 0 && !ctx.tomorrow ? "Now" : timeLabel(h.time, ctx));
        t.style.left = `${(x(i) / W) * 100}%`;
        axis.appendChild(t);
      }
    });
    wrap.appendChild(axis);
    return wrap;
  }

  // Markets: price counting up, change pill, a chart that draws itself.
  CARDS.market = {
    build(e) {
      e.head = head("Markets", "");
      e.body = el("div", "jv-market");
      e.el.append(e.head.row, e.body);
      e.prices = new Map();
    },
    update(e, d) {
      const quotes = d.quotes ?? [];
      const single = quotes.length === 1;
      const q0 = quotes[0] ?? {};
      e.head.label.textContent = single ? (q0.type === "CRYPTOCURRENCY" ? "Crypto" : q0.type === "INDEX" ? "Index" : "Stock") : "Markets";
      e.head.meta.textContent = { week: "This week", month: "This month", year: "This year" }[q0.period] ?? (q0.marketState === "closed" ? "At close" : "Today");
      e.el.classList.toggle("is-single", single);
      const rows = quotes.map((q) => {
        const up = (q.changePercent ?? 0) >= 0;
        const row = el("div", `jv-quote ${up ? "is-up" : "is-down"}`);
        const name = el("div", "jv-quote-name");
        name.append(el("span", "", q.name), el("small", "", q.symbol.replace(/^\^/, "").replace(/-USD$/, "")));
        const price = el("div", "jv-quote-price", money(q.price, q.currency, q.type));
        const pct = q.changePercent;
        const pill = el("div", "jv-quote-pill", Number.isFinite(pct) ? `${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%` : "");
        const chart = sparkline(q.series.map((p) => p[1]), {
          width: single ? 300 : 120,
          height: single ? 74 : 30,
          color: up ? "#4ade80" : "#ff6b7a",
          baseline: q.period === "day" && Number.isFinite(q.price - q.change) ? q.price - q.change : null,
        });
        row.append(name, chart, price, pill);
        const before = e.prices.get(q.symbol);
        countUp(price, q.price, { from: before ?? q.price * (up ? 0.985 : 1.015), ms: before === undefined ? 1000 : 600, text: price.textContent });
        e.prices.set(q.symbol, q.price);
        return row;
      });
      e.body.replaceChildren(...rows);
      if (!single) cascade(rows, 90);
    },
  };

  // Facts: picture with a slow zoom, title, a few sentences.
  CARDS.knowledge = {
    build(e) {
      e.head = head("Iris knows", "Wikipedia");
      e.body = el("div", "jv-know");
      e.el.append(e.head.row, e.body);
    },
    update(e, d) {
      const parts = [];
      if (d.image) {
        const frame = el("div", "jv-know-img");
        const img = el("img");
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        img.src = d.image;
        img.onerror = () => frame.remove();
        frame.appendChild(img);
        parts.push(frame);
      }
      const text = el("div", "jv-know-text");
      const title = el("h3", "jv-know-title", d.title);
      const desc = el("div", "jv-know-desc", d.description || "");
      const body = el("p", "jv-know-extract", d.extract);
      text.append(title, desc, body);
      cascade([title, desc, body], 110, 200);
      parts.push(text);
      e.body.replaceChildren(...parts);
    },
  };

  // News: numbered headlines cascading in; a spotlight moves down the list.
  CARDS.news = {
    build(e) {
      e.head = head("News", "");
      e.list = el("ol", "jv-news");
      e.el.append(e.head.row, e.list);
    },
    update(e, d) {
      e.head.label.textContent = d.title || "News";
      e.head.meta.textContent = d.items?.length ? `${d.items.length} stories` : "";
      const items = (d.items ?? []).slice(0, 5);
      const cycle = items.length * 5;
      const rows = items.map((it, i) => {
        const li = el("li", "jv-news-item");
        li.append(el("span", "jv-news-num", String(i + 1).padStart(2, "0")));
        const text = el("div", "jv-news-text");
        text.append(el("div", "jv-news-title", it.title), el("div", "jv-news-meta", [it.source, it.published ? ago(it.published) : ""].filter(Boolean).join(" · ")));
        li.append(text);
        li.style.setProperty("--spot-cycle", `${cycle}s`);
        li.style.setProperty("--spot-delay", `${1.2 + i * 5}s`);
        return li;
      });
      e.list.replaceChildren(...rows);
      cascade(rows, 110, 150);
    },
  };

  // A big number that counts up: maths, conversions, exchange rates.
  CARDS.answer = {
    build(e) {
      e.head = head("Answer", "");
      e.value = el("div", "jv-answer-value");
      e.caption = el("div", "jv-answer-caption");
      e.el.append(e.head.row, e.value, e.caption);
    },
    update(e, d) {
      e.head.label.textContent = d.label || "Answer";
      e.value.textContent = d.display;
      e.caption.textContent = d.caption || "";
      if (Number.isFinite(d.value)) countUp(e.value, d.value, { from: 0, ms: 900, text: d.display });
      e.caption.classList.remove("jv-rise");
      cascade([e.caption], 0, 350);
    },
  };

  // Definitions.
  CARDS.definition = {
    build(e) {
      e.head = head("Definition", "");
      e.body = el("div", "jv-define");
      e.el.append(e.head.row, e.body);
    },
    update(e, d) {
      const word = el("h3", "jv-define-word", d.word);
      const phon = el("div", "jv-define-phonetic", d.phonetic || "");
      const list = el("ol", "jv-define-list");
      for (const m of d.meanings ?? []) {
        const li = el("li");
        li.append(el("span", "jv-define-pos", m.partOfSpeech), el("span", "jv-define-text", m.definition));
        if (m.example) li.append(el("span", "jv-define-example", `“${m.example}”`));
        list.appendChild(li);
      }
      e.body.replaceChildren(word, phon, list);
      cascade([phon, ...list.children], 100, 150);
    },
  };

  // World clock: an analog face with a sweeping second hand.
  CARDS.clock = {
    ticks: true,
    build(e) {
      e.head = head("World clock", "");
      const body = el("div", "jv-wclock");
      const face = svg("svg", { viewBox: "-50 -50 100 100", class: "jv-wclock-face" });
      face.appendChild(svg("circle", { r: 47, class: "jv-wclock-rim" }));
      for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        const a = (i / 60) * Math.PI * 2;
        face.appendChild(svg("line", { x1: Math.sin(a) * (major ? 38 : 42), y1: -Math.cos(a) * (major ? 38 : 42), x2: Math.sin(a) * 45, y2: -Math.cos(a) * 45, class: major ? "jv-wclock-major" : "jv-wclock-minor" }));
      }
      e.hour = svg("line", { x1: 0, y1: 6, x2: 0, y2: -24, class: "jv-wclock-hour" });
      e.minute = svg("line", { x1: 0, y1: 8, x2: 0, y2: -36, class: "jv-wclock-minute" });
      e.second = svg("line", { x1: 0, y1: 10, x2: 0, y2: -40, class: "jv-wclock-second" });
      face.append(e.hour, e.minute, e.second, svg("circle", { r: 2.6, class: "jv-wclock-pin" }));
      const info = el("div", "jv-wclock-info");
      e.city = el("div", "jv-wclock-city");
      e.digital = el("div", "jv-wclock-time");
      e.day = el("div", "jv-wclock-day");
      info.append(e.city, e.digital, e.day);
      body.append(face, info);
      e.el.append(e.head.row, body);
      // Hands swing in from 12 o'clock the first time.
      e.el.classList.add("is-arriving");
      setTimeout(() => e.el.classList.remove("is-arriving"), 900);
    },
    update(e, d, ctx) {
      e.city.textContent = d.city;
      e.head.meta.textContent = d.offset || "";
      CARDS.clock.tick(e, d, ctx);
    },
    tick(e, d, ctx) {
      const now = new Date();
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: d.zone, hour: "numeric", minute: "numeric", second: "numeric", hour12: false, weekday: "long" }).formatToParts(now).map((p) => [p.type, p.value]));
      const h = Number(parts.hour) % 24;
      const m = Number(parts.minute);
      const s = Number(parts.second) + now.getMilliseconds() / 1000;
      e.hour.setAttribute("transform", `rotate(${(h % 12) * 30 + m * 0.5})`);
      e.minute.setAttribute("transform", `rotate(${m * 6 + s * 0.1})`);
      e.second.setAttribute("transform", `rotate(${s * 6})`);
      e.digital.textContent = now.toLocaleTimeString(ctx.locale, { timeZone: d.zone, hour: "numeric", minute: "2-digit", hour12: d.hour12 !== false });
      e.day.textContent = parts.weekday;
    },
  };

  // Countdown: days count up to the real number; same-day targets tick live.
  CARDS.countdown = {
    ticks: true,
    build(e) {
      e.head = head("Countdown", "");
      e.value = el("div", "jv-count-value");
      e.unit = el("div", "jv-count-unit");
      e.el.append(e.head.row, e.value, e.unit);
    },
    update(e, d, ctx) {
      const target = new Date(d.target);
      e.head.meta.textContent = target.toLocaleDateString(ctx.locale, { weekday: "short", month: "short", day: "numeric" });
      if (d.timeOfDay) {
        CARDS.countdown.tick(e, d);
        e.unit.textContent = `until ${d.label}`;
      } else {
        const days = d.days ?? Math.max(0, Math.ceil((target - Date.now()) / 86400000));
        e.value.textContent = String(days);
        countUp(e.value, days, { from: 0, ms: Math.min(1400, 400 + days * 6) });
        e.unit.textContent = days === 0 ? `${d.label} is today` : `${days === 1 ? "day" : "days"} until ${d.label}`;
      }
      cascade([e.unit], 0, 400);
    },
    tick(e, d) {
      if (!d.timeOfDay) return;
      const left = Math.max(0, new Date(d.target) - Date.now());
      const s = Math.floor(left / 1000);
      const pad = (n) => String(n).padStart(2, "0");
      e.value.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    },
  };

  // Sunrise and sunset: the sun travels along its arc to where it is now.
  CARDS.sun = {
    build(e) {
      e.head = head("Sun", "");
      e.body = el("div", "jv-sun");
      e.el.append(e.head.row, e.body);
    },
    update(e, d, ctx) {
      const rise = new Date(d.sunrise);
      const set = new Date(d.sunset);
      const now = Date.now();
      e.head.meta.textContent = d.label || "";
      const frac = Math.max(0, Math.min(1, (now - rise) / (set - rise)));
      const up = d.label !== "Tomorrow" && now >= rise && now <= set;
      const W = 240;
      const R = 100;
      const cx = W / 2;
      const cy = 112;
      const arc = `M${cx - R},${cy} A${R},${R} 0 0 1 ${cx + R},${cy}`;
      const chart = svg("svg", { viewBox: `0 0 ${W} 124`, class: "jv-sun-svg" });
      chart.append(
        svg("line", { x1: 4, x2: W - 4, y1: cy, y2: cy, class: "jv-sun-horizon" }),
        svg("path", { d: arc, class: "jv-sun-track", pathLength: 1 }),
      );
      const done = svg("path", { d: arc, class: "jv-sun-done", pathLength: 1 });
      done.style.setProperty("--frac", String(up ? frac : d.label === "Tomorrow" ? 0 : now > set ? 1 : 0));
      chart.appendChild(done);
      const angle = Math.PI * (1 - (up ? frac : now > set && d.label !== "Tomorrow" ? 1 : 0));
      const sun = svg("circle", { cx: cx + R * Math.cos(angle), cy: cy - R * Math.sin(angle), r: up ? 7 : 4, class: `jv-sun-dot${up ? "" : " is-down"}` });
      chart.appendChild(sun);
      const labels = el("div", "jv-sun-labels");
      const daylight = Math.round((set - rise) / 60000);
      labels.append(
        el("span", "", `↑ ${timeLabel(d.sunrise, ctx, true)}`),
        el("span", "jv-sun-length", `${Math.floor(daylight / 60)}h ${daylight % 60}m of daylight`),
        el("span", "", `${timeLabel(d.sunset, ctx, true)} ↓`),
      );
      e.body.replaceChildren(chart, labels);
      cascade([labels], 0, 600);
    },
  };

  // Morning briefing: greeting, date and a few lines with icons.
  const LINE_ICONS = {
    weather: "M12 4v2M12 18v2M4 12H2M22 12h-2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    outfit: "M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3z",
    sports: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9",
    news: "M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M7 9h7M7 12h7M7 15h4",
    timer: "M12 7v5l3 2M9 2h6M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  };
  CARDS.briefing = {
    build(e) {
      e.head = head("Briefing", "");
      e.title = el("h3", "jv-brief-title");
      e.list = el("ul", "jv-brief");
      e.el.append(e.head.row, e.title, e.list);
    },
    update(e, d) {
      e.head.meta.textContent = d.date || "";
      e.title.textContent = d.greeting || "";
      const rows = (d.lines ?? []).map((line) => {
        const li = el("li");
        const icon = svg("svg", { viewBox: "0 0 24 24", class: `jv-brief-icon is-${line.icon}` }, [svg("path", { d: LINE_ICONS[line.icon] ?? LINE_ICONS.news })]);
        li.append(icon, el("span", "", line.text));
        return li;
      });
      e.list.replaceChildren(...rows);
      cascade([e.title, ...rows], 140, 100);
    },
  };

  window.IrisCards = {
    has: (type) => Boolean(CARDS[type]),
    ticks: (type) => Boolean(CARDS[type]?.ticks),
    build: (type, entry, ctx) => CARDS[type].build(entry, ctx),
    update: (type, entry, data, ctx) => CARDS[type].update(entry, data, ctx),
    tick: (type, entry, data, ctx) => CARDS[type].tick?.(entry, data, ctx),
    // For tests and the UI gallery.
    weatherKind,
    countUp,
  };
})();
