(function () {
    "use strict";

    // Presets tab: bundles of sysctl values applied through the same
    // diff -> try-live -> keep flow as the Kernel tab.

    var T = Tuning;
    var el = App.el;

    var PRESETS = [
        {
            name: "Web Server",
            desc: "Larger accept and SYN queues, wider port range and file handle ceiling for many short connections.",
            values: {
                "net.core.somaxconn": "4096", "net.ipv4.tcp_max_syn_backlog": "8192", "net.core.netdev_max_backlog": "5000",
                "net.ipv4.ip_local_port_range": "1024 65535", "net.ipv4.tcp_tw_reuse": "1", "fs.file-max": "2097152",
            },
        },
        {
            name: "Database",
            desc: "Prefer RAM over swap, smoother writeback, bigger mapping and async I/O limits.",
            values: {
                "vm.swappiness": "10", "vm.dirty_background_ratio": "5", "vm.dirty_ratio": "15",
                "vm.max_map_count": "262144", "fs.aio-max-nr": "1048576", "kernel.numa_balancing": "0",
            },
        },
        {
            name: "Low-Memory VPS",
            desc: "Earlier, smaller writeback bursts and moderate swapping to stay clear of the OOM killer on small machines.",
            values: { "vm.swappiness": "30", "vm.dirty_ratio": "10", "vm.dirty_background_ratio": "5", "vm.vfs_cache_pressure": "100" },
        },
        {
            name: "Laptop",
            desc: "Batch disk writes less often to let storage idle, and keep the desktop responsive under load.",
            values: { "vm.dirty_writeback_centisecs": "1500", "vm.dirty_expire_centisecs": "3000", "kernel.sched_autogroup_enabled": "1" },
        },
        {
            name: "Network-Heavy",
            desc: "BBR congestion control with the fq qdisc and larger buffers for high-throughput links. BBR needs the tcp_bbr module; the preset fails and reverts if it is missing.",
            values: {
                "net.core.default_qdisc": "fq", "net.ipv4.tcp_congestion_control": "bbr",
                "net.core.rmem_max": "16777216", "net.core.wmem_max": "16777216",
                "net.ipv4.tcp_rmem": "4096 87380 16777216", "net.ipv4.tcp_wmem": "4096 65536 16777216",
                "net.core.netdev_max_backlog": "16384", "net.core.somaxconn": "4096",
                "net.ipv4.tcp_fastopen": "3", "net.ipv4.tcp_slow_start_after_idle": "0", "net.ipv4.tcp_mtu_probing": "1",
            },
        },
        {
            name: "Zram-Friendly",
            desc: "Swap early into compressed RAM and skip read-ahead on swap-in. Pair with a zram device from the ZRAM tab.",
            values: { "vm.swappiness": "180", "vm.page-cluster": "0" },
        },
    ];

    var inited = false;

    function render() {
        var host = document.getElementById("presets-list");
        host.replaceChildren.apply(host, PRESETS.map(function (p) {
            var keys = Object.keys(p.values);
            return el("div", { class: "app-block" }, [
                el("div", { class: "app-block__header" }, [el("h2", { class: "app-block__title", text: p.name })]),
                el("p", { text: p.desc }),
                el("ul", { class: "pres-keys" }, keys.map(function (k) {
                    return el("li", {}, [el("span", { class: "app-mono", text: k + " = " + p.values[k] })]);
                })),
                el("div", { class: "app-demo-row pf-v6-u-mt-md" }, [
                    T.button("Review and Try Live", "primary", function () {
                        T.tryLive(keys.map(function (k) { return { key: k, value: p.values[k] } }), { title: "Preset: " + p.name });
                    }),
                ]),
            ]);
        }));
    }

    T.presets = {
        show: function () {
            if (!inited) {
                inited = true;
                render();
            }
        },
        hide: function () {},
    };
}());
