import argparse
import ctypes
import os
import sys
import time

import libusb_package
import usb1

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import gcu  # noqa: E402  tools/ is put on the path just above

PAYLOAD = 37
REPORT_ID = 0x21
TIMEOUT_MS = 32
SLOW_MS = 15.0
SLOW_STREAK_LIMIT = 80
ERROR_STREAK_LIMIT = 100
HIGH_PRIORITY_CLASS = 0x80


def open_adapter():
    raw = ctypes.CDLL(str(libusb_package.get_library_path()))
    usb1.loadLibrary(raw)
    ctx = usb1.USBContext()
    try:
        ctx.open()
    except AttributeError:
        pass
    handle = ctx.openByVendorIDAndProductID(0x057E, 0x0337)
    if handle is None:
        sys.exit('No controller in Slippi mode (057e:0337). Switch with  gcu.py mode slippi , and close Dolphin.')
    eps, adapter_itf, cfg_itf = {}, None, None
    dolphin_in = dolphin_out = None
    for setting in handle.getDevice()[0]:
        for alt in setting:
            n = alt.getNumber()
            for e in alt:
                eps.setdefault(n, []).append(e.getAddress())
                if e.getAddress() & 0x80:
                    dolphin_in = e.getAddress()
                else:
                    dolphin_out = e.getAddress()
            if alt.getClass() == 0xFF:
                cfg_itf = n
            elif adapter_itf is None:
                adapter_itf = n
    handle.claimInterface(adapter_itf)
    if cfg_itf is not None:
        handle.claimInterface(cfg_itf)
    ad_in = next(a for a in eps[adapter_itf] if a & 0x80)
    ad_out = next((a for a in eps[adapter_itf] if not a & 0x80), None)
    if (dolphin_in, dolphin_out) != (ad_in, ad_out):
        handle.close()
        sys.exit(f'FAIL: Dolphin keeps the last endpoints listed, {dolphin_in:#04x} and {dolphin_out:#04x}, but the '
                 f'adapter is {ad_in:#04x} and {ad_out:#04x}. Dolphin would read the config interface.')
    cfg = None
    if cfg_itf is not None:
        cfg = (next(a for a in eps[cfg_itf] if a & 0x80), next(a for a in eps[cfg_itf] if not a & 0x80))
    return ctx, handle, adapter_itf, cfg_itf, ad_in, ad_out, cfg


def command(handle, cfg, sub, *args):
    cf_in, cf_out = cfg
    data = bytes([gcu.ID_TECHCHASE, sub, *args])
    handle.bulkWrite(cf_out, data + bytes(64 - len(data)), timeout=1000)
    end = time.monotonic() + 1.5
    while time.monotonic() < end:
        try:
            r = handle.bulkRead(cf_in, 64, timeout=20)
        except usb1.USBErrorTimeout:
            continue
        if len(r) >= 2 and r[0] == gcu.ID_TECHCHASE and r[1] == sub:
            return r
    raise RuntimeError('no reply on the config interface')


def poll(handle, ad_in, seconds):
    s = {'reads': 0, 'timeouts': 0, 'errors': 0, 'bad_size': 0, 'bad_id': 0, 'port_empty': 0, 'slow': 0,
         'slow_streak_max': 0, 'error_streak_max': 0, 'longest_ms': 0.0, 'empty_flips': 0, 'stalls': []}
    slow_streak = error_streak = 0
    was_empty = None
    start = time.perf_counter()
    end = start + seconds
    while time.perf_counter() < end:
        t0 = time.perf_counter()
        try:
            data = handle.interruptRead(ad_in, PAYLOAD, timeout=TIMEOUT_MS)
            ok = True
        except usb1.USBErrorTimeout:
            s['timeouts'] += 1
            ok = False
        except usb1.USBError:
            s['errors'] += 1
            ok = False
        ms = (time.perf_counter() - t0) * 1000.0
        s['longest_ms'] = max(s['longest_ms'], ms)
        if ms > SLOW_MS:
            if not slow_streak:
                s['stalls'].append(t0 - start)
            s['slow'] += 1
            slow_streak += 1
        else:
            slow_streak = 0
        s['slow_streak_max'] = max(s['slow_streak_max'], slow_streak)
        error_streak = 0 if ok else error_streak + 1
        s['error_streak_max'] = max(s['error_streak_max'], error_streak)
        if not ok:
            continue
        s['reads'] += 1
        if len(data) != PAYLOAD:
            s['bad_size'] += 1
            continue
        if data[0] != REPORT_ID:
            s['bad_id'] += 1
            continue
        empty = (data[1] >> 4) == 0
        s['port_empty'] += empty
        if was_empty is not None and empty != was_empty:
            s['empty_flips'] += 1
        was_empty = empty
    s['reads_per_s'] = s['reads'] / seconds
    return s


