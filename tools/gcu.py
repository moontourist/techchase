#!/usr/bin/env python3
import argparse
import datetime
import json
import struct
import sys
import time

try:
    import usb.core
    import usb.util
    import libusb_package
except ImportError:
    sys.exit("Needs pyusb and libusb-package:  pip install pyusb libusb-package")

ID_READ_CONFIG_BLOCK = 0x01
ID_READ_STATIC_BLOCK = 0x03
ID_TECHCHASE = 0xC0

T_INFO, T_STATS, T_STATS_RESET, T_LATCH, T_ASSIGN, T_RESET_ALL, T_MAP, T_USB_MODE = range(8)

GC_CODES = ['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'Z', 'L', 'R', 'L_ANALOG',
            'R_ANALOG', 'LX_RIGHT', 'LX_LEFT', 'LY_UP', 'LY_DOWN', 'RX_RIGHT', 'RX_LEFT', 'RY_UP',
            'RY_DOWN', 'ZL', 'MINUS', 'HOME', 'CAPTURE', 'C', 'LS', 'RS']
SW_CODES = ['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'L', 'R', 'ZL', 'ZR', 'PLUS', 'MINUS',
            'HOME', 'CAPTURE', 'LS', 'RS', 'LX_RIGHT', 'LX_LEFT', 'LY_UP', 'LY_DOWN', 'RX_RIGHT',
            'RX_LEFT', 'RY_UP', 'RY_DOWN', 'FLICK_UP', 'FLICK_DOWN', 'FLICK_LEFT', 'FLICK_RIGHT']
FORMATS = {0: 'Switch Pro', 1: 'XInput', 2: 'Slippi (GC adapter)', 3: 'GameCube port', 4: 'N64',
           5: 'SNES', 6: 'SInput', 7: 'Wii'}
MODE_ARGS = {'switch': 0, 'slippi': 2, 'sinput': 6}
LATCH_MODES = {0: 'off', 1: 'USB, learning the host poll phase (stock timing)', 2: 'USB late-latch',
               3: 'GameCube port, polls not steady (stock 1 ms timer)', 4: 'GameCube port poll-lock'}
STATS_FMT = '<BBHIIIIIIIII'
STATS_KEYS = ['version', 'mode', 'guard_us', 'count', 'age_min_us', 'age_max_us', 'age_avg_us',
              'misses', 'phase_us', 'lead_us', 'read_us', 'read_max_us']

def code_name(table, code):
    if code is None or code < 0 or code == 0xFF:
        return '-'
    return table[code] if code < len(table) else f'#{code}'

class Pad:
    def __init__(self):
        be = libusb_package.get_libusb1_backend()
        self.dev = None
        for d in usb.core.find(find_all=True, backend=be):
            if d.idVendor not in (0x057E, 0x2E8A):
                continue
            try:
                maker = usb.util.get_string(d, d.iManufacturer) or ''
            except Exception:
                continue
            if maker != 'HHL':
                continue
            for itf in d.get_active_configuration():
                if itf.bInterfaceClass != 0xFF:
                    continue
                ep_in = ep_out = None
                for e in itf:
                    if usb.util.endpoint_type(e.bmAttributes) != usb.util.ENDPOINT_TYPE_BULK:
                        continue
                    if usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN:
                        ep_in = e.bEndpointAddress
                    else:
                        ep_out = e.bEndpointAddress
                if ep_in and ep_out:
                    self.dev, self.itf, self.ep_in, self.ep_out = d, itf.bInterfaceNumber, ep_in, ep_out
                    break
            if self.dev:
                break
        if not self.dev:
            sys.exit("No HOJA controller with its config interface found. Plug it in over USB "
                     "(Slippi mode only has the config interface when switched there by this "
                     "tool or the web app).")
        self.product = usb.util.get_string(self.dev, self.dev.iProduct)
        usb.util.claim_interface(self.dev, self.itf)

    def close(self):
        try:
            usb.util.release_interface(self.dev, self.itf)
        finally:
            usb.util.dispose_resources(self.dev)

    def send(self, *payload):
        data = bytes(payload)
        self.dev.write(self.ep_out, data + bytes(64 - len(data)), timeout=1000)

    def recv(self, want_id, want_sub=None, timeout_s=1.5):
        end = time.monotonic() + timeout_s
        while time.monotonic() < end:
            try:
                r = bytes(self.dev.read(self.ep_in, 64, timeout=300))
            except usb.core.USBTimeoutError:
                continue
            if r and r[0] == want_id and (want_sub is None or r[1] == want_sub):
                return r
        return None

    def command(self, sub, *args, timeout_s=1.5):
        self.send(ID_TECHCHASE, sub, *args)
        r = self.recv(ID_TECHCHASE, sub, timeout_s)
        if r is None:
            raise RuntimeError("No reply to a techchase command: is the controller running the "
                               "techchase firmware?")
        return r

    def read_block(self, read_id, block):
        self.send(read_id, block)
        buf = bytearray()
        end = time.monotonic() + 3
        while time.monotonic() < end:
            r = self.recv(read_id, block, timeout_s=1.0)
            if r is None:
                break
            if r[3] == 0xFF:
                return bytes(buf)
            buf += r[4:4 + r[2]]
        return bytes(buf) if buf else None

