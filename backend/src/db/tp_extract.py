"""Pull the content of a source tech pack PDF into plain data (header, callouts, print notes, spec table).
Used by build_techpacks.py to write modified, rebranded versions. Reads only; never writes the source."""
import subprocess, re, html

def _run(args):
    return subprocess.run(args, capture_output=True, text=True).stdout

def page_count(pdf):
    m = re.search(r'Pages:\s+(\d+)', _run(['pdfinfo', pdf]))
    return int(m.group(1)) if m else 0

def sheet_name(pdf, p):
    m = re.search(r'Sheet Name : ([^\n]+)', _run(['pdftotext', '-raw', '-f', str(p), '-l', str(p), pdf, '-']))
    return m.group(1).strip() if m else ''

LABELS = ['Style No.', 'Description', 'Category', 'Gender', 'Fabric Comp.', 'GSM', 'Size Range', 'Collection', 'Designer', 'Brand']

def header(pdf, p=1):
    t = _run(['pdftotext', '-layout', '-f', str(p), '-l', str(p), pdf, '-'])
    out = {}
    for line in t.split('\n'):
        for lab in LABELS:
            m = re.search(re.escape(lab) + r'\s{2,}(.+?)(?:\s{3,}|$)', line)
            if m and lab not in out: out[lab] = m.group(1).strip()
    return out

def blocks(pdf, p):
    """Text blocks with their position, as fractions of the page."""
    x = _run(['pdftotext', '-bbox-layout', '-f', str(p), '-l', str(p), pdf, '-'])
    pw = float(re.search(r'<page width="([\d.]+)"', x).group(1)); ph = float(re.search(r'height="([\d.]+)"', x).group(1))
    res = []
    for b in re.finditer(r'<block xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</block>', x, re.S):
        words = re.findall(r'<word[^>]*>(.*?)</word>', b.group(5), re.S)
        text = ' '.join(html.unescape(w) for w in words).strip()
        if text: res.append(dict(x=float(b.group(1)) / pw, y=float(b.group(2)) / ph, x2=float(b.group(3)) / pw, y2=float(b.group(4)) / ph, text=text))
    return res

JUNK = re.compile(r'^(FRONT|BACK|Page \d+|Sheet Name.*|Drop \|.*|Fabric Reference Image|Print Reference Image|To Scale|LOGO Dimensions.*|[A-Z]|\d+)$', re.I)
NOTE = re.compile(r'\b(change|todo|tbd|check with|confirm|\?)\b', re.I)

def callouts(pdf, p):
    """Annotation text on a page, below the header band and above the footer."""
    out = []
    for b in blocks(pdf, p):
        if b['y'] < 0.215 or b['y'] > 0.945: continue
        t = b['text']
        if JUNK.match(t) or NOTE.search(t) or len(t) < 4: continue
        out.append(dict(text=t, side='L' if (b['x'] + b['x2']) / 2 < 0.5 else 'R', y=b['y']))
    return sorted(out, key=lambda c: c['y'])

def spec(pdf, p):
    t = _run(['pdftotext', '-layout', '-f', str(p), '-l', str(p), pdf, '-'])
    lines = [l for l in t.split('\n') if l.strip()]
    sizes = None; rows = []
    for i, line in enumerate(lines):
        if 'Measurement point' in line or re.search(r'\bCode\b.*\bTol', line):
            sizes = re.findall(r'\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL|P|T|\d{1,2})\b', line.split('Tol')[-1]) or sizes
            continue
        m = re.match(r'^\s*([A-Z])\s{2,}(.*?)\s{2,}((?:±|\+/-|\+/−)?\s?[\d.]+)\s+((?:[\d.]+\s*)+)$', line.rstrip())
        if not m: m = re.match(r'^\s*([A-Z])\s+(.*?)\s+((?:±|\+/-)?\s?[\d.]+)\s+((?:[\d.]+\s+){2,}[\d.]+)\s*$', line.rstrip())
        if m:
            name = re.sub(r'\s+', ' ', m.group(2)).strip()
            # a long name wraps: its first half sits on the line above, with no code and no numbers
            if name and (name[0].islower() or name.startswith(')')) and i > 0:
                prev = lines[i - 1].strip()
                if prev and 'Measurement' not in prev and 'Sheet Name' not in prev and not re.search(r'[\d.]+\s+[\d.]+', prev):
                    name = prev + ' ' + name
            if name == 'armhole)': name = 'Chest (1 in below armhole)'
            if not name or re.match(r'^[±+\-/\d. ]+$', name): name = f'Measurement point {m.group(1)}'
            vals = [float(v) for v in m.group(4).split()]
            rows.append(dict(code=m.group(1), name=name[:1].upper() + name[1:] if name else 'Measurement', tol=m.group(3).replace('+/-', '±').replace(' ', ''), vals=vals))
    return dict(sizes=sizes or ['S', 'M', 'L', 'XL', 'XXL'], rows=rows)

def extract(pdf):
    n = page_count(pdf)
    d = dict(header=header(pdf, 1), pages=[])
    for p in range(1, n + 1):
        name = sheet_name(pdf, p)
        d['pages'].append(dict(n=p, name=name))
        if name.startswith('Construction'): d['construction'] = callouts(pdf, p)
        elif name.startswith('Finishing') or name.startswith('Detail'): d['finishing'] = callouts(pdf, p)
        elif name.endswith('CAD'): d.setdefault('print', []).extend(callouts(pdf, p))
        elif name.startswith('Spec Sheet') and 'spec' not in d: d['spec'] = spec(pdf, p)
    return d

if __name__ == '__main__':
    import sys, json
    print(json.dumps(extract(sys.argv[1]), indent=1)[:6000])
