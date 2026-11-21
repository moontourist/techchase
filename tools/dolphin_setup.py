import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

SI_NAMES = {0: 'Nothing', 6: 'Standard Controller', 12: 'GameCube Adapter for Wii U'}
SI_STANDARD = 6
SI_ADAPTER = 12
SI_DEFAULT = (SI_STANDARD, 0, 0, 0)
CONTROLLER_NAMES = re.compile(r'GCU|GC Ultimate|HOJA|SInput', re.I)

SINPUT_PROFILE = {
    'Buttons/A': '`Button 0`',
    'Buttons/B': '`Button 2`',
    'Buttons/X': '`Button 1`',
    'Buttons/Y': '`Button 3`',
    'Buttons/Z': '`Button 11`',
    'Buttons/Start': '`Button 16`',
    'Main Stick/Up': '`Axis Y-`',
    'Main Stick/Down': '`Axis Y+`',
    'Main Stick/Left': '`Axis X-`',
    'Main Stick/Right': '`Axis X+`',
    'C-Stick/Up': '`Axis Zr-`',
    'C-Stick/Down': '`Axis Zr+`',
    'C-Stick/Left': '`Axis Z-`',
    'C-Stick/Right': '`Axis Z+`',
    'Triggers/L': '`Button 12`',
    'Triggers/R': '`Button 13`',
    'Triggers/L-Analog': '`Axis Xr-+`',
    'Triggers/R-Analog': '`Axis Yr-+`',
    'D-Pad/Up': '`Button 4`',
    'D-Pad/Down': '`Button 5`',
    'D-Pad/Left': '`Button 6`',
    'D-Pad/Right': '`Button 7`',
}
SENDS = {v: k.split('/', 1)[1] for k, v in SINPUT_PROFILE.items() if k.startswith(('Buttons/', 'D-Pad/'))}
SENDS.update({'`Button 12`': 'L', '`Button 13`': 'R'})
for name in ('Up', 'Down', 'Left', 'Right'):
    SENDS[SINPUT_PROFILE[f'D-Pad/{name}']] = f'D-Pad {name}'


def default_installs():
    appdata = os.environ.get('APPDATA', '')
    home = os.path.expanduser('~')
    return [
        ('slippi', 'Slippi Dolphin (netplay)', os.path.join(appdata, 'Slippi Launcher', 'netplay', 'User')),
        ('dolphin', 'Dolphin', os.path.join(home, 'Documents', 'Dolphin Emulator')),
        ('dolphin-appdata', 'Dolphin', os.path.join(appdata, 'Dolphin Emulator')),
    ]


def installs_in(root):
    return [(name, name, os.path.join(root, name)) for name in sorted(os.listdir(root))
            if os.path.isdir(os.path.join(root, name))]


def read_ini(path):
    sections, current = {}, None
    if not os.path.exists(path):
        return sections
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\r\n')
            m = re.match(r'^\[(.+)\]\s*$', line)
            if m:
                current = sections.setdefault(m.group(1), {})
            elif current is not None and ' = ' in line:
                key, value = line.split(' = ', 1)
                current[key.strip()] = value
    return sections


def port_devices(user_dir):
    core = read_ini(os.path.join(user_dir, 'Config', 'Dolphin.ini')).get('Core', {})
    out = []
    for i in range(4):
        raw = core.get(f'SIDevice{i}')
        try:
            out.append(int(raw) if raw is not None else SI_DEFAULT[i])
        except ValueError:
            out.append(-1)
    return out


def check_profile(pad):
    device = pad.get('Device', '')
    if not CONTROLLER_NAMES.search(device):
        return {'reads': 'other', 'device': device, 'wrong': []}
    if not device.startswith('DInput/'):
        return {'reads': 'gcu', 'device': device, 'backend': device.split('/', 1)[0], 'checkable': False, 'wrong': []}
    wrong = []
    for key, want in SINPUT_PROFILE.items():
        has = pad.get(key, '')
        if has != want:
            wrong.append({'input': key, 'has': has.strip('`') or 'nothing', 'want': want.strip('`'),
                          'gets': SENDS.get(has)})
    return {'reads': 'gcu', 'device': device, 'backend': 'DInput', 'checkable': True, 'wrong': wrong}


