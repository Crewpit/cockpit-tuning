(function () {
    "use strict";

    // Overview panel: disk swap (files and partitions) and swappiness.
    // zram devices appear in the table for context but are configured in the ZRAM page.

    var T = Tuning;
    var el = App.el;
    var table = null, slider, sliderValue, current = null, fstabHost, inited = false;

    function parseSwaps(out) {
        return out.split("\n").filter(Boolean).map(function (l) {
            var p = l.trim().split(/\s+/);
            return { name: p[0], type: p[1], size: Number(p[2]), used: Number(p[3]), prio: Number(p[4]) };
        });
    }

    T.readSwaps = function () {
        return T.spawn(["swapon", "--show=NAME,TYPE,SIZE,USED,PRIO", "--bytes", "--noheadings", "--raw"]).then(parseSwaps);
    };

    function refresh() {
        return Promise.all([
            T.readSwaps(),
            T.spawn(["sysctl", "-n", "vm.swappiness"]),
            T.read("/etc/fstab"),
        ]).then(function (r) {
            table.setRows(r[0].map(function (s) {
                return Object.assign({}, s, { kind: /zram/.test(s.name) ? "zram" : s.type, pct: s.size ? s.used / s.size * 100 : 0 });
            }));
            current = Number(r[1].trim());
            slider.value = current;
            sliderValue.textContent = String(current);
            var swapLines = (r[2] || "").split("\n").filter(function (l) { return /^\s*[^#\s]\S*\s+\S+\s+swap\s/.test(l) });
            fstabHost.replaceChildren(swapLines.length
                ? el("ul", {}, swapLines.map(function (l) { return el("li", {}, [el("span", { class: "app-mono", text: l.trim() })]) }))
                : el("p", { class: "app-muted", text: "No swap entries in /etc/fstab." }));
            document.getElementById("memory-updated").textContent = "Updated " + new Date().toLocaleTimeString();
        }).catch(function (ex) {
            App.alerts.inline("memory-alert", "danger", "Couldn't read swap state", T.errText(ex));
        });
    }

    function init() {
        slider = document.getElementById("memory-swappiness");
        sliderValue = document.getElementById("memory-swappiness-value");
        fstabHost = document.getElementById("memory-fstab");
        slider.addEventListener("input", function () { sliderValue.textContent = slider.value });
        document.getElementById("memory-apply").addEventListener("click", function () {
            if (Number(slider.value) === current) {
                App.alerts.toast("info", "Swappiness unchanged");
                return;
            }
            T.tryLive([{ key: "vm.swappiness", value: slider.value }], { onKept: refresh, title: "Try Swappiness Live" });
        });
        document.getElementById("memory-refresh").addEventListener("click", refresh);
        table = App.table.create({
            container: "memory-table",
            caption: "Active swap",
            columns: [
                { key: "name", label: "Device", render: function (v) { return el("span", { class: "app-mono", text: v }) } },
                { key: "kind", label: "Type" },
                { key: "size", label: "Size", numeric: true, format: T.fmtBytes },
                { key: "used", label: "Used", numeric: true, format: T.fmtBytes },
                { key: "pct", label: "Used %", numeric: true, format: T.fmtPct },
                { key: "prio", label: "Priority", numeric: true },
            ],
            sort: { key: "prio", dir: "desc" },
            emptyText: "No active swap",
        });
    }

    T.memory = {
        show: function () {
            if (!inited) {
                inited = true;
                init();
            }
            refresh();
        },
        hide: function () {},
    };
}());
