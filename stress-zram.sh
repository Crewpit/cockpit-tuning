#!/bin/sh
# Zram stress test helper for cockpit-tuning (run through /bin/sh, as root).
#
# Creates a SCRATCH zram device (never your swap device), fills it in steps so
# the Overview charts can show the ramp, holds, then removes it again.
# Safety: the device gets a hard mem_limit, so writes fail with ENOSPC instead
# of eating RAM, and the limit may not exceed 90 % of MemAvailable. A trap
# removes the device on exit, TERM, INT and HUP.
#
# Usage: stress-zram.sh MODE SIZE_BYTES MEMLIMIT_BYTES CHUNK_MIB WRITE_SECONDS HOLD_SECONDS
#   MODE: mixed | compressible | random
set -eu

MODE=${1:-}
SIZE=${2:-}
LIMIT=${3:-}
CHUNK=${4:-}
WRITE=${5:-}
HOLD=${6:-}

case "$MODE" in mixed|compressible|random) ;; *) echo "bad mode" >&2; exit 2 ;; esac
for v in "$SIZE" "$LIMIT" "$CHUNK" "$WRITE" "$HOLD"; do
    case "$v" in ''|*[!0-9]*) echo "bad number: '$v'" >&2; exit 2 ;; esac
done
if [ "$SIZE" -lt 67108864 ] || [ "$LIMIT" -lt 33554432 ] || [ "$CHUNK" -lt 1 ] || [ "$CHUNK" -gt 256 ] \
   || [ "$WRITE" -lt 1 ] || [ "$WRITE" -gt 600 ] || [ "$HOLD" -gt 600 ]; then
    echo "values out of range" >&2
    exit 2
fi

AVAIL=0
while read -r key val _; do
    [ "$key" = "MemAvailable:" ] && AVAIL=$((val * 1024))
done < /proc/meminfo
if [ "$LIMIT" -gt $((AVAIL / 10 * 9)) ]; then
    echo "refusing: RAM cap is above 90 % of the memory available right now" >&2
    exit 2
fi

BYTES=$((CHUNK * 1048576))
STEPS=$((SIZE / BYTES))
[ "$STEPS" -ge 1 ] || STEPS=1
if [ "$STEPS" -gt 4096 ]; then
    echo "too many steps; raise the write size" >&2
    exit 2
fi
DELAY_MS=$((WRITE * 1000 / STEPS))
DELAY=$(printf '%d.%03d' $((DELAY_MS / 1000)) $((DELAY_MS % 1000)))

[ -d /sys/class/zram-control ] || modprobe zram
ID=$(cat /sys/class/zram-control/hot_add)
DEV=/dev/zram$ID

cleanup() {
    trap - EXIT
    echo 1 > "/sys/block/zram$ID/reset" 2>/dev/null || true
    echo "$ID" > /sys/class/zram-control/hot_remove 2>/dev/null || true
    echo "cleaned up zram$ID"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

# A signal only interrupts `wait`, not a foreground sleep, so nap in the background.
nap() { sleep "$1" & wait $!; }

echo "$LIMIT" > "/sys/block/zram$ID/mem_limit"
echo "$SIZE" > "/sys/block/zram$ID/disksize"
echo "device zram$ID"

chunk() {
    case "$1" in
        random) head -c "$BYTES" /dev/urandom ;;
        *) yes "crewpit zram stress test 0123456789 abcdefghijklmnopqrstuvwxyz" | head -c "$BYTES" ;;
    esac
}

i=0
while [ "$i" -lt "$STEPS" ]; do
    kind=$MODE
    if [ "$MODE" = mixed ]; then
        if [ $((i % 2)) -eq 0 ]; then kind=random; else kind=compressible; fi
    fi
    if ! chunk "$kind" | dd of="$DEV" bs=1M seek=$((i * CHUNK)) oflag=direct iflag=fullblock conv=notrunc status=none 2>/dev/null; then
        echo "limit reached at step $i (mem_limit or device full)"
        break
    fi
    i=$((i + 1))
    echo "step $i/$STEPS"
    nap "$DELAY"
done

echo "holding for $HOLD s"
nap "$HOLD"
echo "done"