def verdict(s):
    problems = []
    for key, what in (('timeouts', 'reads timed out'), ('errors', 'reads failed'), ('bad_size', 'reports were not 37 bytes'),
                      ('bad_id', 'reports did not start with 0x21'), ('port_empty', 'reports showed port 1 empty')):
        if s[key]:
            problems.append(f'{s[key]} {what}')
    if s['slow_streak_max'] > SLOW_STREAK_LIMIT:
        problems.append(f'{s["slow_streak_max"]} slow reads in a row (Slippi calls over {SLOW_STREAK_LIMIT} a reduced rate)')
    if s['error_streak_max'] >= ERROR_STREAK_LIMIT:
        problems.append(f'{s["error_streak_max"]} failed reads in a row (Slippi resets the adapter at {ERROR_STREAK_LIMIT})')
    return problems


def main():
    ap = argparse.ArgumentParser(description='Polls a controller in Slippi mode the way Slippi Dolphin does: one '
                                             f'read at a time, {TIMEOUT_MS} ms timeout, no RAW_IO, no pause between '
                                             'reads. Fails on anything Dolphin would see as a dropped or slow adapter.')
    ap.add_argument('--seconds', type=float, default=30)
    ap.add_argument('--no-switch', action='store_true', help='poll once, sending the controller no commands')
    a = ap.parse_args()

    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), HIGH_PRIORITY_CLASS)
    ctx, handle, adapter_itf, cfg_itf, ad_in, ad_out, cfg = open_adapter()
    if ad_out:
        handle.interruptWrite(ad_out, bytes([0x13]), timeout=500)

    phases = [('as set', None)] if cfg is None or a.no_switch else [('late-latch on', 1), ('late-latch off', 0)]
    if cfg is None:
        print('No config interface, as it should be in Slippi mode, so late-latch stays as it is.')
    failures = 0
    try:
        for label, on in phases:
            if on is not None:
                command(handle, cfg, gcu.T_LATCH, on)
            s = poll(handle, ad_in, a.seconds)
            problems = verdict(s)
            failures += bool(problems)
            print(f'{label:15s} {s["reads_per_s"]:6.0f} reads/s  longest {s["longest_ms"]:5.1f} ms  slow {s["slow"]}'
                  f' (streak {s["slow_streak_max"]})  timeouts {s["timeouts"]}  errors {s["errors"]}'
                  f'  port 1 empty {s["port_empty"]} (flips {s["empty_flips"]})')
            if s['stalls']:
                print(f'{"":15s} stalls began at ' + ', '.join(f'{t:.2f} s' for t in s['stalls'][:12]))
            print(f'{"":15s} {"FAIL: " + "; ".join(problems) if problems else "PASS"}')
    finally:
        if cfg is not None and not a.no_switch:
            try:
                command(handle, cfg, gcu.T_LATCH, 1)
            except Exception as e:
                print(f'could not turn late-latch back on: {e}')
        for i in (adapter_itf, cfg_itf):
            if i is not None:
                handle.releaseInterface(i)
        handle.close()
    print('all passed' if not failures else f'{failures} FAILED')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
