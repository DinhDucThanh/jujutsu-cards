import re

src = open('src/web/card-icons.ts', encoding='utf8').read()
keys = ['jogo', 'mahito', 'hakari', 'todo', 'gojo', 'sukuna']
cells = []
for k in keys:
    m = re.search(r'\n  ' + k + r': `(.*?)`,', src, re.S)
    body = m.group(1)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="260" height="260">' + body + '</svg>'
    cells.append('<figure style="margin:0"><div style="background:#0b0b0f;border-radius:14px;padding:8px">' + svg + '</div><figcaption>' + k + '</figcaption></figure>')
page = ('<!doctype html><html><body style="margin:0;background:#111;color:#eee;font-family:sans-serif">'
        '<div style="display:flex;gap:16px;padding:16px;flex-wrap:wrap">' + ''.join(cells) + '</div></body></html>')
open('.scratch/icons-preview.html', 'w', encoding='utf8').write(page)
print('ok')
