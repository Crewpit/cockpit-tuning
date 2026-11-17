(function () {
    "use strict";

    // ZRAM tab: systemd zram-generator only. Config goes to our own drop-in,
    // applied with daemon-reload and a restart of systemd-zram-setup@zramN.

    var T = Tuning;
    var el = App.el;

    var SIZE_PRESETS = T.opts([
        ["ram / 4", "25 % of RAM"], ["ram / 2", "50 % of RAM"], ["ram * 3 / 4", "75 % of RAM"], ["ram", "100 % of RAM"],
        ["min(ram / 2, 4096)", "50 % of RAM, max 4 GiB"], ["min(ram / 2, 8192)", "50 % of RAM, max 8 GiB"], ["min(ram, 8192)", "RAM, max 8 GiB"],
        ["1024", "1 GiB"], ["2048", "2 GiB"], ["4096", "4 GiB"], ["8192", "8 GiB"],
    ]);
    // Rule-of-thumb figures for typical memory contents; real ratios vary with the data.
    var ALGO_INFO = {
        "lzo-rle": "~2:1, very fast, low CPU, usual kernel default", "lzo": "~2:1, fast, low CPU, older",
        "lz4": "~2:1, fastest, lowest CPU", "lz4hc": "~2.3:1, slow to compress, high CPU",
        "zstd": "~2.8:1, best ratio for the CPU, medium CPU", "deflate": "~2.9:1, slowest, high CPU",
        "842": "hardware offload, IBM Power only",
    };
    function algoPresets(list) {
        return list.map(function (a) { return { value: a, label: ALGO_INFO[a] ? a + " (" + ALGO_INFO[a] + ")" : a } });
    }
    var PRIO_PRESETS = T.opts([["100", "default, before disk swap"], ["200", "always first"], ["50", "before disk swap"], ["10", "just before disk swap"], ["0", "above default disk swap"]]);
    var FS_PRESETS = T.opts([["ext4", "general purpose"], ["xfs", "fast, cannot shrink"], ["btrfs", "checksums, compression"]]);
    var MNT_PRESETS = T.opts([["/tmp", "temp files"], ["/var/tmp", "larger temp files"], ["/mnt/zram", "generic mount"]]);
    var TIP = "Pick a preset, or choose Custom value to type anything the generator accepts.";
    function ignore() {}
    var FALLBACK_ALGOS = ["lzo-rle", "lz4", "zstd"];
    var GENERATORS = ["/usr/lib/systemd/system-generators/zram-generator", "/lib/systemd/system-generators/zram-generator"];

    var inited = false;
    var devices = [];
    var configs = {};
    var formHost, devHost;
    var selectedDev = "";
    var lastProbe = null;
    var rebootNeeded = {};

    // ---- INI (our drop-in only) -----------------------------------------------

    function parseIni(text) {
        var out = {};
        var sec = null;
        (text || "").split("\n").forEach(function (l) {
            l = l.trim();
            var s = /^\[([A-Za-z0-9_.@-]+)\]$/.exec(l);
            if (s) {
                sec = s[1];
                out[sec] = out[sec] || {};
                return;
            }
            var kv = /^([a-z-]+)\s*=\s*(.*)$/.exec(l);
            if (sec && kv && l[0] !== "#")
                out[sec][kv[1]] = kv[2];
        });
        return out;
    }

    function serializeIni(cfg) {
        var names = Object.keys(cfg).filter(function (n) { return Object.keys(cfg[n]).length });
        if (!names.length)
            return null;
        return "# Managed by Crewpit Tuning. Edit through Cockpit > Tuning > ZRAM.\n" + names.sort().map(function (n) {
            return "[" + n + "]\n" + Object.keys(cfg[n]).map(function (k) { return k + " = " + cfg[n][k] }).join("\n") + "\n";
        }).join("\n");
    }

    // ---- bring devices down and up ---------------------------------------------------
    // Restarting systemd-zram-setup@ alone fails with EBUSY while the swap is in use,
    // so: swapoff (stop the swap unit), stop the setup unit, reset the device, then start.

    function validDev(d) { return /^zram\d{1,3}$/.test(d) }

    function bringDown(dev) {
        return T.spawnRoot(["systemctl", "stop", "dev-" + dev + ".swap"]).catch(ignore)
                .then(function () { return T.spawnRoot(["systemctl", "stop", "systemd-zram-setup@" + dev + ".service"]).catch(ignore) })
                .then(function () { return T.spawnRoot(["zramctl", "--reset", "/dev/" + dev]).catch(ignore) });
    }

    // The setup unit is ordered After=dev-zramN.device, so the kernel device must already
    // exist or `systemctl start` hangs for 90 s. A stop can remove it, so (re)create it.
    // hot_add hands out the lowest free id, so add until the wanted one exists.
    function ensureDevice(dev) {
        return T.spawnRoot(["/bin/sh", "-c",
            '[ -d /sys/class/zram-control ] || modprobe zram; n=${1#zram}; t=0; ' +
            'while [ ! -d "/sys/block/$1" ] && [ "$t" -le "$n" ]; do cat /sys/class/zram-control/hot_add > /dev/null; t=$((t + 1)); done; ' +
            '[ -d "/sys/block/$1" ] && udevadm settle', "sh", dev]);
    }

    function bringUp(dev, cfg) {
        var setup = "systemd-zram-setup@" + dev + ".service";
        return ensureDevice(dev)
                .then(function () { return T.spawnRoot(["systemctl", "daemon-reload"]) })
                .then(function () { return T.spawnRoot(["systemctl", "reset-failed", setup]).catch(ignore) })
                .then(function () {
                    if (cfg && cfg["fs-type"])
                        return T.spawnRoot(["systemctl", "start", setup]).then(function () {
                            return cfg["mount-point"] ? T.spawnRoot(["systemctl", "start", cfg["mount-point"]]) : null;
                        });
                    return T.spawnRoot(["systemctl", "start", "dev-" + dev + ".swap"]);
                });
    }

    function startNow(dev) {
        if (!validDev(dev))
            return;
        bringUp(dev, configs[dev]).then(function () {
            delete rebootNeeded[dev];
            App.alerts.toast("success", dev + " is active");
            refresh();
        }, function (ex) {
            App.alerts.toast("danger", "Couldn't start " + dev, { description: T.errText(ex) });
            refresh();
        });
    }

    // ---- probes ------------------------------------------------------------------

    function probe() {
        var gen = T.spawn(["/bin/sh", "-c", "for f in " + GENERATORS.join(" ") + "; do test -x $f && echo yes && exit 0; done; echo no; true"]);
        var zswap = T.read("/sys/module/zswap/parameters/enabled");
        var tools = T.spawn(["/bin/sh", "-c", "systemctl is-active zramswap.service 2>/dev/null; true"]);
        // Long options only: -r means --reset in zramctl. Some util-linux builds have no --json.
        var live = T.spawn(["zramctl", "--noheadings", "--raw", "--bytes", "--output", "NAME,DISKSIZE,DATA,COMPR,ALGORITHM,STREAMS,TOTAL,MOUNTPOINT"]).then(function (o) {
            return o.split("\n").filter(function (l) { return l.trim() }).map(function (l) {
                var f = l.split(" ");
                return { name: f[0].replace(/^.*\//, ""), disksize: f[1], data: f[2], compr: f[3], algorithm: f[4], streams: f[5], total: f[6], mountpoint: f.slice(7).join(" ") };
            });
        }, function () { return [] });
        var cfg = T.read(T.paths.zram);
        var mem = T.read("/proc/meminfo");
        return Promise.all([gen, zswap, tools, live, cfg, mem, T.readSwaps().catch(function () { return [] })]).then(function (r) {
            var meminfo = T.parseKV(r[5]);
            return {
                generator: r[0].trim() === "yes",
                zswap: r[1] !== null && /^[Y1]/.test(r[1].trim()),
                zramswap: r[2].trim() === "active",
                devices: r[3],
                config: parseIni(r[4]),
                memTotal: parseInt(meminfo.MemTotal, 10) * 1024,
                memAvail: parseInt(meminfo.MemAvailable, 10) * 1024,
                swaps: r[6],
            };
        });
    }

    function algorithmsFor(dev) {
        return T.read("/sys/block/" + dev + "/comp_algorithm").then(function (t) {
            if (!t)
                return { list: FALLBACK_ALGOS, active: null, known: false };
            var list = t.trim().split(/\s+/).map(function (a) { return a.replace(/[\[\]]/g, "") });
            var m = /\[([^\]]+)\]/.exec(t);
            return { list: list, active: m ? m[1] : null, known: true };
        });
    }

    // ---- rendering -------------------------------------------------------------------

    function warnings(p) {
        var w = [];
        var zr = p.swaps.filter(function (s) { return /zram/.test(s.name) });
        var disk = p.swaps.filter(function (s) { return !/zram/.test(s.name) });
        var maxZ = zr.reduce(function (a, s) { return Math.max(a, s.prio) }, -Infinity);
        disk.forEach(function (d) {
            if (zr.length && d.prio >= maxZ)
                w.push("Disk swap " + d.name + " has priority " + d.prio + ", not below zram's " + maxZ + ". It is used before zram.");
        });
        if (p.zswap && (zr.length || p.devices.length))
            w.push("zswap is enabled alongside zram. They overlap; disable zswap (zswap.enabled=0) to avoid double compression.");
        p.devices.forEach(function (d) {
            if (Number(d.disksize) > p.memTotal)
                w.push(d.name + " is larger than RAM (" + T.fmtBytes(Number(d.disksize)) + " vs " + T.fmtBytes(p.memTotal) + ").");
        });
        return w;
    }

    // What the device runs now (from zramctl and /proc/swaps), overridden by what our
    // drop-in says. This lets a device defined elsewhere (e.g. the distro default) be edited.
    function effective(dev, p) {
        var out = {};
        var d = p.devices.filter(function (x) { return x.name === dev })[0];
        if (d) {
            out["zram-size"] = String(Math.round(Number(d.disksize) / 1048576));
            if (d.algorithm)
                out["compression-algorithm"] = d.algorithm;
            var sw = p.swaps.filter(function (x) { return x.name === "/dev/" + dev })[0];
            if (sw)
                out["swap-priority"] = String(sw.prio);
        }
        var c = configs[dev] || {};
        Object.keys(c).forEach(function (k) { out[k] = c[k] });
        return out;
    }

    function buildSelector(p) {
        var names = {};
        p.devices.forEach(function (d) { names[d.name] = "active" });
        Object.keys(configs).forEach(function (n) { if (!names[n]) names[n] = "configured, not active" });
        if (!Object.keys(names).length)
            names.zram0 = "new";
        var list = Object.keys(names).sort().map(function (n) { return [n, names[n]] });
        if (!/^zram\d{1,3}$/.test(selectedDev))
            selectedDev = list[0][0];
        var combo = T.combo(T.opts(list), selectedDev, { placeholder: "zram1", label: "Device", tip: "Pick a device to edit, or choose Custom value and type a new name such as zram1." });
        combo.addEventListener("change", function () {
            selectedDev = T.valueOf(combo).trim();
            showForm(lastProbe);
        });
        devHost.replaceChildren(T.field("Device to Edit", combo, "Active and configured devices. Choose Custom value to add a new one."));
    }

    function render(p) {
        devices = p.devices;
        configs = p.config;
        var host = document.getElementById("zram-status");
        host.replaceChildren();
        var rb = Object.keys(rebootNeeded);
        if (rb.length) {
            var rbox = el("div", { class: "pf-v6-u-mb-md" });
            host.appendChild(rbox);
            App.alerts.inline(rbox, "danger", "Reboot required",
                rb.map(function (n) { return n + " could not be reloaded live (" + rebootNeeded[n] + ")" }).join("; ") + ". Reboot the machine to finish.");
        }
        if (!p.generator) {
            var gbox = el("div", { class: "pf-v6-u-mb-md" });
            host.appendChild(gbox);
            App.alerts.inline(gbox, "warning", "zram-generator not found",
                "Install systemd-zram-generator (apt) or zram-generator (dnf), then reboot or run systemctl daemon-reload. Config can still be saved here.");
        }

        if (p.zramswap) {
            var box = el("div", { class: "pf-v6-u-mb-md", id: "zram-tools-banner" });
            host.appendChild(box);
            App.alerts.inline(box, "warning", "zram-tools (zramswap) is active",
                "This tab manages zram-generator only, so the device below is read-only here. " + (p.generator
                    ? "You can switch: stop and disable zramswap, then save a zram-generator config below."
                    : "To switch, first install systemd-zram-generator (apt) or zram-generator (dnf); the switch button appears once it is found."));
            if (p.generator)
                box.appendChild(T.button("Switch to zram-generator", "secondary", function (btn) {
                T.confirmChanges({
                    title: "Disable zramswap",
                    changes: [{ label: "zramswap.service", before: "enabled and active", after: "disabled and stopped" }],
                    extra: [el("p", { class: "app-muted", text: "Swapped-out pages move back to RAM when the device is released. Check the Overview first if memory is tight." })],
                    applyLabel: "Disable",
                    apply: function () { return T.spawnRoot(["systemctl", "disable", "--now", "zramswap.service"]) },
                    done: function () { App.alerts.toast("success", "zramswap disabled"); refresh() },
                });
            }));
        }

        var wl = warnings(p);
        if (wl.length) {
            var wbox = el("div", { class: "pf-v6-u-mb-md", id: "zram-warn" });
            host.appendChild(wbox);
            App.alerts.inline(wbox, "warning", wl.length === 1 ? "Configuration conflict" : wl.length + " configuration conflicts", wl.join(" "));
        }

        // Live devices, plus configured devices that are not active yet.
        var rows = devices.map(function (d) {
            return { name: d.name, state: "active", algorithm: d.algorithm, disksize: Number(d.disksize), data: Number(d.data), total: Number(d.total),
                     streams: Number(d.streams), mountpoint: d.mountpoint === "[SWAP]" ? "" : d.mountpoint };
        });
        Object.keys(configs).forEach(function (n) {
            if (devices.some(function (d) { return d.name === n }))
                return;
            var c = configs[n];
            rows.push({ name: n, state: "pending", algorithm: c["compression-algorithm"] || "default", disksize: c["zram-size"] || "", data: "", total: "",
                        streams: "", mountpoint: c["mount-point"] || "" });
        });
        function sz(v) { return typeof v === "number" ? T.fmtBytes(v) : (v === "" ? "—" : String(v)) }
        var tbl = App.table.create({
            container: "zram-devices",
            caption: "zram devices",
            columns: [
                { key: "name", label: "Device", render: function (v) { return el("span", { class: "app-mono", text: v }) } },
                {
                    key: "state", label: "Status", render: function (v) {
                        if (v === "active")
                            return T.badge("Active", "ok");
                        var b = T.badge("Applies on reboot", "warn");
                        b.setAttribute("title", "Saved in the config but not running. It starts at the next boot, or press Start Now.");
                        return b;
                    },
                },
                { key: "algorithm", label: "Algorithm" },
                { key: "disksize", label: "Size", numeric: true, format: sz },
                { key: "data", label: "Stored", numeric: true, format: sz },
                { key: "total", label: "RAM Used", numeric: true, format: sz },
                { key: "streams", label: "Streams", numeric: true },
                { key: "mountpoint", label: "Mount", format: function (v) { return v || "swap" } },
                {
                    key: "act", label: "", sortable: false, render: function (v, row) {
                        var edit = T.button("Edit", "secondary", function () {
                            selectedDev = row.name;
                            buildSelector(lastProbe);
                            showForm(lastProbe);
                            formHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
                        }, true);
                        var box = el("span", { class: "app-btn-group" }, [edit]);
                        if (row.state === "pending")
                            box.appendChild(T.button("Start Now", "secondary", function () { startNow(row.name) }, true));
                        return box;
                    },
                },
            ],
            sort: { key: "name", dir: "asc" },
            emptyText: "No zram devices",
        });
        tbl.setRows(rows);

        buildSelector(p);
        showForm(p);
    }

    function showForm(p) {
        var dev = selectedDev;
        if (!/^zram\d{1,3}$/.test(dev)) {
            formHost.replaceChildren(el("p", { class: "app-muted", text: "Device names look like zram0, zram1." }));
            return;
        }
        algorithmsFor(dev).then(function (alg) {
            var c = effective(dev, p);
            var isLive = p.devices.some(function (d) { return d.name === dev });
            var sizeSel = T.combo(SIZE_PRESETS, c["zram-size"] || "min(ram / 2, 4096)", { placeholder: "min(ram / 2, 4096)", label: "Size", tip: TIP });
            var algoSel = T.combo(algoPresets(alg.list), c["compression-algorithm"] || "", { empty: "(kernel default)", placeholder: "zstd", label: "Compression", tip: TIP + " Ratios are rough, for typical memory; the Overview shows your real one." });
            var prio = T.combo(PRIO_PRESETS, c["swap-priority"] || "100", { placeholder: "100", label: "Swap priority", tip: TIP });
            var fst = T.combo(FS_PRESETS, c["fs-type"] || "", { empty: "(swap)", placeholder: "ext4", label: "Filesystem type", tip: TIP });
            var mnt = T.combo(MNT_PRESETS, c["mount-point"] || "", { empty: "(none)", placeholder: "/mnt/zram", label: "Mount point", tip: TIP });
            var wb = T.input(c["writeback-device"] || "", "/dev/vdb1");
            var fields = { "zram-size": sizeSel, "compression-algorithm": algoSel, "swap-priority": prio, "fs-type": fst, "mount-point": mnt, "writeback-device": wb };

            var form = el("form", { class: "pf-v6-c-form pf-m-horizontal app-settings", novalidate: "", onsubmit: "return false" }, [
                T.field("Size", sizeSel, "Pick a preset or choose Custom value. Plain numbers are MiB; expressions may use ram, e.g. min(ram / 2, 4096)."),
                T.field("Compression", algoSel, (alg.known ? "Kernel list from /sys/block/" + dev + "/comp_algorithm. Active: " + (alg.active || "unknown") + "." : "Device not active yet, so common choices are shown.") + " Custom accepts values like zstd(level=9)."),
                T.field("Swap Priority", prio, "Higher is used first. Keep it above disk swap."),
                T.field("Filesystem Type", fst, "Optional. Set (for example ext4) to use the device as a filesystem instead of swap."),
                T.field("Mount Point", mnt, "Optional, with a filesystem type."),
                T.field("Writeback Device", wb, "Optional block device for idle or incompressible pages."),
            ]);
            var actions = el("div", { class: "app-demo-row pf-v6-u-mt-md" }, [
                T.button("Review and Apply", "primary", function () { review(dev, fields, alg, p) }),
                T.button("Remove Config for " + dev, "link", function () { remove(dev, p) }),
                T.button("Apply Zram-Friendly Kernel Settings", "secondary", function () {
                    T.tryLive([{ key: "vm.swappiness", value: "180" }, { key: "vm.page-cluster", value: "0" }], { title: "Zram-Friendly Kernel Settings" });
                }),
            ]);
            var note = isLive
                ? "Editing " + dev + " (active). The values shown are what it runs now. Apply reloads it immediately."
                : configs[dev] ? "Editing " + dev + " (configured, not active). Apply starts it." : "New device " + dev + ". Apply creates and starts it.";
            formHost.replaceChildren(el("p", { class: "app-muted pf-v6-u-mb-md", text: note }), form, actions);
        });
    }

    // ---- apply ---------------------------------------------------------------------------

    function collect(fields, alg) {
        var out = {};
        var err = null;
        var re = {
            "zram-size": /^[a-z0-9 .+\-*\/(),_%]+$/,
            "compression-algorithm": /^[A-Za-z0-9 _.,=()\/-]+$/,
            "swap-priority": /^-?\d{1,5}$/,
            "fs-type": /^[a-z0-9]+$/,
            "mount-point": /^\/[A-Za-z0-9_.\/-]*$/,
            "writeback-device": /^\/dev\/[A-Za-z0-9_.\/-]+$/,
        };
        Object.keys(fields).forEach(function (k) {
            var v = T.valueOf(fields[k]).trim();
            if (!v)
                return;
            if (!re[k].test(v))
                err = err || ("Invalid value for " + k + ": " + v);
            out[k] = v;
        });
        if (!out["zram-size"])
            err = err || "Size is required.";
        if (out["mount-point"] && !out["fs-type"])
            err = err || "A mount point needs a filesystem type.";
        return { values: out, error: err };
    }

    function review(dev, fields, alg, p) {
        var r = collect(fields, alg);
        if (r.error) {
            App.alerts.inline("zram-alert", "danger", "Check the values", r.error);
            return;
        }
        document.getElementById("zram-alert").replaceChildren();
        var before = effective(dev, p);
        var keys = ["zram-size", "compression-algorithm", "swap-priority", "fs-type", "mount-point", "writeback-device"];
        var changes = keys.filter(function (k) { return (before[k] || "") !== (r.values[k] || "") }).map(function (k) {
            return { label: k, before: before[k] || "(none)", after: r.values[k] || "(none)" };
        });
        if (!changes.length) {
            App.alerts.toast("info", "No changes");
            return;
        }
        var next = JSON.parse(JSON.stringify(configs));
        next[dev] = r.values;
        save(dev, next, changes, p, "Apply zram Config for " + dev);
    }

    function remove(dev, p) {
        if (!configs[dev]) {
            App.alerts.toast("info", "Nothing to remove", { description: dev + " has no config in " + T.paths.zram });
            return;
        }
        var next = JSON.parse(JSON.stringify(configs));
        delete next[dev];
        save(dev, next, [{ label: dev, before: "configured", after: "removed from " + T.paths.zram }], p, "Remove zram Config for " + dev);
    }

    function save(dev, next, changes, p, title) {
        var live = p.devices.filter(function (d) { return d.name === dev })[0];
        var stored = live ? Number(live.data) : 0;
        var blocked = stored > p.memAvail;
        var usage = el("p", { class: blocked ? "" : "app-muted", text: live
            ? "Applying reloads " + dev + " now: " + T.fmtBytes(stored) + " of swapped data moves back to RAM first. Available RAM: " + T.fmtBytes(p.memAvail) + "."
              + (blocked ? " That does not fit, so a live reload is blocked. Free memory first, or use Save Only and reboot." : " If the reload fails, the previous settings are restored.")
            : dev + " is not active yet; it is created when you apply." });
        var content = serializeIni(next);
        var previousText = null;
        var stage = "write";

        function write() {
            return T.read(T.paths.zram).then(function (t) {
                previousText = t;
                return T.writeDropin(T.paths.zram, content, function () { return T.spawnRoot(["systemctl", "daemon-reload"]) });
            });
        }

        // Put the old drop-in back and bring the device up with its old settings.
        function rollback() {
            var oldCfg = parseIni(previousText)[dev] || null;
            return T.writeDropin(T.paths.zram, previousText, function () { return T.spawnRoot(["systemctl", "daemon-reload"]) })
                    .then(function () { return live || oldCfg ? bringUp(dev, oldCfg) : null })
                    .then(function () { return true }, function () { return false });
        }

        App.modals.confirm({
            title: title,
            body: [App.modals.changeList(changes), usage],
            buttons: [
                {
                    label: "Save and Apply Now", variant: "primary", action: function (m) {
                        if (blocked) {
                            m.setStatus("Blocked: not enough free RAM to release " + dev + ". Use Save Only.");
                            return;
                        }
                        m.setStatus("Saving...");
                        stage = "write";
                        return write().then(function () {
                            stage = "apply";
                            m.setStatus("Saved. Reloading " + dev + "...");
                            return (live ? bringDown(dev) : Promise.resolve()).then(function () {
                                return next[dev] ? bringUp(dev, next[dev]) : bringUp(dev, null).catch(ignore);
                            });
                        }).then(function () {
                            delete rebootNeeded[dev];
                            m.close();
                            App.alerts.toast("success", dev + " reloaded with the new settings");
                            refresh().then(function () {
                                // The generator tolerates an algorithm the kernel rejects; compare against what runs.
                                var d = devices.filter(function (x) { return x.name === dev })[0];
                                var want = next[dev] && next[dev]["compression-algorithm"];
                                if (d && want && /^[a-z0-9-]+$/.test(want) && d.algorithm !== want)
                                    App.alerts.toast("warning", "Compression differs from the request", { timeout: 0,
                                        description: dev + " runs " + d.algorithm + ", not " + want + ". The kernel may not support it." });
                            });
                        }, function (ex) {
                            var why = T.errText(ex);
                            if (stage === "write") {
                                m.setStatus("Failed, nothing changed: " + why);
                                return null;
                            }
                            m.setStatus("Reload failed: " + why + ". Restoring the previous settings...");
                            return rollback().then(function (ok) {
                                if (ok) {
                                    m.setStatus("Reload failed: " + why + ". The previous settings were restored and are running; no reboot is needed.");
                                } else {
                                    rebootNeeded[dev] = why;
                                    m.close();
                                    App.alerts.toast("danger", "Reboot required", { description: dev + " could not be reloaded or restored live.", timeout: 0 });
                                }
                                refresh();
                            });
                        });
                    },
                },
                {
                    label: "Save Only (Apply on Reboot)", variant: "secondary", action: function (m) {
                        m.setStatus("Saving...");
                        return write().then(function () {
                            m.close();
                            App.alerts.toast("success", "Config saved", { description: "Applies on reboot, or press Start Now in the table." });
                            refresh();
                        }, function (ex) { m.setStatus("Failed: " + T.errText(ex)) });
                    },
                },
                { label: "Cancel", variant: "link", action: function (m) { m.close() } },
            ],
            focus: 2,
        });
    }

    function refresh() {
        return probe().then(function (p) { lastProbe = p; render(p) }).catch(function (ex) {
            App.alerts.inline("zram-alert", "danger", "Couldn't read zram state", T.errText(ex));
        });
    }

    T.zram = {
        show: function () {
            if (!inited) {
                inited = true;
                formHost = document.getElementById("zram-form");
                devHost = document.getElementById("zram-device-host");
                document.getElementById("zram-refresh").addEventListener("click", refresh);
            }
            refresh();
        },
        hide: function () {},
        probe: probe,
    };
}());
