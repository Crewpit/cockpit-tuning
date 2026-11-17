(function () {
    "use strict";

    // Services tab: per-unit and per-slice resource limits written as a
    // systemd drop-in (crewpit-limits.conf), then daemon-reload.

    var T = Tuning;
    var el = App.el;

    var FIELDS = [
        { key: "CPUQuota", presets: T.opts([["25%", "quarter of a CPU"], ["50%", "half a CPU"], ["100%", "one full CPU"], ["200%", "two CPUs"], ["400%", "four CPUs"]]), label: "CPU Quota", ph: "50%", help: "Share of one CPU, e.g. 50% or 200% for two CPUs.", re: /^\d{1,5}%$/ },
        { key: "MemoryHigh", presets: T.opts([["256M"], ["512M"], ["1G"], ["2G"], ["4G"], ["8G"], ["50%", "half of RAM"], ["75%", "three quarters of RAM"], ["infinity", "no limit"]]), label: "Memory High", ph: "1G", help: "Soft limit: the unit is throttled and reclaimed above it. Suffix K, M, G, T or a percent.", re: /^(\d+[KMGT]?|\d{1,3}%|infinity)$/ },
        { key: "MemoryMax", presets: T.opts([["256M"], ["512M"], ["1G"], ["2G"], ["4G"], ["8G"], ["50%", "half of RAM"], ["75%", "three quarters of RAM"], ["infinity", "no limit"]]), label: "Memory Max", ph: "2G", help: "Hard limit: the OOM killer acts above it.", re: /^(\d+[KMGT]?|\d{1,3}%|infinity)$/ },
        { key: "TasksMax", presets: T.opts([["512", "small service"], ["1024"], ["4096", "typical"], ["16384", "busy server"], ["infinity", "no limit"]]), label: "Tasks Max", ph: "4096", help: "Maximum processes and threads.", re: /^(\d+|\d{1,3}%|infinity)$/ },
        { key: "IOWeight", presets: T.opts([["10", "background"], ["50", "low"], ["100", "default"], ["500", "high"], ["1000", "very high"]]), label: "IO Weight", ph: "100", help: "Relative disk share, 1 to 10000 (default 100).", re: /^\d{1,5}$/ },
        { key: "LimitNOFILE", presets: T.opts([["1024", "classic default"], ["4096"], ["65536", "common for servers"], ["262144"], ["1048576", "databases"], ["infinity", "no limit"]]), label: "Open Files Limit", ph: "65536", help: "Services only. Needs a service restart to take effect.", re: /^(\d+|infinity)$/, serviceOnly: true },
    ];
    var SHOW = ["ActiveState", "MemoryCurrent", "TasksCurrent", "CPUUsageNSec", "MemoryHigh", "MemoryMax", "TasksMax", "IOWeight", "LimitNOFILE", "CPUQuotaPerSecUSec"];

    var unitInput, datalist, formHost, liveHost, current = null, inputs = {};

    function validUnit(u) { return /^[A-Za-z0-9:_.\\@-]+\.(service|slice)$/.test(u) }

    function loadUnits() {
        return T.spawn(["systemctl", "list-units", "--type=service,slice", "--all", "--plain", "--no-legend", "--no-pager"]).then(function (out) {
            datalist.replaceChildren();
            out.split("\n").forEach(function (l) {
                var name = l.trim().split(/\s+/)[0];
                if (name && validUnit(name))
                    datalist.appendChild(el("option", { value: name }));
            });
        }).catch(function (ex) {
            App.alerts.inline("services-alert", "warning", "Couldn't list units", T.errText(ex) + " You can still type a unit name.");
        });
    }

    function fmtNum(v, fn) {
        if (v === undefined || v === "" || v === "[not set]" || /^1844674407370955/.test(v) || v === "infinity")
            return v === "infinity" ? "unlimited" : "—";
        return fn ? fn(Number(v)) : v;
    }

    function showLive(unit) {
        return T.spawn(["systemctl", "show", unit, "--no-pager"].concat(SHOW.map(function (p) { return "-p" + p }))).then(function (out) {
            var p = {};
            out.split("\n").forEach(function (l) {
                var i = l.indexOf("=");
                if (i > 0)
                    p[l.slice(0, i)] = l.slice(i + 1);
            });
            var cpuSec = p.CPUUsageNSec && /^\d+$/.test(p.CPUUsageNSec) && p.CPUUsageNSec !== "18446744073709551615"
                ? (Number(p.CPUUsageNSec) / 1e9).toFixed(1) + " s" : "—";
            var rows = [
                ["State", p.ActiveState || "—"],
                ["Memory In Use", fmtNum(p.MemoryCurrent, T.fmtBytes)],
                ["Tasks In Use", fmtNum(p.TasksCurrent)],
                ["CPU Time Used", cpuSec],
                ["Effective Memory High", fmtNum(p.MemoryHigh, T.fmtBytes)],
                ["Effective Memory Max", fmtNum(p.MemoryMax, T.fmtBytes)],
                ["Effective Tasks Max", fmtNum(p.TasksMax)],
                ["Effective IO Weight", fmtNum(p.IOWeight)],
                ["Effective Open Files", fmtNum(p.LimitNOFILE)],
                ["Effective CPU Quota", p.CPUQuotaPerSecUSec && p.CPUQuotaPerSecUSec !== "infinity" ? p.CPUQuotaPerSecUSec : "unlimited"],
            ];
            liveHost.replaceChildren(el("dl", { class: "pf-v6-c-description-list pf-m-horizontal pf-m-compact" }, rows.map(function (r) {
                return el("div", { class: "pf-v6-c-description-list__group" }, [
                    el("dt", { class: "pf-v6-c-description-list__term" }, [el("span", { class: "pf-v6-c-description-list__text", text: r[0] })]),
                    el("dd", { class: "pf-v6-c-description-list__description" }, [el("div", { class: "pf-v6-c-description-list__text", text: r[1] })]),
                ]);
            })));
            if (/^\s*$/.test(out))
                throw new Error("No such unit");
        });
    }

    function parseDropin(text) {
        var m = {};
        (text || "").split("\n").forEach(function (l) {
            var r = /^([A-Za-z]+)=(.*)$/.exec(l.trim());
            if (r)
                m[r[1]] = r[2];
        });
        return m;
    }

    function select(unit) {
        unit = unit.trim();
        if (!validUnit(unit)) {
            App.alerts.inline("services-alert", "warning", "Not a unit name", "Use a name ending in .service or .slice, e.g. nginx.service or user.slice.");
            return;
        }
        document.getElementById("services-alert").replaceChildren();
        current = unit;
        var isSlice = /\.slice$/.test(unit);

        Promise.all([T.read(T.paths.unitDropin(unit)), showLive(unit).catch(function (ex) {
            liveHost.replaceChildren(el("p", { class: "app-muted", text: "Live values unavailable: " + T.errText(ex) }));
        })]).then(function (r) {
            var saved = parseDropin(r[0]);
            inputs = {};
            var nodes = [];
            FIELDS.forEach(function (f) {
                if (f.serviceOnly && isSlice)
                    return;
                var w = T.combo(f.presets, saved[f.key] || "", { empty: "(no limit)", placeholder: f.ph, label: f.label,
                    tip: "Pick a preset, or choose Custom value to type any value systemd accepts (e.g. " + f.ph + ")." });
                inputs[f.key] = w;
                nodes.push(T.field(f.label, w, f.help));
            });
            var apply = T.button("Review and Apply", "primary", function () { review(saved, isSlice) });
            formHost.replaceChildren(
                el("h3", { class: "app-block__title", text: "Limits for " + unit }),
                el("p", { class: "app-muted", text: "Written to " + T.paths.unitDropin(unit) + ". Leave a field empty for no limit from this file." }),
                el("form", { class: "pf-v6-c-form pf-m-horizontal app-settings", novalidate: "", onsubmit: "return false" }, nodes),
                el("div", { class: "app-demo-row pf-v6-u-mt-md" }, [apply])
            );
        });
    }

    function review(saved, isSlice) {
        var next = {};
        var changes = [];
        var bad = null;
        FIELDS.forEach(function (f) {
            if (!inputs[f.key])
                return;
            var v = T.valueOf(inputs[f.key]).trim();
            if (v && !f.re.test(v))
                bad = bad || (f.label + " looks invalid: " + v);
            if (v)
                next[f.key] = v;
            if ((saved[f.key] || "") !== v)
                changes.push({ label: f.label, before: saved[f.key] || "(none)", after: v || "(none)" });
        });
        if (bad) {
            App.alerts.inline("services-alert", "danger", "Check the values", bad);
            return;
        }
        if (!changes.length) {
            App.alerts.toast("info", "No changes");
            return;
        }
        var unit = current;
        var keys = Object.keys(next);
        var content = keys.length
            ? "# Managed by Crewpit Tuning.\n[" + (isSlice ? "Slice" : "Service") + "]\n" + keys.map(function (k) { return k + "=" + next[k] }).join("\n") + "\n"
            : null;
        T.confirmChanges({
            title: "Apply Limits to " + unit,
            changes: changes,
            extra: [el("p", { class: "app-muted", text: "Runs systemctl daemon-reload. Cgroup limits apply to a running unit immediately; the open files limit needs a restart." })],
            apply: function () {
                return T.writeDropin(T.paths.unitDropin(unit), content, function () {
                    return T.spawnRoot(["systemctl", "daemon-reload"]);
                });
            },
            done: function () {
                App.alerts.toast("success", "Limits saved for " + unit);
                select(unit);
            },
        });
    }

    var inited = false;

    T.services = {
        show: function () {
            if (inited)
                return;
            inited = true;
            unitInput = document.getElementById("services-unit");
            formHost = document.getElementById("services-form");
            liveHost = document.getElementById("services-live");
            datalist = el("datalist", { id: "services-units" });
            unitInput.setAttribute("list", "services-units");
            unitInput.parentNode.appendChild(datalist);
            document.getElementById("services-load").addEventListener("click", function () { select(unitInput.value) });
            unitInput.addEventListener("keydown", function (ev) {
                if (ev.key === "Enter")
                    select(unitInput.value);
            });
            loadUnits();
        },
        hide: function () {},
    };
}());
