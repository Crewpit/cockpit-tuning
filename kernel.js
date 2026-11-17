(function () {
    "use strict";

    // Kernel tab: sysctl catalogue + search, Live / Persisted / Typical columns,
    // and the shared try-live flow (T.tryLive) that Presets, ZRAM and Insights reuse.

    var T = Tuning;
    var el = App.el;

    // key, description, range/values, risk, typical default.
    // Defaults are typical, not guaranteed: many depend on kernel version and RAM.
    var C = [
        // vm.*
        ["vm.swappiness", "How eagerly the kernel swaps anonymous memory versus dropping file cache. Higher values favour swap, which suits zram.", "0 to 200", "low", "60"],
        ["vm.vfs_cache_pressure", "Tendency to reclaim dentry/inode caches. Lower keeps them longer.", "1 to 1000", "low", "100"],
        ["vm.dirty_ratio", "Percent of memory dirty pages may reach before writers block.", "1 to 100", "med", "20"],
        ["vm.dirty_background_ratio", "Percent of memory at which background writeback starts.", "1 to 100", "low", "10"],
        ["vm.dirty_expire_centisecs", "Age (1/100 s) after which dirty data must be written.", "100 to 30000", "low", "3000"],
        ["vm.dirty_writeback_centisecs", "Interval (1/100 s) of the writeback threads. 0 disables periodic writeback.", "0 to 6000", "low", "500"],
        ["vm.overcommit_memory", "0 heuristic, 1 always allow, 2 strict accounting.", "0, 1, 2", "med", "0"],
        ["vm.overcommit_ratio", "With overcommit_memory=2: percent of RAM counted towards the commit limit.", "0 to 200", "med", "50"],
        ["vm.min_free_kbytes", "Memory (KiB) the kernel keeps free. Too low risks stalls, too high wastes RAM.", "KiB, scales with RAM", "high", "varies"],
        ["vm.max_map_count", "Maximum memory mappings per process. Databases and search engines raise it.", "65530 and up", "low", "65530"],
        ["vm.page-cluster", "Pages read ahead on swap-in as a power of two. 0 is best for zram.", "0 to 6", "low", "3"],
        ["vm.watermark_scale_factor", "Distance between reclaim watermarks (1/10000 of memory).", "1 to 3000", "med", "10"],
        ["vm.compaction_proactiveness", "How hard the kernel compacts memory in the background.", "0 to 100", "low", "20"],
        ["vm.panic_on_oom", "Panic instead of killing a process when out of memory.", "0, 1, 2", "high", "0"],
        // net.*
        ["net.core.somaxconn", "Maximum listen() backlog per socket.", "128 to 65535", "low", "4096"],
        ["net.core.netdev_max_backlog", "Packets queued per CPU when the NIC is faster than the kernel.", "1000 to 250000", "low", "1000"],
        ["net.core.rmem_max", "Maximum socket receive buffer (bytes).", "bytes", "low", "212992"],
        ["net.core.wmem_max", "Maximum socket send buffer (bytes).", "bytes", "low", "212992"],
        ["net.ipv4.tcp_rmem", "TCP receive buffer: min, default, max (bytes).", "three integers", "low", "4096 131072 6291456"],
        ["net.ipv4.tcp_wmem", "TCP send buffer: min, default, max (bytes).", "three integers", "low", "4096 16384 4194304"],
        ["net.ipv4.tcp_congestion_control", "TCP congestion control algorithm. bbr needs the tcp_bbr module.", "cubic, bbr, ...", "med", "cubic"],
        ["net.core.default_qdisc", "Default queueing discipline. fq pairs with bbr.", "fq_codel, fq, ...", "med", "fq_codel"],
        ["net.ipv4.tcp_fastopen", "TCP Fast Open bit mask: 1 client, 2 server, 3 both.", "0 to 3", "low", "1"],
        ["net.ipv4.tcp_tw_reuse", "Reuse TIME-WAIT sockets for new outgoing connections.", "0, 1, 2", "low", "2"],
        ["net.ipv4.ip_local_port_range", "Ephemeral port range for outgoing connections.", "two ports", "low", "32768 60999"],
        ["net.ipv4.tcp_max_syn_backlog", "Queue of half-open connections.", "128 to 262144", "low", "varies"],
        ["net.ipv4.tcp_syncookies", "SYN flood protection.", "0, 1, 2", "med", "1"],
        ["net.ipv4.ip_forward", "Route packets between interfaces.", "0, 1", "high", "0"],
        ["net.ipv6.conf.all.forwarding", "IPv6 forwarding for all interfaces.", "0, 1", "high", "0"],
        ["net.ipv4.tcp_slow_start_after_idle", "Reset congestion window after idle. 0 helps bursty long-lived connections.", "0, 1", "low", "1"],
        ["net.ipv4.tcp_mtu_probing", "Probe path MTU when ICMP is blocked.", "0, 1, 2", "low", "0"],
        ["net.ipv4.conf.all.rp_filter", "Reverse-path filtering: 1 strict, 2 loose.", "0, 1, 2", "med", "varies"],
        // fs.*
        ["fs.file-max", "System-wide limit of open file handles.", "integer", "low", "varies"],
        ["fs.nr_open", "Per-process ceiling for open files (upper bound for LimitNOFILE).", "integer", "low", "1048576"],
        ["fs.inotify.max_user_watches", "inotify watches per user. IDEs and sync tools need more.", "integer", "low", "varies"],
        ["fs.inotify.max_user_instances", "inotify instances per user.", "integer", "low", "128"],
        ["fs.aio-max-nr", "Maximum concurrent asynchronous I/O requests.", "integer", "low", "65536"],
        // kernel.*
        ["kernel.pid_max", "Highest process ID. Raise for very many tasks.", "301 to 4194304", "low", "32768 or 4194304"],
        ["kernel.sysrq", "Magic SysRq key functions as a bit mask.", "0, 1, or mask", "med", "varies"],
        ["kernel.panic", "Seconds before rebooting after a panic. 0 waits forever.", "seconds", "med", "0"],
        ["kernel.numa_balancing", "Automatic NUMA page placement.", "0, 1", "low", "1"],
        ["kernel.sched_autogroup_enabled", "Group tasks per session for desktop responsiveness.", "0, 1", "low", "varies"],
        ["kernel.kptr_restrict", "Hide kernel pointers from unprivileged users.", "0, 1, 2", "med", "varies"],
        ["kernel.dmesg_restrict", "Restrict dmesg to privileged users.", "0, 1", "low", "varies"],
        ["kernel.perf_event_paranoid", "Restrict perf events for unprivileged users.", "-1 to 4", "med", "varies"],
    ].map(function (r) {
        return { key: r[0], desc: r[1], range: r[2], risk: r[3], def: r[4] };
    });

    var catalogue = {};
    C.forEach(function (c) { catalogue[c.key] = c });
    T.catalogue = catalogue;

    var live = {};
    var persisted = {};
    var others = {};
    var table = null;
    var loaded = false;
    var searchEl, curatedEl, countEl, updatedEl;
    var ROW_CAP = 500;

    function norm(v) { return String(v).replace(/\s+/g, " ").trim() }

    // ---- reading ------------------------------------------------------------

    function readLive(keys) {
        return T.spawn(["sysctl", "-e"].concat(keys)).then(function (out) {
            var m = {};
            out.split("\n").forEach(function (l) {
                var i = l.indexOf(" = ");
                if (i > 0)
                    m[l.slice(0, i)] = norm(l.slice(i + 3));
            });
            return m;
        });
    }

    function loadAll() {
        return Promise.all([
            T.spawn(["/bin/sh", "-c", "sysctl -a 2>/dev/null; true"]),
            T.read(T.paths.sysctl),
            T.spawn(["/bin/sh", "-c",
                'grep -HvE "^[[:space:]]*([#;]|$)" /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf /lib/sysctl.d/*.conf /etc/sysctl.conf 2>/dev/null; true']),
        ]).then(function (r) {
            live = {};
            r[0].split("\n").forEach(function (l) {
                var i = l.indexOf(" = ");
                if (i > 0)
                    live[l.slice(0, i)] = norm(l.slice(i + 3));
            });
            persisted = {};
            var mine = T.parseConf(r[1]);
            Object.keys(mine).forEach(function (k) { persisted[k.replace(/\//g, ".")] = norm(mine[k]) });
            others = {};
            r[2].split("\n").forEach(function (line) {
                var m = /^([^:]+):\s*-?([A-Za-z0-9_./-]+)\s*=\s*(.*?)\s*$/.exec(line);
                if (!m || m[1] === T.paths.sysctl)
                    return;
                var base = m[1].replace(/^.*\//, "");
                var key = m[2].replace(/\//g, ".");
                if (!others[key] || base >= others[key].base)
                    others[key] = { file: m[1], base: base, value: norm(m[3]) };
            });
            loaded = true;
        });
    }

    // ---- persist / remove -----------------------------------------------------

    // set: {key: value}; remove: [key]. Rewrites only our own drop-in.
    T.persistSysctl = function (set, remove) {
        return T.read(T.paths.sysctl).then(function (text) {
            var map = T.parseConf(text);
            Object.keys(set || {}).forEach(function (k) { map[k] = set[k] });
            (remove || []).forEach(function (k) { delete map[k] });
            var keys = Object.keys(map).sort();
            var content = keys.length
                ? "# Managed by Crewpit Tuning. Edit through Cockpit > Tuning > Kernel.\n" +
                  keys.map(function (k) { return k + " = " + map[k] }).join("\n") + "\n"
                : null;
            return T.writeDropin(T.paths.sysctl, content, content === null ? null : function () {
                return T.spawnRoot(["sysctl", "-p", T.paths.sysctl]);
            });
        });
    };

    // ---- try-live flow ----------------------------------------------------------
    // changes: [{ key, value }]. Previews the diff, applies with `sysctl -w`
    // only, then asks "keep?" for 60 s. Persisting happens only on Keep.
    // If this page is closed mid-countdown nothing reverts live, but nothing is
    // persisted either, so a reboot returns to the previous values.

    T.tryLive = function (changes, opts) {
        opts = opts || {};
        changes = changes.filter(function (c) { return T.validKey(c.key) && T.validValue(c.value) });
        if (!changes.length)
            return;
        var keys = changes.map(function (c) { return c.key });

        readLive(keys).then(function (before) {
            var diff = changes.filter(function (c) { return before[c.key] !== norm(c.value) });
            if (!diff.length) {
                App.alerts.toast("info", "Nothing to change", { description: "These values are already live." });
                return;
            }
            var missing = diff.filter(function (c) { return before[c.key] === undefined });
            var extra = missing.length
                ? [el("p", { class: "app-muted", text: "Not present on this kernel (will fail): " + missing.map(function (c) { return c.key }).join(", ") })]
                : [];
            extra.push(el("p", { class: "app-muted", text: "Applies live first. You then have 60 seconds to keep the changes; otherwise they revert." }));

            T.confirmChanges({
                title: opts.title || "Try Changes Live",
                changes: diff.map(function (c) {
                    return { label: c.key, before: before[c.key] === undefined ? "(absent)" : before[c.key], after: norm(c.value) };
                }),
                extra: extra,
                applyLabel: "Apply Live",
                apply: function () {
                    var args = ["sysctl", "-w"].concat(diff.map(function (c) { return c.key + "=" + c.value }));
                    return T.spawnRoot(args).catch(function (ex) {
                        return revert(diff, before).then(function () { throw ex });
                    });
                },
                done: function () { keepOrRevert(diff, before, opts) },
            });
        }).catch(function (ex) {
            App.alerts.toast("danger", "Couldn't read current values", { description: T.errText(ex) });
        });
    };

    function revert(diff, before) {
        var args = ["sysctl", "-w"];
        diff.forEach(function (c) {
            if (before[c.key] !== undefined)
                args.push(c.key + "=" + before[c.key]);
        });
        return args.length > 2 ? T.spawnRoot(args) : Promise.resolve();
    }

    function keepOrRevert(diff, before, opts) {
        var settled = false;
        var modal = App.modals.notice({
            title: "Keep These Changes?",
            body: [
                "The new values are live. Keep them to persist to " + T.paths.sysctl + ".",
                App.modals.changeList(diff.map(function (c) {
                    return { label: c.key, before: before[c.key] === undefined ? "(absent)" : before[c.key], after: norm(c.value) };
                })),
            ],
            seconds: 60,
            closable: false,
            countdownText: function (n) { return "Reverting automatically in " + n + " sec" },
            onTimeout: function () {
                if (settled)
                    return;
                settled = true;
                revert(diff, before).then(function () {
                    App.alerts.toast("warning", "Changes reverted", { description: "The 60 second window ended without confirmation." });
                    refreshIfVisible();
                }, function (ex) {
                    App.alerts.toast("danger", "Revert failed", { description: T.errText(ex) });
                });
            },
        });

        var keep = T.button("Keep", "primary", function () {
            settled = true;
            modal.setStatus("Saving...");
            var set = {};
            diff.forEach(function (c) { set[c.key] = norm(c.value) });
            T.persistSysctl(set).then(function () {
                modal.close();
                App.alerts.toast("success", "Changes kept", { description: "Persisted to " + T.paths.sysctl });
                if (opts.onKept)
                    opts.onKept();
                refreshIfVisible();
            }, function (ex) {
                settled = false; // countdown keeps running and will revert
                modal.setStatus("Could not persist: " + T.errText(ex));
            });
        });
        var undo = T.button("Revert Now", "link", function () {
            settled = true;
            revert(diff, before).then(function () {
                modal.close();
                App.alerts.toast("info", "Changes reverted");
                refreshIfVisible();
            }, function (ex) {
                modal.setStatus("Revert failed: " + T.errText(ex));
            });
        });
        var footer = modal.box.querySelector(".pf-v6-c-modal-box__footer");
        footer.insertBefore(undo, footer.firstChild);
        footer.insertBefore(keep, footer.firstChild);
        keep.focus();
    }

    // ---- table ------------------------------------------------------------------

    function riskBadge(risk) {
        return T.badge(risk === "high" ? "High Risk" : risk === "med" ? "Medium Risk" : "Low Risk",
                       risk === "high" ? "bad" : risk === "med" ? "warn" : "ok");
    }

    function buildRows() {
        var q = searchEl.value.trim().toLowerCase();
        var keys;
        if (curatedEl.checked)
            keys = C.map(function (c) { return c.key });
        else
            keys = Object.keys(live).sort();
        var rows = [];
        var total = 0;
        keys.forEach(function (k) {
            var c = catalogue[k];
            if (q && k.toLowerCase().indexOf(q) === -1 && !(c && c.desc.toLowerCase().indexOf(q) !== -1))
                return;
            if (!curatedEl.checked && !q && rows.length >= ROW_CAP) {
                total++;
                return;
            }
            total++;
            if (rows.length < ROW_CAP)
                rows.push({
                    key: k,
                    live: live[k] === undefined ? "—" : live[k],
                    persisted: persisted[k] === undefined ? "" : persisted[k],
                    def: c ? c.def : "",
                    risk: c ? c.risk : "",
                    source: persisted[k] !== undefined ? "Crewpit" : (others[k] ? others[k].file.replace(/^.*\//, "") : ""),
                    edit: k,
                });
        });
        countEl.textContent = total > rows.length
            ? "Showing " + rows.length + " of " + total + " keys. Narrow the search to see the rest."
            : rows.length + " keys";
        return rows;
    }

    function renderRows() {
        if (table)
            table.setRows(buildRows());
    }

    function refreshIfVisible() {
        if (table)
            refresh();
    }

    function refresh() {
        return loadAll().then(function () {
            renderRows();
            updatedEl.textContent = "Updated " + new Date().toLocaleTimeString();
        }).catch(function (ex) {
            App.alerts.inline("kernel-alert", "danger", "Couldn't read kernel settings", T.errText(ex));
        });
    }

    // ---- edit modal ----------------------------------------------------------------

    function edit(key) {
        var c = catalogue[key];
        var input = T.input(live[key] === undefined ? "" : live[key]);
        var body = [];
        if (c) {
            body.push(el("p", { text: c.desc }));
            body.push(el("p", { class: "app-muted" }, [
                el("span", { text: "Range: " + c.range + ". Typical default: " + c.def + ". " }), riskBadge(c.risk)]));
        } else {
            body.push(el("p", { class: "app-muted", text: "Not in the curated catalogue. Check the kernel documentation before changing it." }));
        }
        if (others[key] && persisted[key] === undefined)
            body.push(el("p", { class: "app-muted", text: "Also set by " + others[key].file + " (" + others[key].value + "). That file is never modified; " +
                                 "ours is named 90-crewpit.conf, so a later file (for example 99-*) would still override it at boot." }));
        body.push(el("form", { class: "pf-v6-c-form app-settings", novalidate: "", onsubmit: "return false" }, [T.field(key, input)]));

        var buttons = [
            {
                label: "Try Live", variant: "primary", action: function (m) {
                    var value = norm(T.valueOf(input));
                    if (!T.validValue(value) || value === "") {
                        m.setStatus("Enter a value without line breaks.");
                        return;
                    }
                    m.close();
                    T.tryLive([{ key: key, value: value }]);
                },
            },
        ];
        if (persisted[key] !== undefined)
            buttons.push({
                label: "Remove Persisted", variant: "danger", action: function (m) {
                    m.setStatus("Removing...");
                    return T.persistSysctl({}, [key]).then(function () {
                        m.close();
                        App.alerts.toast("success", "Removed " + key + " from " + T.paths.sysctl, { description: "The live value stays until reboot." });
                        refresh();
                    }, function (ex) { m.setStatus("Failed: " + T.errText(ex)) });
                },
            });
        buttons.push({ label: "Cancel", variant: "link", action: function (m) { m.close() } });
        App.modals.confirm({ title: "Edit " + key, body: body, buttons: buttons, focus: buttons.length - 1 });
    }

    // ---- init -----------------------------------------------------------------------

    function init() {
        searchEl = document.getElementById("kernel-search");
        curatedEl = document.getElementById("kernel-curated");
        countEl = document.getElementById("kernel-count");
        updatedEl = document.getElementById("kernel-updated");

        table = App.table.create({
            container: "kernel-table",
            caption: "Kernel parameters",
            columns: [
                { key: "key", label: "Key", render: function (v) { return el("span", { class: "app-mono", text: v }) } },
                {
                    key: "live", label: "Live", render: function (v, row) {
                        var differs = row.persisted !== "" && row.persisted !== row.live;
                        return el("span", {}, [el("span", { class: "app-mono", text: v })].concat(
                            differs ? [document.createTextNode(" "), T.badge("Differs", "warn")] : []));
                    },
                },
                { key: "persisted", label: "Persisted", render: function (v) { return el("span", { class: "app-mono", text: v === "" ? "—" : v }) } },
                { key: "def", label: "Typical Default", render: function (v) { return el("span", { class: "app-mono", text: v === "" ? "—" : v }) } },
                { key: "risk", label: "Risk", render: function (v) { return v ? riskBadge(v) : document.createTextNode("") } },
                { key: "source", label: "Set By" },
                {
                    key: "edit", label: "", sortable: false, render: function (v) {
                        return T.button("Edit", "secondary", function () { edit(v) }, true);
                    },
                },
            ],
            sort: { key: "key", dir: "asc" },
            emptyText: "Loading...",
        });

        searchEl.addEventListener("input", renderRows);
        curatedEl.addEventListener("change", renderRows);
        document.getElementById("kernel-refresh").addEventListener("click", refresh);
    }

    T.kernel = {
        show: function () {
            if (!table)
                init();
            if (!loaded)
                refresh();
        },
        hide: function () {},
        refresh: refresh,
    };
}());