def fw_version(pad):
    blk = pad.read_block(ID_READ_STATIC_BLOCK, 0)
    if not blk or len(blk) < 708:
        return None, None
    name = blk[0:16].split(b'\0')[0].decode(errors='replace')
    return name, struct.unpack_from('<I', blk, 704)[0]

def stats(pad):
    r = pad.command(T_STATS)
    return dict(zip(STATS_KEYS, struct.unpack_from(STATS_FMT, r, 2)))

def print_stats(s):
    off = bool(s['mode'] & 0x80)
    mode = LATCH_MODES.get(s['mode'] & 0x7F, '?') + ('  [late-latch switched OFF: stock timing]' if off else '')
    print(f"mode     {mode}")
    if s['count'] == 0:
        print("         no hand-offs measured yet (is a game/emulator polling the controller?)")
        return
    print(f"input age at hand-off  avg {s['age_avg_us']:5d} us   min {s['age_min_us']:5d}   max {s['age_max_us']:5d}"
          f"   ({s['count']} reports, {s['misses']} late)")
    what = 'host poll phase' if (s['mode'] & 0x7F) in (1, 2) else 'poll period'
    print(f"schedule  lead {s['lead_us']} us (guard {s['guard_us']})   {what} {s['phase_us']} us"
          f"   input read {s['read_us']} us (max {s['read_max_us']})")

def resolve(entries, name):
    n = name.strip().upper().replace(' ', '')
    aliases = {'PLUS': 'START', 'JUMP': None}
    for e in entries:
        if e['name'].upper().replace(' ', '') == n:
            return e
    n = aliases.get(n, n) or n
    for e in entries:
        if code_name(GC_CODES, e['gc_def']) == n:
            return e
    sys.exit(f"Unknown button '{name}'. Try one of: " +
             ', '.join(sorted({e['name'] for e in entries} | {code_name(GC_CODES, e['gc_def']) for e in entries} - {'-'})))

def read_map(pad):
    entries = []
    for page in range(9):
        r = pad.command(T_MAP, page)
        count = r[3]
        for i in range(count):
            e = r[4 + i * 13: 4 + (i + 1) * 13]
            if e[0] == 0xFF:
                continue
            signed = [b - 256 if b > 127 else b for b in e[1:5]]
            entries.append({'code': e[0], 'gc_cur': signed[0], 'gc_def': signed[1], 'sw_cur': signed[2],
                            'sw_def': signed[3], 'name': e[5:13].split(b'\0')[0].decode(errors='replace')})
        if count == 0:
            break
    return entries

def cmd_info(pad, a):
    name, fw = fw_version(pad)
    print(f"controller  {pad.product} ({pad.dev.idVendor:04x}:{pad.dev.idProduct:04x})  board name {name}")
    if fw:
        print(f"firmware    {fw}  ({datetime.datetime.fromtimestamp(fw, datetime.timezone.utc):%Y-%m-%d %H:%M} UTC)")
    try:
        r = pad.command(T_INFO)
    except RuntimeError:
        print("techchase   not present (official firmware)")
        return
    print(f"techchase   protocol {r[2]}, late-latch {'on' if r[3] else 'OFF'}, "
          f"USB mode {FORMATS.get(r[5], r[5])}, quick remap {'ON' if r[6] else 'off'}")
    print(f"latch       {LATCH_MODES.get(r[4], r[4])}")

def cmd_backup(pad, a):
    name, fw = fw_version(pad)
    out = {'product': pad.product, 'board': name, 'fw_version': fw,
           'saved': datetime.datetime.now().isoformat(timespec='seconds'), 'config': {}, 'static': {}}
    for b in range(16):
        blk = pad.read_block(ID_READ_CONFIG_BLOCK, b)
        if blk is None:
            break
        out['config'][b] = blk.hex()
    for b in range(16):
        blk = pad.read_block(ID_READ_STATIC_BLOCK, b)
        if blk is None:
            break
        out['static'][b] = blk.hex()
    path = a.file or f"gcu-backup-{fw}-{datetime.datetime.now():%Y%m%d-%H%M%S}.json"
    with open(path, 'w') as f:
        json.dump(out, f, indent=1)
    sizes = ', '.join(f"{k}:{len(v) // 2}" for k, v in out['config'].items())
    print(f"saved {path}\n  config blocks (id:bytes) {sizes}\n  static blocks {len(out['static'])}")