def check(installs=None):
    found = []
    for ident, label, user_dir in installs or default_installs():
        if not os.path.exists(os.path.join(user_dir, 'Config', 'Dolphin.ini')):
            continue
        pads = read_ini(os.path.join(user_dir, 'Config', 'GCPadNew.ini'))
        ports = []
        for i, si in enumerate(port_devices(user_dir)):
            port = {'port': i + 1, 'si': si, 'name': SI_NAMES.get(si, f'other ({si})')}
            if si == SI_STANDARD:
                port['profile'] = check_profile(pads.get(f'GCPad{i + 1}', {}))
            ports.append(port)
        found.append({'id': ident, 'label': label, 'path': user_dir, 'ports': ports})
    return {'installs': found, 'dolphin_running': dolphin_running()}


def dolphin_running():
    if os.name != 'nt':
        return False
    out = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True, text=True).stdout.lower()
    return 'dolphin' in out


def write_profile(installs, ident, port, now=None):
    match = [i for i in (installs or default_installs()) if i[0] == ident]
    if not match:
        raise ValueError(f'no Dolphin install called {ident}')
    if not 1 <= port <= 4:
        raise ValueError('port must be 1 to 4')
    if dolphin_running():
        raise RuntimeError('Dolphin is open. Close it first: it rewrites this file when it closes.')
    path = os.path.join(match[0][2], 'Config', 'GCPadNew.ini')
    pad = read_ini(path).get(f'GCPad{port}', {})
    if check_profile(pad).get('checkable') is not True:
        raise ValueError(f'port {port} does not read the controller over DirectInput')
    stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(now))
    backup = f'{path}.techchase-{stamp}.bak'
    shutil.copy2(path, backup)

    with open(path, encoding='utf-8', errors='replace', newline='') as f:
        text = f.read()
    nl = '\r\n' if '\r\n' in text else '\n'
    lines = text.splitlines()
    section = f'[GCPad{port}]'
    start = lines.index(section) + 1
    end = next((j for j in range(start, len(lines)) if lines[j].startswith('[')), len(lines))
    body = lines[start:end]
    todo = dict(SINPUT_PROFILE)
    for j, line in enumerate(body):
        key = line.split(' = ', 1)[0].strip() if ' = ' in line else None
        if key in todo:
            body[j] = f'{key} = {todo.pop(key)}'
    body += [f'{key} = {value}' for key, value in todo.items()]
    lines[start:end] = body
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(nl.join(lines) + nl)
    return {'path': path, 'backup': backup}


def main():
    ap = argparse.ArgumentParser(description='Shows how each Dolphin port reads the GC Ultimate, and can rewrite a '
                                             "Standard Controller port's mapping to match the controller in SInput mode.")
    ap.add_argument('--fix', metavar='INSTALL:PORT', help='rewrite this port, for example slippi:1 (backs up first)')
    ap.add_argument('--root', help='check every Dolphin user folder in this folder instead of the usual places')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    installs = installs_in(a.root) if a.root else None
    if a.fix:
        ident, _, port = a.fix.rpartition(':')
        try:
            r = write_profile(installs, ident, int(port))
        except (ValueError, RuntimeError) as e:
            sys.exit(str(e))
        print(f"rewrote {r['path']}\nbackup  {r['backup']}")
        return
    r = check(installs)
    if a.json:
        print(json.dumps(r, indent=2))
        return
    if not r['installs']:
        print('No Dolphin settings found.')
    for inst in r['installs']:
        print(f"{inst['label']}  ({inst['path']})")
        for p in inst['ports']:
            line = f"  port {p['port']}: {p['name']}"
            prof = p.get('profile')
            if prof and prof['reads'] == 'gcu' and prof.get('checkable'):
                line += f", reads {prof['device']}: " + (f"{len(prof['wrong'])} inputs mapped wrong" if prof['wrong'] else 'mapping matches')
                for w in prof['wrong']:
                    line += f"\n      {w['input']} is {w['has']}" + (f" (the controller's {w['gets']})" if w['gets'] else '') + f", should be {w['want']}"
            elif prof and prof['reads'] == 'gcu':
                line += f", reads {prof['device']} through {prof['backend']} (not checked)"
            elif prof:
                line += f", reads {prof['device'] or 'nothing'}"
            print(line)


if __name__ == '__main__':
    main()
