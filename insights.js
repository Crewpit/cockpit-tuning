(function () {
    "use strict";

    // Overview panel: live memory and zram charts plus the "is zram leveraged?"
    // checklist. Sampling runs through App.poll, started in onShow and stopped
    // in onHide. Charts are hand-drawn SVG styled by theme tokens in index.css.

    var T = Tuning;
    var el = App.el;
    var SVGNS = "http://www.w3.org/2000/svg";

    var SAMPLE_MS = 3000;
    var MAX_SAMPLES = 200; // 10 minutes at 3 s
    var hist = [];
    var pageSize = 4096;
    var poller = null;
    var procPoller = null;
    var procTable = null;
    var dismissed = {};
    var showDismissed = false;
    var inited = false;
    var stressDev = null;
    var stressProc = null;
    var STRESS_SCRIPT = "/usr/share/cockpit/cockpit-tuning/stress-zram.sh";

    try {
        dismissed = JSON.parse(window.localStorage.getItem("tuning:dismissed") || "{}") || {};
    } catch (e) {
        dismissed = {};
    }

    function saveDismissed() {
        try {
            window.localStorage.setItem("tuning:dismissed", JSON.stringify(dismissed));
        } catch (e) { /* storage unavailable: dismissals last for this page view only */ }
    }

    function svg(tag, attrs, children) {
        var n = document.createElementNS(SVGNS, tag);
        Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]) });
        (children || []).forEach(function (c) { n.appendChild(c) });
        return n;
    }

    // ---- sampling -----------------------------------------------------------------

    function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n }

    function readZram(name) {
        return Promise.all([T.read("/sys/block/" + name + "/mm_stat"), T.read("/sys/block/" + name + "/disksize")]).then(function (r) {
            if (!r[0])
                return null;
            var f = r[0].trim().split(/\s+/).map(Number);
            // Field count varies by kernel: orig, compr, mem_used, limit, used_max, same, compacted, huge, huge_since.
            function at(i) { return isNaN(f[i]) ? 0 : f[i] }
            return {
                name: name, orig: at(0), compr: at(1), memUsed: at(2), limit: at(3), same: at(5) * pageSize, huge: at(7) * pageSize,
                disksize: r[1] ? Number(r[1].trim()) : 0,
            };
        });
    }

    function takeSample() {
        return Promise.all([
            T.read("/proc/meminfo"), T.read("/proc/swaps"), T.read("/proc/vmstat"), T.read("/proc/pressure/memory"),
            T.read("/proc/sys/vm/swappiness"), T.read("/proc/sys/vm/page-cluster"), T.read("/sys/module/zswap/parameters/enabled"),
        ]).then(function (r) {
            var mi = T.parseKV(r[0]);
            function kb(k) { return num(mi[k]) * 1024 }
            var swaps = (r[1] || "").split("\n").slice(1).filter(Boolean).map(function (l) {
                var p = l.trim().split(/\s+/);
                return { name: p[0], size: num(p[2]) * 1024, used: num(p[3]) * 1024, prio: num(p[4]) };
            });
            var vm = {};
            (r[2] || "").split("\n").forEach(function (l) {
                var p = l.split(" ");
                vm[p[0]] = Number(p[1]);
            });
            var allocstall = 0;
            Object.keys(vm).forEach(function (k) { if (/^allocstall/.test(k)) allocstall += vm[k] });
            var psi = null;
            if (r[3]) {
                psi = {};
                r[3].trim().split("\n").forEach(function (l) {
                    var m = /^(some|full)\s.*avg10=([\d.]+)/.exec(l);
                    if (m)
                        psi[m[1]] = Number(m[2]);
                });
            }
            var zramNames = swaps.map(function (s) { return /\/zram\d+$/.test(s.name) ? s.name.replace(/^.*\//, "") : null }).filter(Boolean);
            if (stressDev && zramNames.indexOf(stressDev) === -1)
                zramNames.push(stressDev);
            return Promise.all(zramNames.map(readZram)).then(function (z) {
                return {
                    t: Date.now(),
                    memTotal: kb("MemTotal"), memFree: kb("MemFree"), memAvail: kb("MemAvailable"),
                    cache: kb("Cached") + kb("Buffers") + kb("SReclaimable"),
                    swaps: swaps,
                    zram: z.filter(Boolean).map(function (x) { x.scratch = x.name === stressDev; return x }),
                    pswpin: vm.pswpin || 0, pswpout: vm.pswpout || 0, major: vm.pgmajfault || 0,
                    allocstall: allocstall, oom: vm.oom_kill || 0,
                    psi: psi,
                    swappiness: r[4] ? Number(r[4]) : null,
                    pageCluster: r[5] ? Number(r[5]) : null,
                    zswap: !!r[6] && /^[Y1]/.test(r[6].trim()),
                };
            });
        });
    }

    // Per-interval rates between consecutive samples.
    function rates(h) {
        var out = [];
        for (var i = 1; i < h.length; i++) {
            var a = h[i - 1], b = h[i];
            var dt = (b.t - a.t) / 1000 || 1;
            out.push({
                t: b.t,
                swapIn: Math.max(0, (b.pswpin - a.pswpin) * pageSize / dt),
                swapOut: Math.max(0, (b.pswpout - a.pswpout) * pageSize / dt),
                major: Math.max(0, (b.major - a.major) / dt),
                psiSome: b.psi ? b.psi.some : null,
                psiFull: b.psi ? b.psi.full : null,
                avail: b.memAvail,
                zStored: zramTotals(b, true).orig,
                zRam: zramTotals(b, true).memUsed,
            });
        }
        return out;
    }

    // ---- checklist ---------------------------------------------------------------------

    // Thrashing: sustained swap-in (average over the recent window) together with
    // memory pressure. With PSI the "some" average must be at least 10 %; without it,
    // a high major-fault rate stands in for pressure.
    function isThrashing(recent) {
        var n = recent.length;
        if (!n)
            return false;
        var swapIn = recent.reduce(function (a, r) { return a + r.swapIn }, 0) / n;
        if (swapIn < 4 * 1048576)
            return false;
        var last = recent[n - 1];
        if (last.psiSome !== null)
            return last.psiSome >= 10;
        var major = recent.reduce(function (a, r) { return a + r.major }, 0) / n;
        return major >= 50;
    }

    // Rules ignore the scratch stress-test device; the efficiency card and charts include it.
    function zramTotals(s, all) {
        var t = { orig: 0, compr: 0, memUsed: 0, disksize: 0, same: 0, huge: 0 };
        s.zram.forEach(function (z) { if (z.scratch && !all) return; Object.keys(t).forEach(function (k) { t[k] += z[k] }) });
        return t;
    }

    function goto(hash) { return function () { window.location.hash = hash } }

    function evaluate(h) {
        var s = h[h.length - 1];
        var out = [];
        if (!s)
            return out;
        var z = s.swaps.filter(function (x) { return /\/zram\d+$/.test(x.name) });
        var disk = s.swaps.filter(function (x) { return !/\/zram\d+$/.test(x.name) });
        var zt = zramTotals(s);
        var fill = zt.disksize ? zt.orig / zt.disksize * 100 : 0;
        var diskUsed = disk.reduce(function (a, x) { return a + x.used }, 0);
        var zPrioMin = z.reduce(function (a, x) { return Math.min(a, x.prio) }, Infinity);
        var dPrioMax = disk.reduce(function (a, x) { return Math.max(a, x.prio) }, -Infinity);
        var rs = rates(h.slice(-11));
        var psi = s.psi ? s.psi.some : null;
        function add(id, level, title, detail, fix) { out.push({ id: id, level: level, title: title, detail: detail, fix: fix || null }) }

        if (z.length)
            add("zram-active", "pass", "A zram swap device is active", z.length + " device(s): " + z.map(function (x) { return x.name.replace(/^.*\//, "") }).join(", ") + ".");
        else
            add("zram-active", "fail", "No zram swap device is active", "Without zram, memory pressure goes straight to disk swap or the OOM killer.",
                { label: "Open ZRAM", run: goto("#/zram") });

        if (z.length && disk.length) {
            if (zPrioMin > dPrioMax)
                add("zram-prio", "pass", "zram priority is above disk swap", "zram " + zPrioMin + " versus disk " + dPrioMax + ".");
            else
                add("zram-prio", "warn", "Disk swap has the same or higher priority than zram",
                    "zram " + zPrioMin + " versus disk " + dPrioMax + ". The kernel fills higher priority first, so zram is bypassed.");
        }

        if (z.length && diskUsed > 0 && fill < 90)
            add("disk-while-free", "warn", "Disk swap is in use while zram has free capacity",
                T.fmtBytes(diskUsed) + " on disk, zram " + T.fmtPct(fill) + " full. This is usually a priority ordering problem.");

        if (z.length && fill >= 90 && diskUsed > 0)
            add("zram-small", "warn", "zram is nearly full and disk swap is also used", "zram is " + T.fmtPct(fill) + " full. Consider a larger zram size.",
                { label: "Open ZRAM", run: goto("#/zram") });

        if (z.length && psi !== null && psi > 10 && fill < 10 && s.swappiness !== null && s.swappiness < 100)
            add("pressure-idle", "warn", "Memory pressure is high while zram is nearly empty",
                "PSI some avg10 is " + psi.toFixed(1) + " % but zram holds " + T.fmtPct(fill) + ". vm.swappiness is " + s.swappiness + ", so the kernel prefers dropping cache.",
                { label: "Raise swappiness", run: function () { T.tryLive([{ key: "vm.swappiness", value: "180" }]) } });

        if (z.length) {
            var wanted = [];
            if (s.swappiness !== null && s.swappiness < 100)
                wanted.push({ key: "vm.swappiness", value: "180" });
            if (s.pageCluster !== null && s.pageCluster !== 0)
                wanted.push({ key: "vm.page-cluster", value: "0" });
            if (wanted.length)
                add("zram-sysctl", "info", "Zram-first kernel settings are not applied",
                    "vm.swappiness is " + s.swappiness + " (100 or more suits zram) and vm.page-cluster is " + s.pageCluster + " (0 avoids read-ahead on compressed swap).",
                    { label: "Try Live", run: function () { T.tryLive(wanted, { title: "Zram-Friendly Kernel Settings" }) } });
            else
                add("zram-sysctl", "pass", "Zram-first kernel settings are applied", "vm.swappiness " + s.swappiness + ", vm.page-cluster " + s.pageCluster + ".");
        }

        if (zt.orig > 64 * 1048576 && zt.compr > 0) {
            var ratio = zt.orig / zt.compr;
            if (ratio < 1.5)
                add("ratio", "warn", "Low compression ratio (" + ratio.toFixed(2) + ")",
                    "Stored data barely compresses. Try lz4 for speed, or reconsider how much zram you need.", { label: "Open ZRAM", run: goto("#/zram") });
            else
                add("ratio", "pass", "Compression ratio is healthy (" + ratio.toFixed(2) + ")", "Each byte of zram RAM holds about " + ratio.toFixed(1) + " bytes of data.");
        }

        if (s.zswap && (z.length || zt.disksize))
            add("zswap", "warn", "zswap is enabled alongside zram", "The two overlap and compress twice. Disable zswap with zswap.enabled=0.",
                { label: "Open ZRAM", run: goto("#/zram") });

        if (rs.length >= 5 && isThrashing(rs))
            add("thrash", "warn", "Possible thrashing", "Sustained swap-in activity under pressure. zram or RAM may be undersized for this workload.",
                { label: "Open ZRAM", run: goto("#/zram") });

        if (s.swaps.length && s.swaps.every(function (x) { return /\/zram\d+$/.test(x.name) }))
            add("hibernate", "info", "zram-only swap cannot hibernate", "Hibernation needs swap on disk at least as large as RAM. Ignore this if you do not hibernate.");

        return out;
    }

    // ---- charts ---------------------------------------------------------------------------

    // HTML bar, not SVG: segments reuse the legend's own CSS classes, so fill and hatch match the swatches exactly.
    function bar(segments) {
        var left = 100;
        var kids = segments.map(function (sg) {
            var w = Math.max(0, Math.min(left, sg.pct));
            left -= w;
            var seg = el("span", { class: "ins-seg " + sg.cls });
            seg.style.width = w + "%";
            return seg;
        });
        return el("div", { class: "ins-bar ins-track", role: "img", "aria-label": segments.map(function (s) { return s.label }).join(", ") }, kids);
    }

    function legend(items) {
        return el("ul", { class: "ins-legend" }, items.map(function (i) {
            return el("li", {}, [el("span", { class: "ins-swatch " + i.cls, "aria-hidden": "true" }), el("span", { text: i.text })]);
        }));
    }

    function memoryBars(s) {
        var host = document.getElementById("ins-bars");
        var used = Math.max(0, s.memTotal - s.memFree - s.cache);
        var pct = function (v, t) { return t ? v / t * 100 : 0 };
        var blocks = [];
        blocks.push(el("div", { class: "ins-block" }, [
            el("h3", { class: "ins-heading", text: "RAM " + T.fmtBytes(s.memTotal) }),
            bar([{ pct: pct(used, s.memTotal), cls: "ins-used", label: "used " + T.fmtBytes(used) }, { pct: pct(s.cache, s.memTotal), cls: "ins-cache", label: "cache " + T.fmtBytes(s.cache) }]),
            legend([{ cls: "ins-used", text: "Used " + T.fmtBytes(used) }, { cls: "ins-cache", text: "Cache " + T.fmtBytes(s.cache) }, { cls: "ins-free", text: "Free " + T.fmtBytes(s.memFree) }]),
        ]));
        if (!s.swaps.length)
            blocks.push(el("p", { class: "app-muted", text: "No swap is active." }));
        // One bar per zram device (swap role folded in); other swap devices keep a plain used/free bar.
        var zByName = {};
        s.zram.forEach(function (z) { zByName[z.name] = z });
        s.swaps.forEach(function (sw) {
            var base = sw.name.replace(/^.*\//, "");
            if (zByName[base])
                return;
            blocks.push(el("div", { class: "ins-block" }, [
                el("h3", { class: "ins-heading", text: "Swap " + base + ", " + T.fmtBytes(sw.size) + ", priority " + sw.prio }),
                bar([{ pct: pct(sw.used, sw.size), cls: "ins-disk", label: "used " + T.fmtBytes(sw.used) }]),
                legend([{ cls: "ins-disk", text: "Used " + T.fmtBytes(sw.used) }, { cls: "ins-free", text: "Free " + T.fmtBytes(sw.size - sw.used) }]),
            ]));
        });
        s.zram.forEach(function (z) {
            var sw = s.swaps.filter(function (x) { return x.name.replace(/^.*\//, "") === z.name })[0];
            var cap = z.disksize || Math.max(z.orig, 1);
            var saved = Math.max(0, z.orig - z.memUsed);
            var title = (z.scratch ? "Zram " + z.name + " (stress test)" : "Swap " + z.name + " (zram)") + ", " + T.fmtBytes(cap) +
                (sw ? ", priority " + sw.prio + ", swap in use " + T.fmtBytes(sw.used) : "");
            blocks.push(el("div", { class: "ins-block" }, [
                el("h3", { class: "ins-heading", text: title }),
                bar([{ pct: pct(z.memUsed, cap), cls: "ins-zram", label: "RAM footprint " + T.fmtBytes(z.memUsed) },
                     { pct: pct(saved, cap), cls: "ins-saved", label: "saved " + T.fmtBytes(saved) }]),
                legend([{ cls: "ins-zram", text: "RAM footprint " + T.fmtBytes(z.memUsed) }, { cls: "ins-saved", text: "Saved by compression " + T.fmtBytes(saved) },
                        { cls: "ins-free", text: "Free capacity " + T.fmtBytes(Math.max(0, cap - z.orig)) }]),
            ]));
        });
        host.replaceChildren.apply(host, blocks);
    }

    function efficiency(s) {
        var host = document.getElementById("ins-efficiency");
        if (!s.zram.length) {
            host.replaceChildren(el("p", { class: "app-muted", text: "No zram device is active." }));
            return;
        }
        function row(name, z) {
            return [name,
                    z.compr ? (z.orig / z.compr).toFixed(2) + " : 1" : "—",
                    T.fmtBytes(z.orig), T.fmtBytes(z.memUsed), T.fmtBytes(Math.max(0, z.orig - z.memUsed)),
                    z.orig ? T.fmtPct(z.same / z.orig * 100) : "—",
                    z.orig ? T.fmtPct(z.huge / z.orig * 100) : "—",
                    z.disksize ? T.fmtPct(z.orig / z.disksize * 100) : "—"];
        }
        var rows = s.zram.map(function (z) { return row(z.name + (z.scratch ? " (stress test)" : ""), z) });
        if (s.zram.length > 1)
            rows.push(row("Total", zramTotals(s, true)));
        host.replaceChildren(T.statTable("Zram efficiency",
            ["Device", "Compression Ratio", "Stored", "RAM Used", "RAM Saved", "Same-Page", "Incompressible", "Fill"], rows));
    }

    // series: [{ name, cls, data: [numbers|null] }]; dashed classes keep series
    // distinguishable without colour.
    function lineChart(hostId, title, series, fmt) {
        var host = document.getElementById(hostId);
        var W = 300, H = 80;
        var max = 0;
        series.forEach(function (sr) { sr.data.forEach(function (v) { if (v !== null && v > max) max = v }) });
        var top = max * 1.1 || 1;
        var kids = [svg("rect", { x: 0, y: 0, width: W, height: H, class: "ins-plot" })];
        [0.25, 0.5, 0.75].forEach(function (f) { kids.push(svg("line", { x1: 0, x2: W, y1: H * f, y2: H * f, class: "ins-grid" })) });
        series.forEach(function (sr) {
            var n = sr.data.length;
            if (n < 2)
                return;
            var pts = [];
            sr.data.forEach(function (v, i) {
                if (v === null)
                    return;
                pts.push((i / (MAX_SAMPLES - 1) * W + (W - (n - 1) / (MAX_SAMPLES - 1) * W)).toFixed(1) + "," + (H - v / top * H).toFixed(1));
            });
            if (pts.length > 1)
                kids.push(svg("polyline", { points: pts.join(" "), class: "ins-line " + sr.cls }));
        });
        var last = series.map(function (sr) {
            var v = sr.data[sr.data.length - 1];
            return sr.name + " " + (v === null || v === undefined ? "—" : fmt(v));
        }).join(", ");
        host.replaceChildren(
            el("h3", { class: "ins-heading", text: title }),
            svg("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", class: "ins-chart", role: "img", "aria-label": title + ". Now: " + last }, kids),
            el("div", { class: "ins-axis" }, [el("span", { text: "10 min ago" }), el("span", { text: "peak " + fmt(max) }), el("span", { text: "now" })]),
            legend(series.map(function (sr) { return { cls: sr.cls, text: sr.name + ": " + (function () { var v = sr.data[sr.data.length - 1]; return v === null || v === undefined ? "—" : fmt(v) }()) } }))
        );
    }

    function charts(h) {
        var r = rates(h);
        var perSec = function (v) { return T.fmtBytes(v) + "/s" };
        lineChart("ins-chart-swap", "Swap In and Out", [
            { name: "In", cls: "ins-line-a", data: r.map(function (x) { return x.swapIn }) },
            { name: "Out", cls: "ins-line-b", data: r.map(function (x) { return x.swapOut }) },
        ], perSec);
        var hasPsi = r.length && r[r.length - 1].psiSome !== null;
        var psiHost = document.getElementById("ins-chart-psi");
        psiHost.hidden = !hasPsi;
        if (hasPsi)
            lineChart("ins-chart-psi", "Memory Pressure (PSI avg10)", [
                { name: "Some", cls: "ins-line-a", data: r.map(function (x) { return x.psiSome }) },
                { name: "Full", cls: "ins-line-b", data: r.map(function (x) { return x.psiFull }) },
            ], function (v) { return v.toFixed(1) + " %" });
        lineChart("ins-chart-zram", "Zram Stored Data and RAM Footprint", [
            { name: "Stored", cls: "ins-line-a", data: r.map(function (x) { return x.zStored }) },
            { name: "RAM used", cls: "ins-line-b", data: r.map(function (x) { return x.zRam }) },
        ], T.fmtBytes);
        lineChart("ins-chart-major", "Major Page Faults", [{ name: "Faults", cls: "ins-line-a", data: r.map(function (x) { return x.major }) }],
                  function (v) { return v.toFixed(1) + "/s" });
        lineChart("ins-chart-avail", "Available Memory", [{ name: "Available", cls: "ins-line-a", data: r.map(function (x) { return x.avail }) }], T.fmtBytes);
    }

    // ---- checklist rendering ----------------------------------------------------------------

    var ICON = { pass: ["✔", "Pass", "ok"], warn: ["▲", "Warning", "warn"], fail: ["✖", "Fail", "bad"], info: ["ℹ", "Info", "info"] };

    function checklist(items) {
        var host = document.getElementById("ins-checklist");
        var visible = items.filter(function (i) { return !dismissed[i.id] });
        var hidden = items.filter(function (i) { return dismissed[i.id] });
        function row(i, isDismissed) {
            var ic = ICON[i.level];
            var actions = [];
            if (i.fix)
                actions.push(T.button(i.fix.label, "secondary", i.fix.run, true));
            if (isDismissed)
                actions.push(T.button("Restore", "link", function () { delete dismissed[i.id]; saveDismissed(); checklist(items) }, true));
            else if (i.level !== "pass")
                actions.push(T.button("Dismiss", "link", function () { dismissed[i.id] = 1; saveDismissed(); checklist(items) }, true));
            return el("li", { class: "ins-check" }, [
                T.badge(ic[0] + " " + ic[1], ic[2]),
                el("div", { class: "ins-check__body" }, [el("strong", { text: i.title }), el("div", { class: "app-muted", text: i.detail })]),
                el("div", { class: "ins-check__actions" }, actions),
            ]);
        }
        var nodes = [el("ul", { class: "ins-checklist" }, visible.map(function (i) { return row(i, false) }))];
        if (!visible.length)
            nodes = [el("p", { class: "app-muted", text: "No checks to show." })];
        if (hidden.length) {
            var toggle = T.button((showDismissed ? "Hide" : "Show") + " Dismissed (" + hidden.length + ")", "link", function () { showDismissed = !showDismissed; checklist(items) }, true);
            nodes.push(toggle);
            if (showDismissed)
                nodes.push(el("ul", { class: "ins-checklist" }, hidden.map(function (i) { return row(i, true) })));
        }
        host.replaceChildren.apply(host, nodes);
    }

    // ---- processes ------------------------------------------------------------------------------

    function fetchProcs() {
        return T.spawn(["/bin/sh", "-c", 'grep -HE "^(Name|VmSwap):" /proc/[0-9]*/status 2>/dev/null; true']).then(function (out) {
            var byPid = {};
            out.split("\n").forEach(function (l) {
                var m = /^\/proc\/(\d+)\/status:(Name|VmSwap):\s*(.*?)\s*$/.exec(l);
                if (!m)
                    return;
                var p = byPid[m[1]] = byPid[m[1]] || { pid: Number(m[1]) };
                if (m[2] === "Name")
                    p.name = m[3];
                else
                    p.swap = num(m[3]) * 1024;
            });
            var rows = Object.keys(byPid).map(function (k) { return byPid[k] }).filter(function (p) { return p.swap > 0 }).slice(0, 2000);
            procTable.setRows(rows);
            document.getElementById("ins-proc-updated").textContent = "Updated " + new Date().toLocaleTimeString() +
                (rows.length ? "" : ". Run as an administrator to see other users' processes.");
        }).catch(function (ex) {
            App.alerts.inline("ins-proc-alert", "danger", "Couldn't list processes", T.errText(ex));
        });
    }


    // ---- stress test -------------------------------------------------------------------------
    // Fills a SCRATCH zram device (never the swap device), sized as a share of the
    // real zram, with a hard RAM cap (mem_limit) enforced by the helper script.
    // It exercises compression and accounting; it does not force real swapping,
    // so the swap in/out charts will not move.

    var MIB = 1048576;
    var stressFields = {};
    var TIP = "Pick a preset, or choose Custom value to type your own.";

    function buildStressForm() {
        stressFields = {
            mode: T.select([{ value: "mixed", label: "Mixed data" }, { value: "compressible", label: "Compressible data" }, { value: "random", label: "Incompressible data" }], "mixed"),
            fill: T.combo(T.opts([["10", "light"], ["25"], ["50", "default"], ["75"], ["100", "as big as your zram"]]), "50", { placeholder: "50", label: "Fill target", tip: TIP }),
            timing: T.combo(T.opts([["10:10", "quick"], ["30:30", "default"], ["30:60", "short write, long hold"], ["60:30", "slow ramp"], ["60:60"], ["120:60", "gentle ramp"], ["300:60", "very gentle"]]), "30:30",
                            { placeholder: "30:30", label: "Write : hold seconds",
                              tip: "Seconds spent writing : seconds holding the data before cleanup. Pick a preset, or choose Custom value and type your own, e.g. 45:15." }),
            chunk: T.combo(T.opts([["4", "smoothest"], ["8"], ["16"], ["32"], ["64"], ["128", "coarse"]]), "", { empty: "(auto, about 30 steps)", placeholder: "16", label: "Write size per step", tip: TIP }),
            cap: T.combo(T.opts([["10", "very safe"], ["25", "default"], ["50", "caution"], ["75", "can freeze the system"]]), "25", { placeholder: "25", label: "RAM cap", tip: TIP }),
        };
        stressFields.mode.querySelector("select").setAttribute("title", "How compressible the written data is.");
        document.getElementById("stress-form").replaceChildren(
            el("form", { class: "pf-v6-c-form tun-fields", novalidate: "", onsubmit: "return false" }, [
                T.field("Data Type", stressFields.mode),
                T.field("Fill Target (% of zram size)", stressFields.fill, "1 to 100. 100 fills a scratch device as big as your zram."),
                T.field("Write : Hold (seconds)", stressFields.timing, "Write 1 to 600 : hold 0 to 600, e.g. 45:15."),
                T.field("Write Size per Step (MiB)", stressFields.chunk, "1 to 256. Auto aims for about 30 steps."),
                T.field("RAM Cap (% of available RAM)", stressFields.cap, "5 to 90. Raising this is what can freeze the machine."),
            ]));
    }

    function readInt(key, lo, hi, name) {
        var raw = T.valueOf(stressFields[key]).trim();
        if (!/^\d+$/.test(raw))
            return { error: name + " must be a whole number." };
        var n = Number(raw);
        if (n < lo || n > hi)
            return { error: name + " must be between " + lo + " and " + hi + "." };
        return { n: n };
    }

    // Validates the form and works out sizes from the latest sample.
    function stressPlan() {
        var s = hist[hist.length - 1];
        if (!s)
            return { error: "Waiting for the first sample..." };
        var total = s.zram.filter(function (z) { return !z.scratch }).reduce(function (a, z) { return a + z.disksize }, 0);
        if (!total)
            return { error: "No active zram swap device to size the test from. Configure one in the ZRAM tab first." };
        var f = readInt("fill", 1, 100, "Fill target");
        var tm = /^\s*(\d+)\s*[:\/]\s*(\d+)\s*$/.exec(T.valueOf(stressFields.timing));
        var w = !tm ? { error: "Write : Hold must look like 30:30 (seconds)." }
            : (Number(tm[1]) < 1 || Number(tm[1]) > 600) ? { error: "Write time must be between 1 and 600 seconds." } : { n: Number(tm[1]) };
        var h = !tm ? { n: 0 } : Number(tm[2]) > 600 ? { error: "Hold time must be between 0 and 600 seconds." } : { n: Number(tm[2]) };
        var c = readInt("cap", 5, 90, "RAM cap");
        var rawChunk = T.valueOf(stressFields.chunk).trim();
        var ch = rawChunk === "" ? { n: 0 } : readInt("chunk", 1, 256, "Write size");
        var bad = [f, w, h, c, ch].filter(function (x) { return x.error })[0];
        if (bad)
            return { error: bad.error };

        var size = Math.floor(total * f.n / 100 / MIB) * MIB;
        var limit = Math.min(size, Math.floor(s.memAvail * c.n / 100 / MIB) * MIB);
        if (size < 64 * MIB)
            return { error: "The scratch device would be under 64 MiB. Raise the fill target (your zram is " + T.fmtBytes(total) + ")." };
        if (limit < 32 * MIB)
            return { error: "The RAM cap works out to under 32 MiB (available: " + T.fmtBytes(s.memAvail) + "). Raise the cap." };
        var chunk = ch.n || Math.min(256, Math.max(1, Math.round(size / MIB / 30)));
        var steps = Math.max(1, Math.floor(size / (chunk * MIB)));
        if (steps > 4096)
            return { error: "That is " + steps + " steps. Raise the write size." };
        var left = s.memAvail - limit;
        return {
            mode: T.valueOf(stressFields.mode), size: size, limit: limit, total: total, avail: s.memAvail, fill: f.n, cap: c.n,
            write: w.n, hold: h.n, chunk: chunk, steps: steps, left: left,
            risky: c.n > 50 || left < 768 * MIB,
        };
    }

    function stressUi(running, text) {
        document.getElementById("stress-start").disabled = running;
        document.getElementById("stress-stop").hidden = !running;
        document.getElementById("stress-reset").disabled = running;
        Array.prototype.forEach.call(document.querySelectorAll("#stress-form select, #stress-form input"), function (n) { n.disabled = running });
        if (text !== undefined)
            document.getElementById("stress-status").textContent = text;
    }

    function stressStart() {
        var plan = stressPlan();
        if (plan.error) {
            App.alerts.inline("stress-alert", "warning", "Can't start the test", plan.error);
            return;
        }
        document.getElementById("stress-alert").replaceChildren();
        var body = [
            "Creates a temporary scratch zram device of " + T.fmtBytes(plan.size) + " (" + plan.fill + " % of your " + T.fmtBytes(plan.total) + " zram) and fills it in " +
                plan.steps + " steps of " + plan.chunk + " MiB over " + plan.write + " s, holds it for " + plan.hold + " s, then removes it. Your real swap is not touched.",
            "RAM use is hard-capped at " + T.fmtBytes(plan.limit) + " (" + plan.cap + " % of the " + T.fmtBytes(plan.avail) + " available). Worst case, with incompressible data, " +
                T.fmtBytes(Math.max(0, plan.left)) + " stays available.",
        ];
        if (plan.risky)
            body.push(el("p", { class: "app-modal__status", text: "This is an aggressive setting: less than 768 MiB would stay free, or the cap is above 50 %." }));
        body.push(el("p", {}, [el("strong", { text: "Warning: " }),
            document.createTextNode("improper settings (a high RAM cap, large fills of incompressible data, a short write duration) can freeze the system and require a hardware reboot.")]));
        App.modals.confirm({
            title: "Run Zram Stress Test",
            body: body,
            buttons: [
                { label: plan.risky ? "Start Anyway" : "Start", variant: plan.risky ? "danger" : "primary", action: function (m) { m.close(); stressRun(plan) } },
                { label: "Cancel", variant: "link", action: function (m) { m.close() } },
            ],
            focus: 1,
        });
    }

    function stressRun(plan) {
        stressUi(true, "Starting...");
        var proc = cockpit.spawn(["/bin/sh", STRESS_SCRIPT, plan.mode, String(plan.size), String(plan.limit), String(plan.chunk), String(plan.write), String(plan.hold)],
                                 { err: "message", superuser: "require" });
        stressProc = proc;
        proc.stream(function (data) {
            data.split("\n").forEach(function (l) {
                var d = /^device (zram\d+)$/.exec(l);
                if (d)
                    stressDev = d[1];
                if (/^(step|holding|limit|cleaned|done)/.test(l))
                    document.getElementById("stress-status").textContent = l;
            });
        });
        function finish(msg, failed) {
            stressDev = null;
            stressProc = null;
            stressUi(false, msg);
            if (failed)
                App.alerts.inline("stress-alert", "danger", "Stress test failed", msg);
            else
                App.alerts.toast("success", "Stress test finished", { description: "The scratch device was removed." });
            if (poller)
                poller.refresh();
        }
        proc.then(function () { finish("Finished. The scratch device was removed.", false) },
                  function (ex) {
                      var stopped = ex && ex.problem === "terminated";
                      finish(stopped ? "Stopped. The scratch device was removed." : T.errText(ex), !stopped);
                  });
    }

    function stressStop() {
        if (stressProc)
            stressProc.close("terminate");
    }

    // ---- lifecycle -----------------------------------------------------------------------------------

    function tick() {
        return takeSample().then(function (s) {
            hist.push(s);
            if (hist.length > MAX_SAMPLES + 1)
                hist.shift();
            memoryBars(s);
            efficiency(s);
            charts(hist);
            checklist(evaluate(hist));
            document.getElementById("ins-updated").textContent = "Updated " + new Date().toLocaleTimeString() + ", every " + SAMPLE_MS / 1000 + " s";
        }).catch(function (ex) {
            App.alerts.inline("ins-alert", "danger", "Couldn't read memory statistics", T.errText(ex));
        });
    }

    function init() {
        inited = true;
        procTable = App.table.create({
            container: "ins-proc-table",
            caption: "Processes using swap",
            columns: [
                { key: "pid", label: "PID", numeric: true },
                { key: "name", label: "Process" },
                { key: "swap", label: "Swapped", numeric: true, format: T.fmtBytes },
            ],
            sort: { key: "swap", dir: "desc" },
            emptyText: "No process is using swap",
        });
        document.getElementById("ins-proc-refresh").addEventListener("click", fetchProcs);
        buildStressForm();
        document.getElementById("stress-reset").addEventListener("click", buildStressForm);
        document.getElementById("stress-start").addEventListener("click", stressStart);
        document.getElementById("stress-stop").addEventListener("click", stressStop);
        stressUi(false, "");
        T.spawn(["getconf", "PAGESIZE"]).then(function (o) { pageSize = num(o) || 4096 }, function () {});
    }

    T.insights = {
        show: function () {
            if (!inited)
                init();
            T.memory.show();
            if (!poller)
                poller = App.poll(tick, SAMPLE_MS);
            if (!procPoller)
                procPoller = App.poll(fetchProcs, 10000);
        },
        hide: function () {
            if (poller)
                poller.stop();
            if (procPoller)
                procPoller.stop();
            poller = null;
            procPoller = null;
        },
    };
}());