def cmd_stats(pad, a):
    if a.reset:
        pad.command(T_STATS_RESET)
        time.sleep(1.0)
    if not a.watch:
        print_stats(stats(pad))
        return
    try:
        while True:
            pad.command(T_STATS_RESET)
            time.sleep(1.0)
            s = stats(pad)
            print(f"\r{LATCH_MODES.get(s['mode'] & 0x7F, '?')[:28]:28s}  age avg {s['age_avg_us']:5d}  "
                  f"min {s['age_min_us']:5d}  max {s['age_max_us']:5d} us  late {s['misses']:3d}  "
                  f"n {s['count']:5d}", end='', flush=True)
    except KeyboardInterrupt:
        print()

def cmd_ab(pad, a):
    secs = a.seconds
    results = {}
    for label, on in (('stock timing', 0), ('late-latch', 1), ('stock timing', 0), ('late-latch', 1)):
        pad.command(T_LATCH, on)
        time.sleep(0.5)
        pad.command(T_STATS_RESET)
        time.sleep(secs)
        s = stats(pad)
        results.setdefault(label, []).append(s)
        print(f"{label:13s} avg {s['age_avg_us']:5d} us  min {s['age_min_us']:5d}  max {s['age_max_us']:5d}"
              f"  late {s['misses']:3d}  n {s['count']}  ({LATCH_MODES.get(s['mode'] & 0x7F, '?')})")
    pad.command(T_LATCH, 1)
    avg = {k: sum(x['age_avg_us'] for x in v) / len(v) for k, v in results.items()}
    if avg.get('stock timing') and avg.get('late-latch') is not None:
        print(f"\ninput age: {avg['stock timing']:.0f} us -> {avg['late-latch']:.0f} us "
              f"({avg['stock timing'] - avg['late-latch']:.0f} us less)")

def cmd_latch(pad, a):
    pad.command(T_LATCH, 1 if a.state == 'on' else 0)
    print(f"late-latch {a.state} (until unplugged)")

def cmd_map(pad, a):
    entries = read_map(pad)
    print(f"{'button':9s} {'GameCube/Slippi now':20s} {'(default)':10s} {'Switch now':11s} {'(default)':10s}")
    for e in entries:
        if e['gc_def'] < 0 and e['sw_def'] < 0 and e['gc_cur'] < 0 and e['sw_cur'] < 0:
            continue
        mark = '  *' if (e['gc_cur'] != e['gc_def'] or e['sw_cur'] != e['sw_def']) else ''
        print(f"{e['name']:9s} {code_name(GC_CODES, e['gc_cur']):20s} {code_name(GC_CODES, e['gc_def']):10s} "
              f"{code_name(SW_CODES, e['sw_cur']):11s} {code_name(SW_CODES, e['sw_def']):10s}{mark}")
    print("\n* = remapped")

def cmd_remap(pad, a):
    entries = read_map(pad)
    src, tgt = resolve(entries, a.src), resolve(entries, a.target)
    r = pad.command(T_ASSIGN, src['code'], tgt['code'])
    if not r[2]:
        sys.exit("The controller refused (only digital buttons can be remapped, not Power).")
    if src is tgt:
        print(f"{src['name']} is back to its default.")
    else:
        print(f"{src['name']} now does what {tgt['name']} does by default "
              f"(GameCube: {code_name(GC_CODES, tgt['gc_def'])}, Switch: {code_name(SW_CODES, tgt['sw_def'])}). Saved.")

def cmd_reset(pad, a):
    pad.command(T_RESET_ALL)
    print("Every button is back to default. Saved.")

def cmd_mode(pad, a):
    r = pad.command(T_USB_MODE, MODE_ARGS[a.mode])
    print(f"switching to {a.mode} (until unplugged)" if r[2] else "the controller refused (not on USB?)")

def main():
    p = argparse.ArgumentParser(description='Desktop companion for the GC Ultimate techchase firmware (HOJA fork).')
    sp = p.add_subparsers(dest='cmd', required=True)
    sp.add_parser('info').set_defaults(fn=cmd_info)
    b = sp.add_parser('backup'); b.add_argument('file', nargs='?'); b.set_defaults(fn=cmd_backup)
    s = sp.add_parser('stats'); s.add_argument('-w', '--watch', action='store_true')
    s.add_argument('-r', '--reset', action='store_true'); s.set_defaults(fn=cmd_stats)
    ab = sp.add_parser('ab'); ab.add_argument('seconds', nargs='?', type=float, default=5.0); ab.set_defaults(fn=cmd_ab)
    l = sp.add_parser('latch'); l.add_argument('state', choices=['on', 'off']); l.set_defaults(fn=cmd_latch)
    sp.add_parser('map').set_defaults(fn=cmd_map)
    r = sp.add_parser('remap'); r.add_argument('src'); r.add_argument('target'); r.set_defaults(fn=cmd_remap)
    sp.add_parser('reset').set_defaults(fn=cmd_reset)
    m = sp.add_parser('mode'); m.add_argument('mode', choices=sorted(MODE_ARGS)); m.set_defaults(fn=cmd_mode)
    a = p.parse_args()
    pad = Pad()
    try:
        a.fn(pad, a)
    except RuntimeError as e:
        sys.exit(str(e))
    finally:
        pad.close()

if __name__ == '__main__':
    main()
