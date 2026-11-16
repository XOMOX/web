/* Terminbuchung xomox.swiss (US #209, #216) – öffentliche API des Dashboards (Diemi), Konzept:
   Companies/wiens.hamburg/Backoffice/Server/dashboard-project/TERMINBUCHUNG.md (Feature #202).
   Vorbild: Companies/wiens.hamburg/Website/termin.js (US #206/#208) – gleicher Ablauf und gleiche Felder,
   Texte aus BOOKING_UI in pelicanconf.py (JSON in #bk-text), Element-IDs mit Präfix bk-.
   - Formular-Konfiguration: POST {api}{key}/config {code?} – Arten, Längen, Horizont, Personen, Adresse.
   - Freie Termine: POST {api}{key}/slots {kind, minutes, from, to, code?, host?}.
   - Buchen POST {api}{key}/book (US #206), Anfragen POST {api}{key}/requests (US #207).
   - Ohne Schlüssel, bei 404 (Buchung aus), ohne buchbare Termin-Art oder wenn die API beim ersten Laden nicht
     antwortet, bleibt der Weg per E-Mail stehen.
   - Ein Code kommt nur über den Link (#code=… empfohlen, ?code=… landet im Server-Log); die Seite erwähnt ihn
     nirgends und entfernt ihn sofort aus der Adresszeile. Mit gültigem Code: Personen-Auswahl, Vor Ort, längere
     Termine und freie Dauer in Stunden, Adresse vorbelegt, Termin sofort fest.
   - #vorschau zeigt die Seite mit simulierter API (Beispieltermine, Beispiel-Code K7QM-4R2X-9HTB mit zwei
     Personen) – es wird nichts gesendet. */
