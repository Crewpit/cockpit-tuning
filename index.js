(function () {
    "use strict";

    // Theme sync happens in theme.js, loaded in index.html's <head>.
    // Shared helpers: functions.js (window.App) and lib.js (window.Tuning).
    // Each tab lives in its own file and exposes show()/hide() on Tuning.

    var T = Tuning;
    var el = App.el;

    function tab(label, path, mod) {
        return { label: label, path: path, pane: "pane-" + path.slice(1), onShow: function () { mod.show() }, onHide: function () { mod.hide() } };
    }

    // Overview = configuration counts + the live Insights panel (checklist, bars, charts, stress test).
    var overview = {
        show: function () {
            showStats();
            T.memory.show();
            T.insights.show();
        },
        hide: function () { T.insights.hide() },
    };

    var MENU = {
        label: "Tuning",
        items: [
            tab("Overview", "/", overview),
            tab("Kernel", "/kernel", T.kernel),
            tab("Services", "/services", T.services),
            tab("ZRAM", "/zram", T.zram),
            tab("Presets", "/presets", T.presets),
        ],
    };
    MENU.items[0].pane = "pane-overview"; // the root route shows pane-overview

    function linked(value, text, href) {
        return el("span", {}, [document.createTextNode(value + " "), el("a", { href: href, text: text })]);
    }

    function showStats() {
        var host = document.getElementById("overview-stats");
        Promise.all([
            T.read(T.paths.sysctl),
            T.spawn(["/bin/sh", "-c", "ls -1 /etc/systemd/system/*.d/crewpit-limits.conf 2>/dev/null; true"]),
            T.read(T.paths.zram),
            T.zram.probe().catch(function () { return null }),
        ]).then(function (r) {
            var tunings = Object.keys(T.parseConf(r[0])).length;
            var limits = r[1].split("\n").filter(Boolean);
            var zramCfg = ((r[2] || "").match(/^\[zram\d+\]/gm) || []).length;
            var live = r[3] ? r[3].devices.length : null;
            host.replaceChildren(T.statTable("Configuration",
                ["Persisted Kernel Tunings", "Units With Limits", "Configured zram Devices", "Active zram Devices"],
                [[linked(tunings, "Kernel", "#/kernel"), linked(limits.length, "Services", "#/services"),
                  linked(zramCfg, "ZRAM", "#/zram"), linked(live === null ? "unknown" : live, "ZRAM", "#/zram")]]));
        });
    }

    App.menu.mount(MENU, {
        nav: "app-menu",
        startExpanded: true,
    });
}());
