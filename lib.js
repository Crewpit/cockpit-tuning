(function () {
    "use strict";

    // Shared helpers for every tab: reads, safe drop-in writes, formatting.
    // Exposed as window.Tuning.

    var T = {};
    var el = App.el;

    T.paths = {
        sysctl: "/etc/sysctl.d/90-crewpit.conf",
        zram: "/etc/systemd/zram-generator.conf.d/90-crewpit.conf",
        unitDropin: function (unit) { return "/etc/systemd/system/" + unit + ".d/crewpit-limits.conf" },
    };

    function errText(ex) {
        return (ex && (ex.message || ex.problem)) || String(ex);
    }
    T.errText = errText;

    // Reads use superuser "try": works unprivileged, sees more as root.
    T.spawn = function (argv, opts) {
        return cockpit.spawn(argv, Object.assign({ err: "message", superuser: "try" }, opts || {}));
    };

    // Writes need root. A clear message instead of a bare "access-denied".
    T.spawnRoot = function (argv, opts) {
        return cockpit.spawn(argv, Object.assign({ err: "message", superuser: "require" }, opts || {}))
                .catch(function (ex) {
                    if (ex && ex.problem === "access-denied")
                        ex.message = "Administrative access is required. Use the privilege button in the Cockpit header.";
                    throw ex;
                });
    };

    // Resolves with file text, or null when the file does not exist.
    T.read = function (path) {
        return cockpit.file(path, { superuser: "try" }).read().then(function (text) {
            return text === undefined ? null : text;
        }, function () { return null });
    };

    function stamp() {
        var d = new Date();
        function p(n) { return String(n).padStart(2, "0") }
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    // Safe write of one of OUR drop-in files:
    //   timestamped backup -> write -> validate() -> on failure restore + rethrow.
    // validate: function() -> promise (rejects with stderr on failure). Optional.
    // content === null removes the drop-in (after the backup).
    T.writeDropin = function (path, content, validate) {
        var dir = path.replace(/\/[^/]*$/, "");
        var backup = null;

        function restore(ex) {
            var undo = backup
                ? T.spawnRoot(["cp", "-p", backup, path])
                : T.spawnRoot(["rm", "-f", path]);
            return undo.then(function () { throw ex }, function (ex2) {
                ex.message = errText(ex) + " (restore also failed: " + errText(ex2) + ")";
                throw ex;
            });
        }

        return T.read(path).then(function (old) {
            backup = old === null ? null : path + ".bak-" + stamp();
            return T.spawnRoot(["mkdir", "-p", dir]).then(function () {
                return backup ? T.spawnRoot(["cp", "-p", path, backup]) : null;
            });
        }).then(function () {
            if (content === null)
                return T.spawnRoot(["rm", "-f", path]);
            return cockpit.file(path, { superuser: "require" }).replace(content);
        }).then(function () {
            return validate ? validate() : null;
        }).then(function () {
            // Keep the 5 newest backups of this file.
            return T.spawnRoot(["/bin/sh", "-c",
                'ls -1t "$1".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f --; true', "sh", path]).catch(function () {});
        }, restore);
    };

    // Modal with a "label: before -> after" list, optional extra nodes, and
    // Apply / Cancel. apply() returns a promise; failures show in the status
    // line and keep the modal open so nothing is lost.
    T.confirmChanges = function (opts) {
        var body = [].concat(opts.intro ? [opts.intro] : [], [App.modals.changeList(opts.changes)], opts.extra || []);
        return App.modals.confirm({
            title: opts.title,
            body: body,
            size: opts.size || "md",
            buttons: [
                {
                    label: opts.applyLabel || "Apply", variant: opts.danger ? "danger" : "primary",
                    action: function (m) {
                        m.setStatus("Applying...");
                        return Promise.resolve().then(opts.apply).then(function (msg) {
                            m.close();
                            if (opts.done)
                                opts.done(msg);
                        }, function (ex) {
                            m.setStatus("Failed: " + errText(ex));
                        });
                    },
                },
                { label: "Cancel", variant: "link", action: function (m) { m.close() } },
            ],
            focus: 1,
        });
    };

    // ---- parsing -------------------------------------------------------

    // "key = value" / "key=value" lines; ignores # and ; comments.
    T.parseConf = function (text) {
        var out = {};
        (text || "").split("\n").forEach(function (line) {
            var m = /^\s*([A-Za-z0-9_.\-/]+)\s*=\s*(.*?)\s*$/.exec(line);
            if (m && !/^\s*[#;]/.test(line))
                out[m[1]] = m[2];
        });
        return out;
    };

    T.parseKV = function (text) {
        var out = {};
        (text || "").split("\n").forEach(function (line) {
            var i = line.indexOf(":");
            if (i > 0)
                out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        return out;
    };

    // ---- formatting (IEC units for memory: KiB/MiB/GiB) ------------------

    T.fmtBytes = function (n) {
        if (n === null || n === undefined || isNaN(n))
            return "—";
        var units = ["B", "KiB", "MiB", "GiB", "TiB"];
        var i = 0;
        while (Math.abs(n) >= 1024 && i < units.length - 1) {
            n /= 1024;
            i++;
        }
        return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1)) + " " + units[i];
    };

    T.fmtPct = function (v) {
        return isNaN(v) ? "—" : v.toFixed(v >= 10 ? 0 : 1) + " %";
    };

    // Strict allow-lists keep user input out of file syntax and argv.
    T.validKey = function (k) { return /^[A-Za-z0-9_.\-/]+$/.test(k) };
    T.validValue = function (v) { return /^[^\n\r\0]*$/.test(v) && v.trim() === v };

    // ---- small UI builders ------------------------------------------------

    T.badge = function (text, kind) {
        var cls = { ok: "pf-m-green", warn: "pf-m-orange", bad: "pf-m-red", info: "pf-m-blue" }[kind] || "";
        return el("span", { class: "pf-v6-c-label pf-m-compact " + cls },
                  [el("span", { class: "pf-v6-c-label__content" }, [el("span", { class: "pf-v6-c-label__text", text: text })])]);
    };

    T.button = function (label, variant, onClick, small) {
        var b = el("button", { class: "pf-v6-c-button pf-m-" + (variant || "secondary") + (small ? " pf-m-small" : ""), type: "button", text: label });
        if (onClick)
            b.addEventListener("click", function () { onClick(b) });
        return b;
    };

    T.field = function (label, control, help) {
        var ctl = [control];
        if (help)
            ctl.push(el("div", { class: "pf-v6-c-helper-text" }, [
                el("div", { class: "pf-v6-c-helper-text__item" }, [el("span", { class: "pf-v6-c-helper-text__item-text", text: help })])]));
        return el("div", { class: "pf-v6-c-form__group" }, [
            el("div", { class: "pf-v6-c-form__group-label" }, [
                el("label", { class: "pf-v6-c-form__label" }, [el("span", { class: "pf-v6-c-form__label-text", text: label })])]),
            el("div", { class: "pf-v6-c-form__group-control" }, ctl),
        ]);
    };

    T.input = function (value, placeholder, type) {
        var i = el("input", { type: type || "text", placeholder: placeholder || "" });
        i.value = value === undefined || value === null ? "" : value;
        return el("span", { class: "pf-v6-c-form-control" }, [i]);
    };

    T.valueOf = function (wrapper) {
        if (wrapper.getValue)
            return wrapper.getValue();
        return wrapper.querySelector("input, select").value;
    };

    // [[value, hint]] -> [{ value, label: "value (hint)" }]; keep hints short.
    T.opts = function (pairs) {
        return pairs.map(function (p) { return { value: p[0], label: p[1] ? p[0] + " (" + p[1] + ")" : p[0] } });
    };

    // Preset dropdown plus a "Custom value" escape hatch that reveals a text box.
    // presets: strings or { value, label }. o: { empty (label for a blank choice),
    // placeholder, tip (tooltip on both controls) }. Read it with T.valueOf().
    var CUSTOM = "__custom__";
    T.combo = function (presets, value, o) {
        o = o || {};
        value = value === undefined || value === null ? "" : String(value);
        var tip = o.tip || "Pick a preset, or choose Custom to type any value.";
        var opts = presets.map(function (p) { return typeof p === "string" ? { value: p, label: p } : p });
        if (o.empty)
            opts.unshift({ value: "", label: o.empty });
        opts.push({ value: CUSTOM, label: "Custom value..." });
        var sel = el("select", { title: tip, "aria-label": o.label || "Preset" });
        opts.forEach(function (p) { sel.appendChild(el("option", { value: p.value, text: p.label })) });
        var inp = el("input", { type: "text", placeholder: o.placeholder || "", title: tip, "aria-label": "Custom value" });
        var known = opts.some(function (p) { return p.value === value && p.value !== CUSTOM });
        sel.value = known ? value : CUSTOM;
        inp.value = known ? "" : value;
        var inpBox = el("span", { class: "pf-v6-c-form-control" }, [inp]);
        function sync() { inpBox.hidden = sel.value !== CUSTOM }
        sel.addEventListener("change", function () {
            sync();
            if (!inpBox.hidden)
                inp.focus();
        });
        sync();
        var wrap = el("span", { class: "tun-combo", title: tip }, [el("span", { class: "pf-v6-c-form-control" }, [sel]), inpBox]);
        wrap.getValue = function () { return sel.value === CUSTOM ? inp.value : sel.value };
        return wrap;
    };

    T.select = function (options, value) {
        var s = el("select");
        options.forEach(function (o) {
            var opt = el("option", { value: o.value !== undefined ? o.value : o, text: o.label || o });
            s.appendChild(opt);
        });
        s.value = value;
        return el("span", { class: "pf-v6-c-form-control" }, [s]);
    };

    // Compact read-only table. cols: [label]; rows: [[string | Node]].
    T.statTable = function (caption, cols, rows) {
        function cell(tag, cls, v, label) {
            var c = el(tag, tag === "th" ? { class: cls, scope: "col" } : { class: cls, "data-label": label || "" });
            if (v && v.nodeType)
                c.appendChild(v);
            else
                c.textContent = v === undefined || v === null ? "" : String(v);
            return c;
        }
        var head = el("tr", { class: "pf-v6-c-table__tr" }, cols.map(function (l) { return cell("th", "pf-v6-c-table__th", l) }));
        var body = rows.map(function (r) {
            return el("tr", { class: "pf-v6-c-table__tr" }, r.map(function (v, i) { return cell("td", "pf-v6-c-table__td", v, cols[i]) }));
        });
        return el("table", { class: "pf-v6-c-table pf-m-compact pf-m-grid-md app-table", role: "grid" }, [
            el("caption", { class: "pf-v6-c-table__caption", text: caption }),
            el("thead", { class: "pf-v6-c-table__thead" }, [head]),
            el("tbody", { class: "pf-v6-c-table__tbody" }, body),
        ]);
    };

    window.Tuning = T;
}());