(function () {
    'use strict';

    var root = document.getElementById('bk');
    if (!root) return;
    var T = JSON.parse(document.getElementById('bk-text').textContent);
    var KEY = root.getAttribute('data-key');
    var API = root.getAttribute('data-api') + encodeURIComponent(KEY);
    var EMAIL = root.getAttribute('data-email');
    var TZ = 'Europe/Zurich';  // die API rechnet in Europe/Berlin – gleiche Uhrzeit
    var NO_CODE_DURATIONS = [15, 30, 45];
    var CODE_DURATIONS = [30, 45, 60, 90, 120];

    function $(id) { return document.getElementById(id); }
    function fmt(text, values) {
        return text.replace(/\{(\w+)\}/g, function (all, name) { return name in values ? values[name] : all; });
    }
    function num(n) { return String(n).replace('.', T.decimal); }

    // ---------- Link-Parameter: #vorschau, #code=…, ?code=… ----------
    var preview = false;
    function readLink() {
        var hash = new URLSearchParams(location.hash.slice(1));
        var query = new URLSearchParams(location.search);
        preview = preview || hash.has('vorschau');
        var code = hash.get('code') || query.get('code') || '';
        if (code || query.has('code')) {
            // Code sofort aus der Adresszeile – nicht in Verlauf, Lesezeichen oder geteilte Links
            history.replaceState(null, '', location.pathname + (preview ? '#vorschau' : ''));
        }
        return code.trim().slice(0, 64);
    }

    // ---------- Datum in Zürcher Zeit ----------
    var ymd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    function today() {
        var p = {};
        ymd.formatToParts(new Date()).forEach(function (part) { p[part.type] = part.value; });
        return p.year + '-' + p.month + '-' + p.day;
    }
    function addDays(day, n) {
        var d = new Date(day + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    function longDay(day) {
        return new Intl.DateTimeFormat(T.locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
            .format(new Date(day + 'T12:00:00Z'));
    }
    function hhmm(iso) { return iso.slice(11, 16); }  // Ortszeit steht in der Antwort der API

    // ---------- Zustand ----------
    var st = {
        kind: 'teams', minutes: 30, code: '', withCode: false, month: '', day: null, slot: null,
        busy: false, loaded: false, cache: null,
        // aus /config bzw. der Slot-Antwort (für die gewählte Person)
        kinds: ['teams'], maxMinutes: 45, defaults: { teams: 30, onsite: 30 }, horizon: 60,
        hosts: [], host: null, address: '', applyDefault: false,
        customMinutes: false  // Länge aus dem Feld „Andere Dauer“ (nur mit Code)
    };

    // ---------- API ----------
    function post(path, body) {
        if (!st.code) { delete body.code; delete body.host; }
        if (!body.host) delete body.host;
        if (preview) return mock(path, body);
        return fetch(API + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            credentials: 'omit', referrerPolicy: 'no-referrer'
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                return { status: res.status, data: data };
            });
        });
    }

    // ---------- Darstellung ----------
    function el(tag, attrs, text) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function notice(target, text, kind) {
        target.replaceChildren(el('p', { 'class': 'bk-notice' + (kind ? ' bk-' + kind : '') }, text));
    }
    function status(text) { $('bk-status').textContent = text; }
    function showFallback() {
        root.hidden = true;
        $('bk-fallback').hidden = false;
    }
    function durationLabel(m) {
        return m < 60 ? fmt(T.min_short, { n: m }) : fmt(T.hours_short, { n: num(m / 60) });
    }
    function kindLabel(k) { return T[k] || k; }
    // Gruppe nur neu bauen, wenn sich die Optionen ändern – sonst nur die Auswahl setzen (Fokus bleibt erhalten)
    function fillGroup(box, name, options, selected) {
        var sig = JSON.stringify(options);
        if (box.getAttribute('data-sig') === sig) {
            box.querySelectorAll('input').forEach(function (i) { i.checked = i.value === String(selected); });
            return;
        }
        box.setAttribute('data-sig', sig);
        box.replaceChildren();
        options.forEach(function (o) {
            var label = el('label', { 'class': 'bk-choice' });
            var input = el('input', { type: 'radio', name: name, value: String(o[0]) });
            input.checked = String(o[0]) === String(selected);
            label.append(input, el('span', {}, o[1]));
            box.append(label);
        });
    }
    function renderKinds() {
        if (st.kinds.indexOf(st.kind) < 0) st.kind = st.kinds[0];
        // Nur eine Art (z. B. nur Teams): keine Auswahl anzeigen – die Art steht in „Ihre Auswahl“
        $('bk-kind-set').hidden = st.kinds.length < 2;
        fillGroup($('bk-kinds'), 'bk-kind', st.kinds.map(function (k) { return [k, kindLabel(k)]; }), st.kind);
        setKindFields();
        step1Title();
    }
    function renderHosts() {
        // Nur eine Person: keine Auswahl anzeigen – der Name steht in „Ihre Auswahl“
        $('bk-host-set').hidden = st.hosts.length < 2;
        fillGroup($('bk-hosts'), 'bk-host', st.hosts.map(function (h) { return [h.id, h.name]; }), st.host);
        step1Title();
    }
    function step1Title() {
        $('bk-step1-text').textContent = st.kinds.length > 1 ? T.step1_kind
            : st.hosts.length > 1 ? T.step1_host : T.step1_duration;
    }
    function maxHours() { return Math.floor(Math.min(st.maxMinutes, 600) / 30) / 2; }
    function durationOptions() {
        return (st.withCode ? CODE_DURATIONS : NO_CODE_DURATIONS).filter(function (m) { return m <= st.maxMinutes; });
    }
    function renderDurations() {
        var opts = durationOptions();
        var custom = st.withCode && st.customMinutes && st.minutes <= st.maxMinutes;
        if (!custom) st.customMinutes = false;
        if (!custom && opts.indexOf(st.minutes) < 0) {
            if (st.minutes >= 15 && st.minutes <= st.maxMinutes) { opts.push(st.minutes); opts.sort(function (a, b) { return a - b; }); }
            else st.minutes = opts.indexOf(30) >= 0 ? 30 : opts[0];
        }
        fillGroup($('bk-durations'), 'bk-minutes', opts.map(function (m) { return [m, durationLabel(m)]; }), custom ? null : st.minutes);
        // Freie Länge nur mit Code – ohne Code bleibt es bei höchstens 45 Minuten
        var hours = $('bk-hours');
        $('bk-custom-duration').hidden = !st.withCode;
        $('bk-hours-hint').textContent = fmt(T.hours_hint, { min: num(0.5), max: num(maxHours()) });
        hours.value = custom ? num(st.minutes / 60) : '';
        hours.classList.toggle('bk-active', custom);
    }
    // Eingabe auf halbe Stunden runden und begrenzen; leer oder ungültig = zurück zu den Knöpfen
    function applyHours() {
        var h = parseFloat(String($('bk-hours').value).replace(',', '.'));
        if (!(h > 0)) {
            if (!st.customMinutes) return renderDurations();  // Unsinn im Feld wieder leeren
            st.customMinutes = false;
            st.minutes = 30;
        } else {
            h = Math.min(Math.max(Math.round(h * 2) / 2, 0.5), maxHours());
            st.customMinutes = true;
            st.minutes = Math.round(h * 60);
        }
        renderDurations();
        resetSelection();
    }
    function hostName() {
        for (var i = 0; i < st.hosts.length; i++) if (st.hosts[i].id === st.host) return st.hosts[i].name;
        return '';
    }
    function slotText() {
        if (!st.slot) return T.not_chosen;
        return longDay(st.slot.start.slice(0, 10)) + ', ' +
            fmt(T.clock, { t: hhmm(st.slot.start) + '–' + hhmm(st.slot.end) });
    }
    function renderSummary() {
        var name = hostName();
        $('bk-sum-host-row').hidden = !name;
        $('bk-sum-host').textContent = name;
        $('bk-sum-kind').textContent = kindLabel(st.kind);
        $('bk-sum-dur').textContent = st.minutes < 60 ? fmt(T.minutes, { n: st.minutes })
            : st.minutes === 60 ? T.hour_one : fmt(T.hours, { n: num(st.minutes / 60) });
        $('bk-sum-slot').textContent = slotText();
        $('bk-sum-mode').textContent = st.withCode ? T.confirmed : T.tentative;
    }
    // Adresse vorbelegen – aber nie überschreiben, was der Besucher selbst eingetragen hat
    var addressEdited = { 'bk-addr': false, 'bk-r-addr': false };
    function prefillAddress(address) {
        ['bk-addr', 'bk-r-addr'].forEach(function (id) {
            if (!addressEdited[id]) $(id).value = address || '';
        });
        st.address = address || '';
    }
    function errorText(code) {
        if (code === 429) return T.err_429;
        if (code === 409) return T.err_409;
        if (code === 422) return T.err_422;
        return fmt(T.err_other, { email: EMAIL });
    }

    // Antwort von /config oder /slots: was der Besucher (für die gewählte Person) buchen darf
    function applySettings(d) {
        var hosts = Array.isArray(d.hosts) ? d.hosts.filter(function (h) { return h && h.id && h.name; }) : [];
        st.withCode = hosts.length > 0;
        if (!st.withCode) st.code = '';  // ungültiger Code: wie ohne Code, nicht weiter mitschicken
        st.hosts = hosts;
        st.host = st.withCode ? (d.host || hosts[0].id) : null;
        // Nur Arten, die die Seite kennt – eine neue Art der API erscheint nicht als leerer Knopf
        st.kinds = (d.kinds || []).filter(function (k) { return k === 'teams' || k === 'onsite'; });
        st.maxMinutes = d.max_minutes || 45;
        if (d.default_minutes && typeof d.default_minutes === 'object') st.defaults = d.default_minutes;
        else if (d.default_minutes) st.defaults[d.kind || st.kind] = d.default_minutes;
        if (d.horizon_days) st.horizon = d.horizon_days;
        prefillAddress(st.withCode ? d.onsite_address : '');
    }

    // ---------- Freie Termine: Monatskalender ----------
    // Je Monat eine Anfrage für die gewünschte Dauer und – wenn es eine kürzere gibt – eine für die kürzeste.
    // Aus den kürzesten Slots ergibt sich je Tag die längste freie Zeit am Stück („nur kürzer frei“).
    var loadId = 0;
    var answers = {};  // Slot-Antworten je Art|Dauer|Person|Monat – geleert nach Buchung, 409 und neuem Code
    function slotsFor(month, range, minutes) {
        var key = [st.kind, minutes, st.host || '', st.code ? 1 : 0, month].join('|');
        if (answers[key]) return Promise.resolve(answers[key]);
        return post('/slots', { kind: st.kind, minutes: minutes, from: range.from, to: range.to, code: st.code, host: st.host })
            .then(function (res) {
                if (res.status === 200) answers[key] = res;
                return res;
            });
    }
    function lastDay() { return addDays(today(), st.horizon); }
    function monthOf(day) { return day.slice(0, 7); }
    function monthStart(month) { return month + '-01'; }
    function monthEnd(month) { return addDays(nextMonth(month) + '-01', -1); }
    function nextMonth(month) {
        var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) + 1;
        if (m > 12) { m = 1; y++; }
        return y + '-' + (m < 10 ? '0' : '') + m;
    }
    function prevMonth(month) {
        var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1;
        if (m < 1) { m = 12; y--; }
        return y + '-' + (m < 10 ? '0' : '') + m;
    }
    function monthRange(month) {
        var from = monthStart(month), to = monthEnd(month), first = today(), last = lastDay();
        return { from: from < first ? first : from, to: to > last ? last : to };
    }
    function shortestMinutes() {
        var opts = durationOptions();
        return opts.length ? Math.min.apply(null, opts) : st.minutes;
    }
    function toMinutes(iso) { return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)); }
    function clockText(min) {
        var h = Math.floor(min / 60), m = min % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }
    function groupByDay(slots) {
        var byDay = {};
        (slots || []).forEach(function (s) { (byDay[s.start.slice(0, 10)] = byDay[s.start.slice(0, 10)] || []).push(s); });
        return byDay;
    }
    // Beginnzeiten, zu denen `minutes` am Stück frei ist: jeder Start im 15-Minuten-Raster von t bis
    // t + minutes − kürzeste Dauer muss selbst ein freier kürzester Slot sein (so wie /slots rechnet, inkl. Puffer)
    function startsFor(day, minutes) {
        var data = st.cache;
        var have = {};
        (data.short[day] || []).forEach(function (s) { have[toMinutes(s.start)] = true; });
        return Object.keys(have).map(Number).sort(function (a, b) { return a - b; }).filter(function (t) {
            for (var k = t; k <= t + minutes - data.shortMinutes; k += 15) if (!have[k]) return false;
            return true;
        });
    }
    // Längste Dauer aus der Auswahl, die an diesem Tag am Stück frei ist (kürzer als gewünscht), samt Beginnzeiten
    function shorterOffer(day) {
        if (!st.cache || !st.cache.shortMinutes) return null;
        var fits = durationOptions().filter(function (m) { return m < st.minutes; }).sort(function (a, b) { return b - a; });
        for (var i = 0; i < fits.length; i++) {
            var starts = startsFor(day, fits[i]);
            if (starts.length) return { minutes: fits[i], starts: starts };
        }
        return null;
    }
    function dayState(day) {
        var data = st.cache, range = data.range;
        if (day < range.from || day > range.to) return 'out';
        if ((data.wanted[day] || []).length) return 'free';
        return shorterOffer(day) ? 'short' : 'none';
    }

    // search = true: Einstieg bzw. neue Auswahl – Monat und Tag mit dem ersten freien Termin ansteuern
    function loadMonth(search, keepDay) {
        var id = ++loadId;
        var month = st.month;
        var range = monthRange(month);
        var box = $('bk-calendar');
        $('bk-month-label').textContent = T.months[Number(month.slice(5, 7)) - 1] + ' ' + month.slice(0, 4);
        $('bk-prev').disabled = month <= monthOf(today());
        $('bk-next').disabled = nextMonth(month) + '-01' > lastDay();
        box.setAttribute('aria-busy', 'true');
        box.classList.add('bk-loading');
        box.inert = true;
        $('bk-day-slots').replaceChildren();
        status(T.loading);
        if (range.from > range.to) return finishMonth(id, { range: range, wanted: {}, short: {}, shortMinutes: 0 }, search, keepDay);
        var shortMin = shortestMinutes();
        var wantedReq = slotsFor(month, range, st.minutes);
        var shortReq = shortMin < st.minutes
            ? slotsFor(month, range, shortMin).catch(function () { return null; }) : null;
        return Promise.all([wantedReq, shortReq]).then(function (results) {
            if (id !== loadId) return;
            var res = results[0], shortRes = results[1];
            if (res.status === 404) return showFallback();
            if (res.status === 422) return finishMonth(id, { range: range, wanted: {}, short: {}, shortMinutes: 0 }, search, keepDay);
            if (res.status !== 200) return monthError(res.status);
            var d = res.data;
            var hostBefore = st.host;
            applySettings(d);
            if (!st.kinds.length) {
                if (st.withCode && st.hosts.length > 1) {
                    renderHosts(); renderSummary();
                    monthError(0, T.host_none);
                    return;
                }
                return showFallback();
            }
            // Andere Person gewählt bzw. ihre Arten passen nicht: Auswahl angleichen und neu laden
            var kindGone = st.kinds.indexOf(st.kind) < 0;
            var wantDefault = st.applyDefault && st.withCode && st.defaults[st.kind] && st.defaults[st.kind] !== st.minutes;
            if (kindGone || wantDefault || hostBefore !== st.host) {
                var again = kindGone || hostBefore !== st.host;
                st.applyDefault = again;
                if (kindGone) st.kind = st.kinds[0];
                if (!again && st.withCode && st.defaults[st.kind]) { st.minutes = st.defaults[st.kind]; st.customMinutes = false; }
                renderKinds(); renderHosts(); renderDurations(); renderSummary();
                return loadMonth(search, keepDay);
            }
            st.applyDefault = false;
            var asked = st.minutes;
            renderKinds(); renderHosts(); renderDurations(); renderSummary();
            // Länge passte nicht mehr (z. B. Code inzwischen ungültig, höchstens 45 Minuten): neu laden
            if (st.minutes !== asked) return loadMonth(search, keepDay);
            var short = shortRes && shortRes.status === 200 ? groupByDay(shortRes.data.slots) : {};
            finishMonth(id, { range: range, wanted: groupByDay(d.slots), short: short, shortMinutes: shortMin }, search, keepDay);
        }).catch(function () {
            if (id === loadId) monthError(0);
        });
    }
    function monthError(code, text) {
        var box = $('bk-calendar');
        box.removeAttribute('aria-busy');
        box.classList.remove('bk-loading');
        box.inert = false;
        box.replaceChildren();  // kein Raster des vorigen Monats unter dem neuen Monatsnamen
        st.cache = null;
        status('');
        notice($('bk-day-slots'), text || errorText(code), 'error');
    }
    var jumps = 0, searchStart = '';
    function finishMonth(id, data, search, keepDay) {
        if (id !== loadId) return;
        st.cache = data;
        var days = [];
        for (var day = data.range.from; day <= data.range.to; day = addDays(day, 1)) days.push(day);
        var firstFree = days.filter(function (d) { return dayState(d) === 'free'; })[0];
        var firstShort = days.filter(function (d) { return dayState(d) === 'short'; })[0];
        // Beim Einstieg: Monat ohne jeden freien Termin → bis zu zwei Monate weiter (innerhalb des Horizonts)
        if (search && !firstFree && !firstShort) {
            if (!jumps) searchStart = st.month;
            if (jumps < 2 && nextMonth(st.month) + '-01' <= lastDay()) {
                jumps++;
                st.month = nextMonth(st.month);
                return loadMonth(true);
            }
            if (jumps) {  // nichts gefunden: zurück zum Ausgangsmonat (aus dem Zwischenspeicher)
                jumps = 0;
                st.month = searchStart;
                return loadMonth(false);
            }
        }
        jumps = 0;
        if (!(keepDay && st.day && monthOf(st.day) === st.month && dayState(st.day) !== 'out')) {
            st.day = firstFree || firstShort || null;
        }
        renderMonth();
    }

    function renderMonth() {
        var data = st.cache, month = st.month;
        var box = $('bk-calendar');
        box.removeAttribute('aria-busy');
        box.classList.remove('bk-loading');
        box.inert = false;
        box.replaceChildren();
        T.weekdays.forEach(function (w) {
            box.append(el('span', { 'class': 'bk-cal-head', 'aria-hidden': 'true' }, w));
        });
        var first = monthStart(month);
        var lead = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
        for (var i = 0; i < lead; i++) box.append(el('span', { 'class': 'bk-cal-blank', 'aria-hidden': 'true' }));
        var counts = { free: 0, short: 0 };
        for (var day = first; day <= monthEnd(month); day = addDays(day, 1)) {
            var state = dayState(day);
            var n = String(Number(day.slice(8)));
            if (state === 'out' || state === 'none') {
                var cell = el('span', { 'class': 'bk-cal-day bk-is-' + state });
                cell.append(el('span', { 'aria-hidden': 'true' }, n));
                cell.append(el('span', { 'class': 'bk-sr' },
                    fmt(state === 'none' ? T.day_none : T.day_out, { day: longDay(day) })));
                box.append(cell);
                continue;
            }
            counts[state]++;
            var offer = state === 'short' ? shorterOffer(day) : null;
            var label = state === 'free'
                ? fmt(T.day_free, { day: longDay(day), n: st.minutes })
                : fmt(T.day_short, { day: longDay(day), n: offer.minutes });
            var b = el('button', {
                type: 'button', 'class': 'bk-cal-day bk-is-' + state, 'data-day': day,
                'aria-pressed': String(day === st.day), 'aria-label': label
            });
            b.append(el('span', { 'class': 'bk-cal-num' }, n));
            b.append(state === 'free'
                ? el('span', { 'class': 'bk-cal-dot', 'aria-hidden': 'true' })
                : el('span', { 'class': 'bk-cal-short', 'aria-hidden': 'true' }, offer.minutes + '′'));
            box.append(b);
        }
        $('bk-legend-short').hidden = !counts.short;
        status(fmt(counts.free === 1 ? T.days_one : T.days_n, { n: counts.free }) +
            (counts.short ? fmt(T.days_short, { n: counts.short }) : '') + '.');
        renderDay();
    }

    var focusSlot = false;
    function renderDay() {
        var box = $('bk-day-slots');
        box.replaceChildren();
        var day = st.day;
        if (!day) return notice(box, T.month_none);
        box.append(el('h3', {}, longDay(day)));
        var wanted = st.cache.wanted[day] || [];
        if (wanted.length) {
            var list = el('div', { 'class': 'bk-slot-list' });
            wanted.forEach(function (s) {
                list.append(el('button', {
                    type: 'button', 'class': 'bk-slot', 'data-start': s.start, 'data-end': s.end,
                    'aria-pressed': String(!!st.slot && st.slot.start === s.start),
                    'aria-label': longDay(day) + ', ' + fmt(T.clock, { t: hhmm(s.start) })
                }, hhmm(s.start)));
            });
            box.append(list);
            if (focusSlot) { focusSlot = false; list.querySelector('.bk-slot').focus(); }
            return;
        }
        focusSlot = false;
        var offer = shorterOffer(day);
        if (!offer) return notice(box, T.day_nothing);
        var times = offer.starts.slice(0, 4).map(clockText).join(', ');
        var hint = el('div', { 'class': 'bk-shorter' });
        hint.append(el('p', {}, fmt(T.shorter, {
            want: durationLabel(st.minutes), offer: durationLabel(offer.minutes),
            times: fmt(T.clock, { t: times + (offer.starts.length > 4 ? T.and_more : '') })
        })));
        hint.append(el('button', { type: 'button', 'class': 'button', id: 'bk-use-shorter', 'data-minutes': String(offer.minutes) },
            fmt(T.use_shorter, { d: durationLabel(offer.minutes) })));
        box.append(hint);
    }

    function resetSelection() {
        st.slot = null;
        st.month = monthOf(today());
        st.day = null;
        st.cache = null;
        jumps = 0;
        $('bk-details').hidden = true;
        $('bk-result').hidden = true;
        renderSummary();
        return loadMonth(true);
    }
    // Neu laden, Monat und Tag behalten (nach Buchung, 409, „kürzer nehmen“)
    function reloadKeepDay(fresh) {
        if (fresh) answers = {};
        st.slot = null;
        st.cache = null;
        $('bk-details').hidden = true;
        renderSummary();
        return loadMonth(false, true);
    }
    function setKindFields() {
        var onsite = st.kind === 'onsite';
        $('bk-addr-field').hidden = $('bk-r-addr-field').hidden = !onsite;
        $('bk-addr').setAttribute('aria-required', String(onsite));
        $('bk-r-addr').setAttribute('aria-required', String(onsite));
    }

    // ---------- Formulare ----------
    function validate(form) {
        var first = null;
        form.querySelectorAll('.bk-error').forEach(function (n) { n.remove(); });
        form.querySelectorAll('input:not([type=radio]), textarea').forEach(function (input) {
            var field = input.closest('.bk-field');
            if (!field || field.hidden) return;
            var need = input.required || input.hasAttribute('data-address');
            var value = input.value.trim();
            var msg = '';
            if (need && !value) msg = T.fill;
            else if (input.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) msg = T.bad_email;
            input.setAttribute('aria-invalid', msg ? 'true' : 'false');
            if (msg) {
                var p = el('p', { 'class': 'bk-error', id: input.id + '-error' }, msg);
                field.append(p);
                input.setAttribute('aria-describedby', p.id);
                first = first || input;
            } else {
                input.removeAttribute('aria-describedby');
            }
        });
        if (first) first.focus();
        return !first;
    }

    function finish(title, text) {
        var r = $('bk-result');
        r.replaceChildren(el('h2', {}, title), el('p', { 'class': 'bk-notice bk-ok' }, text));
        if (preview) r.append(el('p', { 'class': 'bk-hint' }, T.preview_done));
        r.hidden = false;
        $('bk-details').hidden = true;
        $('bk-request').hidden = true;
        r.focus();
        // Auswahl zurücksetzen und neu laden – derselbe Termin lässt sich nicht noch einmal buchen
        reloadKeepDay(true);
    }
    function fail(code) {
        var r = $('bk-result');
        r.hidden = false;
        notice(r, code === 404 || code === 503 ? fmt(T.err_404, { email: EMAIL }) : errorText(code), 'error');
        r.focus();
        if (code === 409) reloadKeepDay(true);
    }
    function sending(button, on) {
        st.busy = on;
        button.disabled = on;
        button.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    function ok(res) { return res.status === 200 || res.status === 201; }

    function bindEvents() {
        ['bk-addr', 'bk-r-addr'].forEach(function (id) {
            $(id).addEventListener('input', function () { addressEdited[id] = true; });
        });
        root.addEventListener('change', function (e) {
            var name = e.target.name;
            if (name === 'bk-kind') {
                st.kind = e.target.value;
                setKindFields();
                if (st.withCode && st.defaults[st.kind]) { st.minutes = st.defaults[st.kind]; st.customMinutes = false; }
                st.applyDefault = st.withCode;  // nach einem Personenwechsel kennt erst die Antwort deren Länge
                renderDurations();
                resetSelection();
            } else if (name === 'bk-minutes') {
                st.minutes = Number(e.target.value);
                st.customMinutes = false;
                renderDurations();
                resetSelection();
            } else if (e.target.id === 'bk-hours') {
                applyHours();
            } else if (name === 'bk-host') {
                st.host = e.target.value;
                st.applyDefault = true;  // Standardlänge und Adresse der Person kommen mit der Slot-Antwort
                renderSummary();
                resetSelection();
            }
        });
        $('bk-prev').addEventListener('click', function () {
            st.month = prevMonth(st.month);
            st.day = null;
            loadMonth(false);
        });
        $('bk-next').addEventListener('click', function () {
            st.month = nextMonth(st.month);
            st.day = null;
            loadMonth(false);
        });
        $('bk-calendar').addEventListener('click', function (e) {
            var b = e.target.closest('.bk-cal-day[data-day]');
            if (!b || !st.cache || $('bk-calendar').classList.contains('bk-loading')) return;
            st.day = b.getAttribute('data-day');
            st.slot = null;
            $('bk-details').hidden = true;
            root.querySelectorAll('.bk-cal-day[data-day]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
            renderSummary();
            renderDay();
        });
        $('bk-day-slots').addEventListener('click', function (e) {
            var use = e.target.closest('#bk-use-shorter');
            if (use) {
                // Kürzere Dauer übernehmen – Tag bleibt gewählt, die Uhrzeiten erscheinen gleich
                st.minutes = Number(use.getAttribute('data-minutes'));
                st.customMinutes = false;
                focusSlot = true;
                var dayButton = root.querySelector('.bk-cal-day[data-day="' + st.day + '"]');
                if (dayButton) dayButton.focus();
                renderDurations();
                renderSummary();
                reloadKeepDay();
                return;
            }
            var b = e.target.closest('.bk-slot');
            if (!b) return;
            st.slot = { start: b.getAttribute('data-start'), end: b.getAttribute('data-end') };
            root.querySelectorAll('.bk-slot').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
            $('bk-details').hidden = false;
            $('bk-request').hidden = true;
            $('bk-result').hidden = true;
            renderSummary();
            $('bk-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
            $('bk-name').focus({ preventScroll: true });
        });
        $('bk-to-request').addEventListener('click', function (e) {
            e.preventDefault();
            $('bk-request').hidden = false;
            $('bk-details').hidden = true;
            $('bk-result').hidden = true;
            $('bk-request').scrollIntoView({ behavior: 'smooth', block: 'start' });
            $('bk-r-name').focus({ preventScroll: true });
        });
        $('bk-book-form').addEventListener('submit', function (e) {
            e.preventDefault();
            if (st.busy || !st.slot || !validate(e.target)) return;
            var email = $('bk-email').value.trim();
            var kind = st.kind;
            var body = {
                kind: kind, start: st.slot.start, minutes: st.minutes, name: $('bk-name').value.trim(),
                email: email, message: $('bk-msg').value.trim(), code: st.code, host: st.host
            };
            if ($('bk-website').value) body.website = $('bk-website').value;
            if (kind === 'onsite') body.address = $('bk-addr').value.trim();
            var values = { when: slotText(), teams: kind === 'teams' ? T.with_teams : '', email: email };
            sending($('bk-book-btn'), true);
            post('/book', body).then(function (res) {
                if (!ok(res)) return fail(res.status);
                if (res.data.status === 'confirmed') finish(T.done_confirmed_title, fmt(T.done_confirmed, values));
                else finish(T.done_tentative_title, fmt(T.done_tentative, values));
            }).catch(function () { fail(0); }).then(function () { sending($('bk-book-btn'), false); });
        });
        $('bk-request-form').addEventListener('submit', function (e) {
            e.preventDefault();
            if (st.busy || !validate(e.target)) return;
            var email = $('bk-r-email').value.trim();
            var body = {
                kind: st.kind, minutes: st.minutes, name: $('bk-r-name').value.trim(), email: email,
                windows: [$('bk-r-when').value.trim()], message: $('bk-r-msg').value.trim(), code: st.code, host: st.host
            };
            if (st.kind === 'onsite') body.address = $('bk-r-addr').value.trim();
            sending($('bk-request-btn'), true);
            post('/requests', body).then(function (res) {
                if (!ok(res)) return fail(res.status);
                finish(T.done_request_title, fmt(T.done_request, { email: email }));
            }).catch(function () { fail(0); }).then(function () { sending($('bk-request-btn'), false); });
        });
    }

    // ---------- Start: erst /config, dann die Termine ----------
    var startId = 0;
    function start(code) {
        var id = ++startId;
        ++loadId;  // laufende Slot-Anfragen gehören zum alten Stand und werden verworfen
        st.cache = null;
        answers = {};
        var wasLoaded = st.loaded;
        st.code = code || '';
        st.loaded = false;
        st.kind = 'teams';
        st.minutes = 30;
        st.customMinutes = false;
        $('bk-preview').hidden = !preview;
        post('/config', { code: st.code }).then(function (res) {
            if (id !== startId) return;
            // Nicht verfügbar (404), kaputt oder nichts buchbar: dann der Weg per E-Mail
            if (res.status !== 200) {
                if (res.status === 429 && wasLoaded) { st.loaded = true; return notice($('bk-day-slots'), errorText(429), 'error'); }
                return showFallback();
            }
            applySettings(res.data);
            if (!st.kinds.length || res.data.bookable === false) return showFallback();
            st.loaded = true;
            st.kind = st.kinds.indexOf('teams') >= 0 ? 'teams' : st.kinds[0];
            st.minutes = st.withCode ? (st.defaults[st.kind] || 30) : 30;
            renderKinds(); renderHosts(); renderDurations();
            $('bk-fallback').hidden = true;
            root.hidden = false;
            resetSelection();
        }).catch(function () {
            if (id !== startId) return;
            // Lief die Seite schon, bleibt sie stehen – nur beim ersten Laden gilt der Weg per E-Mail
            if (wasLoaded) { st.loaded = true; return notice($('bk-day-slots'), errorText(0), 'error'); }
            showFallback();
        });
    }

    var active = false;
    function activate(code) {
        if (!active) { active = true; bindEvents(); }
        start(code);
    }
    var linkCode = readLink();
    // Auch ohne Schlüssel: ein neuer #code=… verschwindet sofort aus der Adresszeile
    window.addEventListener('hashchange', function () {
        var code = readLink();
        if ((KEY || preview) && (!active || code)) activate(code);
    });
    if (KEY || preview) activate(linkCode);  // ohne Schlüssel bleibt der Weg per E-Mail

    // ---------- Vorschau (#vorschau): Antworten wie die echte API, ohne Server ----------
    // Beispiel-Code K7QM-4R2X-9HTB mit zwei Personen; Anna bietet nur Teams an.
    function mock(path, body) {
        var VALID = 'K7QM4R2X9HTB';
        var HOSTS = [{ id: 'pw0000000001', name: 'Peter Wiens' }, { id: 'ab0000000002', name: 'Anna Beispiel' }];
        var code = String(body.code || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
        var known = code === VALID;
        var host = known ? (HOSTS.filter(function (h) { return h.id === body.host; })[0] || HOSTS[0]) : null;
        var first = known && host.id === HOSTS[0].id;
        var kinds = first ? ['teams', 'onsite'] : ['teams'];
        var defaults = !known ? { teams: 30, onsite: 30 } : (first ? { teams: 60, onsite: 90 } : { teams: 45, onsite: 45 });
        var common = {
            timezone: TZ, kinds: kinds, max_minutes: known ? 600 : 45, hosts: known ? HOSTS : [],
            host: known ? host.id : null, onsite_address: known ? 'Bahnhofstrasse 1, 8001 Zürich' : null
        };
        var answer;
        if (path === '/config') {
            answer = Object.assign({ default_minutes: defaults, horizon_days: 60, bookable: true }, common);
        } else if (path === '/slots') {
            answer = Object.assign({ kind: body.kind, minutes: body.minutes, default_minutes: defaults[body.kind] || 30, slots: [] }, common);
            if (kinds.indexOf(body.kind) >= 0 && body.minutes <= common.max_minutes) {
                var windows = body.kind === 'teams' ? [[9, 12], [14, 17]] : [[10, 16]];
                var earliest = addDays(today(), 1);
                var shift = known && !first ? 1 : 0;
                // Belegte Blöcke je Tag (Minuten seit Mitternacht): mal voll, mal nur kurze Lücken, mal ganz frei
                var BUSY = [
                    [[570, 690], [840, 990]],    // nur 30-Minuten-Lücken
                    [[600, 660]],                // eine Stunde belegt
                    [],                          // ganz frei
                    [[540, 720], [885, 1020]],   // nur 14:00–14:45 frei
                    [[540, 720], [840, 1020]]    // alles belegt
                ];
                for (var day = body.from; day <= body.to; day = addDays(day, 1)) {
                    var wd = new Date(day + 'T12:00:00Z').getUTCDay();
                    if (wd === 0 || wd === 6 || day < earliest) continue;
                    var busy = BUSY[(Number(day.slice(8)) + shift) % BUSY.length];
                    windows.forEach(function (w) {
                        for (var t = w[0] * 60; t + body.minutes <= w[1] * 60; t += 15) {
                            var end = t + body.minutes;
                            if (busy.some(function (b) { return t < b[1] && end > b[0]; })) continue;
                            answer.slots.push({ start: day + 'T' + clock(t) + '+01:00', end: day + 'T' + clock(end) + '+01:00' });
                        }
                    });
                }
            }
        } else if (path === '/book') {
            answer = { status: known ? 'confirmed' : 'tentative' };
        } else {
            answer = { status: 'received' };
        }
        return new Promise(function (resolve) { setTimeout(function () { resolve({ status: 200, data: answer }); }, 300); });
    }
    function clock(minutes) {
        var h = Math.floor(minutes / 60), m = minutes % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':00';
    }
})();
